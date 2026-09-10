import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPostgresClient } from "../server/platform/postgres.mjs";
import {
  RESTORE_CRITICAL_TABLES,
  loadBackupManifestForRestore,
  validateRestoredSnapshotAgainstManifest
} from "./backup-manifest-common.mjs";
import { mainModule } from "./formal-evidence-common.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultMigrationsRoot = join(projectRoot, "db", "migrations");
const checksum = (value) => createHash("sha256").update(value).digest("hex");

const loadMigrationInventory = async (root) => {
  const migrationNames = (await readdir(root))
    .filter((name) => /^\d+.*\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "en"));
  const inventory = [];
  for (const name of migrationNames) inventory.push({ name, checksum:checksum(await readFile(join(root, name), "utf8")) });
  return inventory;
};

export async function runRestoreVerification(options = {}) {
  const env = options.env || process.env;
  const connectionString = String(env.HUAMEI_RESTORE_DATABASE_URL || "").trim();
  const expectedDatabase = String(env.HUAMEI_RESTORE_EXPECTED_DATABASE || "").trim();
  const isolatedConfirmed = String(env.HUAMEI_RESTORE_DRILL_CONFIRM_ISOLATED || "").trim().toLowerCase() === "true";
  if (!options.database && !connectionString) {
    const error = new Error("HUAMEI_RESTORE_DATABASE_URL is required");
    error.code = "RESTORE_DATABASE_URL_REQUIRED";
    throw error;
  }
  if (!isolatedConfirmed || !expectedDatabase) {
    const error = new Error("Restore verification is read-only but must target an explicitly confirmed isolated database");
    error.code = "RESTORE_ISOLATION_CONFIRMATION_REQUIRED";
    throw error;
  }

  // Refuse to query the restored database until the external backup identity,
  // signature and approved RPO have all been proven.
  const backupEvidence = await loadBackupManifestForRestore(env, {
    readFileImpl:options.readFileImpl,
    artifactReadFileImpl:options.artifactReadFileImpl,
    openFileImpl:options.openFileImpl
  });
  const database = options.database || createPostgresClient({
    connectionString,
    applicationName:"huamei-restore-verifier",
    statementTimeoutMs:120_000,
    queryTimeoutMs:130_000,
    lockTimeoutMs:5_000,
    idleInTransactionTimeoutMs:30_000
  });
  const ownedDatabase = !options.database;
  const failures = [];
  const check = (condition, code, details = {}) => {
    if (!condition) failures.push({ code, ...details });
  };

  try {
    const report = await database.transaction(async (client) => {
      const identity = await client.query("SELECT current_database() AS database_name,current_user,session_user");
      const databaseName = identity.rows[0].database_name;
      check(databaseName === expectedDatabase, "RESTORE_DATABASE_NAME_MISMATCH", { expected:expectedDatabase, actual:databaseName });
      check(identity.rows[0].session_user === "huamei_migrator", "RESTORE_MIGRATOR_ROLE_REQUIRED", { actual:identity.rows[0].session_user });
      await client.query("SET LOCAL ROLE huamei_owner");

      const expectedInventory = options.migrationInventory || await loadMigrationInventory(options.migrationsRoot || defaultMigrationsRoot);
      const expectedMigrations = new Map(expectedInventory.map((item) => [item.name, item.checksum]));
      const applied = await client.query("SELECT name,checksum FROM schema_migrations ORDER BY name");
      const appliedMigrations = new Map(applied.rows.map((row) => [row.name, row.checksum]));
      for (const [name, expectedChecksum] of expectedMigrations) {
        check(appliedMigrations.get(name) === expectedChecksum, "RESTORE_MIGRATION_MISSING_OR_CHANGED", { migration:name });
      }
      for (const name of appliedMigrations.keys()) {
        check(expectedMigrations.has(name), "RESTORE_UNKNOWN_MIGRATION", { migration:name });
      }

      const tables = await client.query(
        `SELECT relname,relrowsecurity,relforcerowsecurity
         FROM pg_class
         WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname=ANY($1::text[])`,
        [RESTORE_CRITICAL_TABLES]
      );
      const tableMap = new Map(tables.rows.map((row) => [row.relname, row]));
      for (const table of RESTORE_CRITICAL_TABLES) {
        const definition = tableMap.get(table);
        check(Boolean(definition), "RESTORE_REQUIRED_TABLE_MISSING", { table });
        check(Boolean(definition?.relrowsecurity && definition?.relforcerowsecurity), "RESTORE_FORCE_RLS_MISSING", { table });
      }

      const auditTrigger = await client.query(
        `SELECT count(*)::int AS total
         FROM pg_trigger
         WHERE tgrelid='audit_events'::regclass AND NOT tgisinternal
           AND tgname IN ('audit_events_append_only','audit_events_no_truncate')`
      );
      check(auditTrigger.rows[0].total === 2, "RESTORE_AUDIT_IMMUTABILITY_TRIGGER_MISSING", { actual:auditTrigger.rows[0].total });

      const integrity = await client.query(
        `SELECT
          (SELECT count(*)::int FROM conversation_messages m
           LEFT JOIN conversation_sessions s ON s.tenant_id=m.tenant_id AND s.id=m.session_record_id
           WHERE s.id IS NULL) AS orphan_messages,
          (SELECT count(*)::int FROM consents c
           LEFT JOIN leads l ON l.tenant_id=c.tenant_id AND l.id=c.lead_record_id
           WHERE l.id IS NULL) AS orphan_consents,
          (SELECT count(*)::int FROM handovers h
           LEFT JOIN conversation_sessions s ON s.tenant_id=h.tenant_id AND s.id=h.session_record_id
           WHERE s.id IS NULL) AS orphan_handovers,
          (SELECT count(*)::int FROM knowledge_reviews v
           LEFT JOIN knowledge_releases r ON r.tenant_id=v.tenant_id AND r.id=v.release_record_id
           WHERE r.id IS NULL) AS orphan_reviews,
          (SELECT count(*)::int FROM knowledge_releases
           WHERE is_active AND (
             status<>'active' OR package_checksum IS NULL OR record_list_checksum IS NULL
             OR index_checksum IS NULL OR effective_at IS NULL
           )) AS invalid_active_releases`
      );
      for (const [name, value] of Object.entries(integrity.rows[0])) {
        check(Number(value) === 0, "RESTORE_REFERENTIAL_INTEGRITY_FAILED", { check:name, count:Number(value) });
      }

      const countProjection = RESTORE_CRITICAL_TABLES
        .map((table) => `(SELECT count(*)::bigint FROM ${table}) AS ${table}`)
        .join(",\n");
      const counts = await client.query(`SELECT ${countProjection}`);
      const activeKnowledge = await client.query(
        `SELECT tenant_id,release_id,index_version,package_checksum,record_list_checksum,index_checksum
         FROM knowledge_releases
         WHERE is_active
         ORDER BY tenant_id,release_id,index_version`
      );
      const expectedAnchors = backupEvidence.manifest.audit_anchors;
      const auditAnchors = await client.query(
        `SELECT a.tenant_id,a.event_id,a.occurred_at
         FROM audit_events a
         JOIN unnest($1::varchar[],$2::varchar[]) AS expected(tenant_id,event_id)
           ON expected.tenant_id=a.tenant_id AND expected.event_id=a.event_id
         ORDER BY a.tenant_id,a.event_id`,
        [expectedAnchors.map((item) => item.tenant_id), expectedAnchors.map((item) => item.event_id)]
      );
      return {
        database_name:databaseName,
        session_role:identity.rows[0].session_user,
        migrations:{ expected:expectedMigrations.size, applied:appliedMigrations.size },
        counts:Object.fromEntries(Object.entries(counts.rows[0]).map(([key, value]) => [key, Number(value)])),
        active_knowledge_releases:activeKnowledge.rows,
        audit_anchors:auditAnchors.rows,
        integrity:integrity.rows[0]
      };
    });

    const manifestValidation = validateRestoredSnapshotAgainstManifest(backupEvidence.manifest, report);
    failures.push(...manifestValidation.failures);
    const evidence = {
      schema_version:"huamei.restore-verification.v2",
      status:failures.length ? "failed" : "passed",
      checked_at:(options.now || new Date()).toISOString(),
      backup_manifest:{
        backup_id:backupEvidence.manifest.backup_id,
        restore_point:backupEvidence.manifest.restore_point,
        file_sha256:backupEvidence.file.sha256,
        artifact_verification:{
          mode:backupEvidence.artifact.mode,
          sha256:backupEvidence.artifact.sha256,
          size_bytes:backupEvidence.artifact.size_bytes,
          ...(backupEvidence.artifact.object_version_id ? { object_version_id:backupEvidence.artifact.object_version_id } : {}),
          ...(backupEvidence.artifact.attestation_file_sha256
            ? { attestation_file_sha256:backupEvidence.artifact.attestation_file_sha256 }
            : {}),
          ...(backupEvidence.artifact.signer ? {
            signer_id:backupEvidence.artifact.signer.signer_id,
            signer_public_key_spki_sha256:backupEvidence.artifact.signer.public_key_spki_sha256
          } : {})
        },
        signer_id:backupEvidence.verification.signer.signer_id,
        signer_public_key_spki_sha256:backupEvidence.verification.signer.public_key_spki_sha256,
        rpo_seconds:backupEvidence.rpo_seconds,
        maximum_rpo_seconds:backupEvidence.maximum_rpo_seconds
      },
      report,
      failures
    };
    evidence.evidence_sha256 = checksum(JSON.stringify(evidence));
    return evidence;
  } finally {
    if (ownedDatabase) await database.close();
  }
}

if (mainModule(import.meta.url)) {
  try {
    const evidence = await runRestoreVerification();
    console.log(JSON.stringify(evidence, null, 2));
    if (evidence.status !== "passed") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      schema_version:"huamei.restore-verification.v2",
      status:"blocked",
      code:error.code || "RESTORE_VERIFICATION_FAILED",
      details:error.details || null
    }));
    process.exitCode = 1;
  }
}
