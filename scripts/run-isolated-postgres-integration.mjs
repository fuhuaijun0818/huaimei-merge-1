import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import { createPostgresClient } from "../server/platform/postgres.mjs";

// This runner deliberately provisions a disposable database rather than using
// the developer's huamei database. It never drops an existing database or
// pre-existing managed role, so it is safe to use for a complete persistence
// regression without touching locally retained business records.
const bootstrapUrl = String(process.env.HUAMEI_DATABASE_URL || "").trim();
if (!bootstrapUrl) throw new Error("HUAMEI_DATABASE_URL is required to create an isolated PostgreSQL test database");

const baseUrl = new URL(bootstrapUrl);
const identifier = `huamei_it_${Date.now()}_${randomBytes(4).toString("hex")}`;
const migrationPassword = randomBytes(36).toString("base64url");
const runtimePassword = randomBytes(36).toString("base64url");
const managedRoles = ["huamei_owner", "huamei_migrator", "huamei_runtime"];
const disposableRoles = [...managedRoles, "huamei_unexpected_owner_member"];
let testDatabaseCreated = false;

const databaseUrl = ({ user, password, database }) => {
  const target = new URL(baseUrl.toString());
  target.username = user;
  target.password = password;
  target.pathname = `/${database}`;
  return target.toString();
};
const quoteIdentifier = (value) => `"${String(value).replaceAll("\"", "\"\"")}"`;
const run = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd:new URL("..", import.meta.url),
    env,
    stdio:"inherit"
  });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0) return resolve();
    const error = new Error(`Isolated PostgreSQL integration command failed: ${command} ${args.join(" ")}`);
    error.code = "ISOLATED_POSTGRES_INTEGRATION_FAILED";
    error.exit_code = code;
    error.signal = signal;
    reject(error);
  });
});

const bootstrap = createPostgresClient({
  connectionString:bootstrapUrl,
  applicationName:"huamei-isolated-postgres-bootstrap"
});

try {
  const availability = await bootstrap.query(
    `SELECT
       (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS current_user_is_superuser,
       (SELECT count(*)::int FROM pg_roles WHERE rolname = ANY($1::text[])) AS managed_role_count`,
    [managedRoles]
  );
  if (availability.rows[0]?.current_user_is_superuser !== true) {
    throw new Error("Isolated PostgreSQL integration requires a local bootstrap database superuser");
  }
  if (Number(availability.rows[0]?.managed_role_count || 0) !== 0) {
    throw new Error("Refusing isolated integration: managed Huamei roles already exist and may belong to another environment");
  }

  await bootstrap.query(`CREATE DATABASE ${quoteIdentifier(identifier)} TEMPLATE template0`);
  testDatabaseCreated = true;

  const bootstrapTestUrl = databaseUrl({
    user:decodeURIComponent(baseUrl.username),
    password:decodeURIComponent(baseUrl.password),
    database:identifier
  });
  const migratorUrl = databaseUrl({ user:"huamei_migrator", password:migrationPassword, database:identifier });
  const runtimeUrl = databaseUrl({ user:"huamei_runtime", password:runtimePassword, database:identifier });
  const integrationEnv = {
    ...process.env,
    CI_PG_BOOTSTRAP_URL:bootstrapTestUrl,
    // The role-normalization test uses CI_PG_BOOTSTRAP_URL only for setup;
    // its ordinary runtime connection must remain the least-privileged role.
    HUAMEI_DATABASE_URL:runtimeUrl,
    HUAMEI_MIGRATION_DATABASE_URL:migratorUrl,
    HUAMEI_POSTGRES_MIGRATION_USER:"huamei_migrator",
    HUAMEI_POSTGRES_MIGRATION_PASSWORD:migrationPassword,
    HUAMEI_POSTGRES_APP_USER:"huamei_runtime",
    HUAMEI_POSTGRES_APP_PASSWORD:runtimePassword
  };

  await run(process.execPath, ["tests/postgres-role-provisioning-integration.mjs"], integrationEnv);
  await run(process.execPath, ["scripts/run-migrations.mjs"], {
    ...integrationEnv,
    HUAMEI_DATABASE_URL:migratorUrl
  });
  // SQL migrations can create new functions whose PostgreSQL defaults include
  // PUBLIC EXECUTE. Run the same idempotent normalizer again after migration
  // so the newly created objects receive the audited ACL matrix as well.
  await run(process.execPath, ["scripts/provision-postgres-runtime-role.mjs"], {
    ...integrationEnv,
    HUAMEI_DATABASE_URL:bootstrapTestUrl
  });
  const focused = process.argv.includes("--three-modules");
  const verificationEnvironment = {
    ...integrationEnv,
    HUAMEI_DATABASE_URL:runtimeUrl
  };
  if(focused){
    for(const test of ["postgres-migration-integration", "postgres-five-role-publication-integration", "postgres-five-role-http-integration"])
      await run(process.execPath,[`tests/${test}.mjs`],verificationEnvironment);
  }else await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "test:postgres:ci"],verificationEnvironment);

  console.log(JSON.stringify({
    status:"passed",
    suite:"isolated-postgres-integration",
    database:"ephemeral",
    roles:"ephemeral",
    tests:["role-provisioning", "migrations", focused ? "five-role-publication-http" : "postgres-ci"]
  }));
} finally {
  try {
    if (testDatabaseCreated) {
      await bootstrap.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(identifier)} WITH (FORCE)`);
    }
    // Roles are globally scoped in PostgreSQL. They can be removed only after
    // this runner has verified that none existed before creating its isolated
    // database; otherwise a failed safety precheck must leave another
    // environment's roles entirely untouched.
    if (testDatabaseCreated) {
      await bootstrap.query("REVOKE huamei_owner FROM huamei_migrator");
      for (const role of [...disposableRoles].reverse()) {
        await bootstrap.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
      }
    }
  } finally {
    await bootstrap.close();
  }
}
