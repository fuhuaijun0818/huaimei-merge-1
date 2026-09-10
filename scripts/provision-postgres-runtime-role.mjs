import { getPostgresClient, closePostgresClient } from "../server/platform/postgres.mjs";
import {
  POSTGRES_APPROVED_SECURITY_DEFINER_FUNCTIONS,
  POSTGRES_RUNTIME_CALLABLE_FUNCTIONS,
  POSTGRES_RUNTIME_TABLE_GRANT_GROUPS
} from "../server/platform/postgres-object-acl-policy.mjs";

const ownerRole = String(process.env.HUAMEI_POSTGRES_OWNER_ROLE || "huamei_owner").trim();
const migrationRole = String(process.env.HUAMEI_POSTGRES_MIGRATION_USER || "huamei_migrator").trim();
const runtimeRole = String(process.env.HUAMEI_POSTGRES_APP_USER || "huamei_runtime").trim();
const migrationPassword = String(process.env.HUAMEI_POSTGRES_MIGRATION_PASSWORD || "");
const runtimePassword = String(process.env.HUAMEI_POSTGRES_APP_PASSWORD || "");
if (ownerRole !== "huamei_owner" || migrationRole !== "huamei_migrator" || runtimeRole !== "huamei_runtime") {
  throw new Error("PostgreSQL role names must match the audited huamei_owner/huamei_migrator/huamei_runtime model");
}
if (migrationPassword.length < 24 || runtimePassword.length < 24) {
  throw new Error("Migration and runtime PostgreSQL passwords must each contain at least 24 characters");
}

