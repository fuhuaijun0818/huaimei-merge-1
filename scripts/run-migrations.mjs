import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getPostgresClient, closePostgresClient } from "../server/platform/postgres.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationsRoot = join(projectRoot, "db", "migrations");
const advisoryLockId = 2_026_082_601;

const checksumFor = (content) => createHash("sha256").update(content).digest("hex");
const migrationBody = (content) => String(content)
  .replace(/^\s*BEGIN\s*;\s*/i, "")
  .replace(/\s*COMMIT\s*;\s*$/i, "")
  .trim();

const client = getPostgresClient();
const ownerRole = String(process.env.HUAMEI_POSTGRES_OWNER_ROLE || "huamei_owner").trim();
if (ownerRole !== "huamei_owner") throw new Error("HUAMEI_POSTGRES_OWNER_ROLE must be huamei_owner");

try {
  await client.query("SET ROLE huamei_owner");
  const names = (await readdir(migrationsRoot))
    .filter((name) => /^\d+.*\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (!names.length) throw new Error("No SQL migrations found");

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);

  const applied = [];
  const skipped = [];
  for (const name of names) {
    const raw = await readFile(join(migrationsRoot, name), "utf8");
    const checksum = checksumFor(raw);
    await client.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock($1)", [advisoryLockId]);
      const existing = await transaction.query(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [name]
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) {
          const error = new Error(`Migration checksum changed after apply: ${name}`);
          error.code = "MIGRATION_CHECKSUM_MISMATCH";
          throw error;
        }
        skipped.push(name);
        return;
      }
      const body = migrationBody(raw);
      if (!body) throw new Error(`Migration is empty: ${name}`);
      await transaction.query(body);
      await transaction.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [name, checksum]
      );
      applied.push(name);
    });
  }

  console.log(JSON.stringify({
    status:"ok",
    applied,
    skipped,
    total:applied.length + skipped.length
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status:"error",
    code:error.code || "MIGRATION_FAILED",
    message:error.message
  }, null, 2));
  process.exitCode = 1;
} finally {
  try { await client.query("RESET ROLE"); } catch {}
  await closePostgresClient();
}