const database = getPostgresClient();
let session = null;
let provisioningLockHeld = false;
try {
  const pool = await database.getPool();
  session = await pool.connect();
  const lock = await session.query(
    "SELECT pg_try_advisory_lock(1213559661,1886546284) AS acquired"
  );
  if (lock.rows[0]?.acquired !== true) {
    const error = new Error("POSTGRES_ROLE_PROVISIONING_LOCKED: another role provisioning session is active");
    error.code = "POSTGRES_ROLE_PROVISIONING_LOCKED";
    throw error;
  }
  provisioningLockHeld = true;

  const roles = await session.query(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])`,
    [[ownerRole, migrationRole, runtimeRole]]
  );
  const existing = new Set(roles.rows.map((row) => row.rolname));
  if (!existing.has(ownerRole)) {
    await session.query("CREATE ROLE huamei_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS");
  }
  if (!existing.has(migrationRole)) {
    await session.query("CREATE ROLE huamei_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
  }
  if (!existing.has(runtimeRole)) {
    await session.query("CREATE ROLE huamei_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
  }

  // Existing roles are untrusted input.  Re-running provisioning must repair
  // role flags and role/database settings, not only rotate passwords.
  await session.query(
    "ALTER ROLE huamei_owner NOLOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS CONNECTION LIMIT -1"
  );
  const commands = await session.query(
    `SELECT
      format('ALTER ROLE %I LOGIN PASSWORD %L VALID UNTIL %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1', $1::text, $2::text, 'infinity') AS migration_sql,
      format('ALTER ROLE %I LOGIN PASSWORD %L VALID UNTIL %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1', $3::text, $4::text, 'infinity') AS runtime_sql`,
    [migrationRole, migrationPassword, runtimeRole, runtimePassword]
  );
  await session.query(commands.rows[0].migration_sql);
  await session.query(commands.rows[0].runtime_sql);

  for (const role of [ownerRole, migrationRole, runtimeRole]) {
    const reset = await session.query(
      `SELECT
        format('ALTER ROLE %I RESET ALL', $1::text) AS global_sql,
        format('ALTER ROLE %I IN DATABASE %I RESET ALL', $1::text, current_database()) AS database_sql`,
      [role]
    );
    await session.query(reset.rows[0].global_sql);
    await session.query(reset.rows[0].database_sql);
  }

  // Normalize the complete membership boundary.  runtime is a member of no
  // role; migrator is only a non-inheriting member of owner with SET ROLE;
  // owner has no parent and no member other than migrator.
  const memberships = await session.query(
    `SELECT format('REVOKE %I FROM %I CASCADE', parent.rolname, member.rolname) AS sql
     FROM pg_auth_members membership
     JOIN pg_roles parent ON parent.oid=membership.roleid
     JOIN pg_roles member ON member.oid=membership.member
     WHERE member.rolname = ANY($1::text[])
        OR parent.rolname = ANY($1::text[])`,
    [[ownerRole, migrationRole, runtimeRole]]
  );
  for (const membership of memberships.rows) await session.query(membership.sql);
  await session.query(
    "GRANT huamei_owner TO huamei_migrator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE"
  );

  const revokeDatabaseGrant = await session.query(
    `SELECT format(
      'REVOKE CONNECT, TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC, huamei_migrator, huamei_runtime',
      current_database()
    ) AS sql`
  );
  await session.query(revokeDatabaseGrant.rows[0].sql);
  await session.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC, huamei_migrator, huamei_runtime");
  const databaseGrant = await session.query(
    `SELECT format(
      'GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO huamei_owner; GRANT CONNECT ON DATABASE %I TO huamei_migrator, huamei_runtime',
      current_database(), current_database()
    ) AS sql`
  );
  await session.query(databaseGrant.rows[0].sql);
  await session.query("GRANT USAGE, CREATE ON SCHEMA public TO huamei_owner");
  await session.query("GRANT USAGE ON SCHEMA public TO huamei_runtime");

  // Normalize all direct application-object ACLs after treating the current
  // database as untrusted history.  Runtime receives only the audited table
  // matrix, sequences are read/used but never updated, migrator operates only
  // through SET ROLE owner, and PUBLIC receives no business-object access.
  await session.query(
    "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, huamei_migrator, huamei_runtime"
  );
  await session.query(
    "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, huamei_migrator, huamei_runtime"
  );
  for (const group of POSTGRES_RUNTIME_TABLE_GRANT_GROUPS) {
    const existingTables = await session.query(
      `SELECT string_agg(format('%I.%I',namespace.nspname,object.relname),', ' ORDER BY object.relname) AS identities
       FROM pg_class object
       JOIN pg_namespace namespace ON namespace.oid=object.relnamespace
       WHERE namespace.nspname='public'
         AND object.relkind IN ('r','p','v','m','f')
         AND object.relname = ANY($1::text[])`,
      [group.tables]
    );
    if (existingTables.rows[0]?.identities) {
      await session.query(
        `GRANT ${group.privileges.join(", ")} ON TABLE ${existingTables.rows[0].identities} TO huamei_runtime`
      );
    }
  }
  await session.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO huamei_runtime");

  for (const statement of [
    "ALTER DEFAULT PRIVILEGES FOR ROLE huamei_owner IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, huamei_migrator, huamei_runtime",
    "ALTER DEFAULT PRIVILEGES FOR ROLE huamei_owner IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, huamei_migrator, huamei_runtime",
    "ALTER DEFAULT PRIVILEGES FOR ROLE huamei_owner IN SCHEMA public REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC, huamei_migrator, huamei_runtime"
  ]) await session.query(statement);

  const applicationFunctions = await session.query(
    `SELECT format('%I.%I(%s)',namespace.nspname,routine.proname,
                   pg_catalog.oidvectortypes(routine.proargtypes)) AS identity
     FROM pg_proc routine
     JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
     WHERE namespace.nspname='public'
       AND (routine.prosecdef OR routine.proname LIKE 'huamei\\_%' ESCAPE '\\')
     ORDER BY routine.proname,routine.oid`
  );
  for (const functionRow of applicationFunctions.rows) {
    await session.query(
      `REVOKE ALL PRIVILEGES ON FUNCTION ${functionRow.identity} FROM PUBLIC, huamei_migrator, huamei_runtime`
    );
  }
  for (const signature of POSTGRES_RUNTIME_CALLABLE_FUNCTIONS) {
    const resolved = await session.query(
      `SELECT format('%I.%I(%s)',namespace.nspname,routine.proname,
                     pg_catalog.oidvectortypes(routine.proargtypes)) AS identity
       FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
       WHERE routine.oid=to_regprocedure($1)`,
      [signature]
    );
    if (resolved.rowCount) {
      await session.query(`GRANT EXECUTE ON FUNCTION ${resolved.rows[0].identity} TO huamei_runtime`);
    }
  }
  const unexpectedSecurityDefiners = await session.query(
    `SELECT format('%I.%I(%s)',namespace.nspname,routine.proname,
                   pg_catalog.oidvectortypes(routine.proargtypes)) AS identity
     FROM pg_proc routine
     JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
     WHERE namespace.nspname='public' AND routine.prosecdef
       AND NOT EXISTS (
         SELECT 1 FROM unnest($1::text[]) approved(signature)
         WHERE to_regprocedure(approved.signature)=routine.oid
       )
     ORDER BY identity`,
    [POSTGRES_APPROVED_SECURITY_DEFINER_FUNCTIONS]
  );
  if (unexpectedSecurityDefiners.rowCount) {
    const error = new Error("POSTGRES_SECURITY_DEFINER_REMEDIATION_REQUIRED: an unapproved SECURITY DEFINER function exists in public schema");
    error.code = "POSTGRES_SECURITY_DEFINER_REMEDIATION_REQUIRED";
    error.details = unexpectedSecurityDefiners.rows.map((row) => ({ function:row.identity }));
    throw error;
  }

  // Unknown objects owned by a login role need an explicit DBA decision.
  // Do not silently REASSIGN OWNED because that can hide an unexpected object
  // or move an object outside the Huamei application boundary.
  const unsafeOwnership = await session.query(
    `WITH login_roles AS (
       SELECT oid,rolname FROM pg_roles WHERE rolname = ANY($1::text[])
     ), findings AS (
       SELECT owner.rolname, 'database'::text AS object_type
       FROM pg_database object JOIN login_roles owner ON owner.oid=object.datdba
       WHERE object.datname=current_database()
       UNION ALL
       SELECT owner.rolname, 'schema'
       FROM pg_namespace object JOIN login_roles owner ON owner.oid=object.nspowner
       WHERE object.nspname !~ '^pg_' AND object.nspname <> 'information_schema'
       UNION ALL
       SELECT owner.rolname, CASE object.relkind
         WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index' WHEN 'v' THEN 'view'
         WHEN 'm' THEN 'materialized_view' WHEN 'f' THEN 'foreign_table'
         ELSE 'relation' END
       FROM pg_class object
       JOIN pg_namespace namespace ON namespace.oid=object.relnamespace
       JOIN login_roles owner ON owner.oid=object.relowner
       WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT owner.rolname, 'function'
       FROM pg_proc object
       JOIN pg_namespace namespace ON namespace.oid=object.pronamespace
       JOIN login_roles owner ON owner.oid=object.proowner
       WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT owner.rolname, 'type'
       FROM pg_type object
       JOIN pg_namespace namespace ON namespace.oid=object.typnamespace
       JOIN login_roles owner ON owner.oid=object.typowner
       WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
     )
     SELECT rolname,object_type,count(*)::int AS object_count
     FROM findings GROUP BY rolname,object_type ORDER BY rolname,object_type`,
    [[migrationRole, runtimeRole]]
  );
  if (unsafeOwnership.rows.length) {
    const error = new Error("POSTGRES_ROLE_OWNERSHIP_REMEDIATION_REQUIRED: runtime or migrator role owns database objects; DBA remediation is required before provisioning can complete");
    error.code = "POSTGRES_ROLE_OWNERSHIP_REMEDIATION_REQUIRED";
    error.details = unsafeOwnership.rows.map((row) => ({
      role:row.rolname,
      object_type:row.object_type,
      object_count:Number(row.object_count)
    }));
    throw error;
  }
  console.log(JSON.stringify({
    status:"ok",
    owner_role:ownerRole,
    migration_role:migrationRole,
    runtime_role:runtimeRole,
    privileges:"split_owner_migrator_runtime"
  }));
} finally {
  if (session && provisioningLockHeld) {
    try { await session.query("SELECT pg_advisory_unlock(1213559661,1886546284)"); } catch {}
  }
  session?.release?.();
  await closePostgresClient();
}
