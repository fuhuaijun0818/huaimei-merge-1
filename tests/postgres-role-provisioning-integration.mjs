import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bootstrapUrl = String(process.env.CI_PG_BOOTSTRAP_URL || process.env.HUAMEI_DATABASE_URL || "").trim();
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "").trim();
const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "").trim();
const migrationPassword = String(process.env.HUAMEI_POSTGRES_MIGRATION_PASSWORD || "");
const runtimePassword = String(process.env.HUAMEI_POSTGRES_APP_PASSWORD || "");
if (!bootstrapUrl || !migrationUrl || !runtimeUrl || migrationPassword.length < 24 || runtimePassword.length < 24) {
  throw new Error("角色归一化集成测试需要bootstrap/runtime/migrator URL及两组至少24字符的临时密码");
}

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const provisionScript = fileURLToPath(new URL("../scripts/provision-postgres-runtime-role.mjs", import.meta.url));
const { createPostgresClient } = await import("../server/platform/postgres.mjs");
const bootstrap = createPostgresClient({ connectionString:bootstrapUrl, applicationName:"huamei-role-normalization-bootstrap" });

const runProvision = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [provisionScript], {
    cwd:projectRoot,
    env:{
      ...process.env,
      HUAMEI_DATABASE_URL:bootstrapUrl,
      HUAMEI_POSTGRES_OWNER_ROLE:"huamei_owner",
      HUAMEI_POSTGRES_MIGRATION_USER:"huamei_migrator",
      HUAMEI_POSTGRES_APP_USER:"huamei_runtime",
      HUAMEI_POSTGRES_MIGRATION_PASSWORD:migrationPassword,
      HUAMEI_POSTGRES_APP_PASSWORD:runtimePassword
    },
    stdio:["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("close", (status) => resolve({ status, stdout, stderr }));
});

const membershipRows = () => bootstrap.query(
  `SELECT parent.rolname AS parent_role, member.rolname AS member_role,
          membership.admin_option, membership.inherit_option, membership.set_option
   FROM pg_auth_members membership
   JOIN pg_roles parent ON parent.oid=membership.roleid
   JOIN pg_roles member ON member.oid=membership.member
   WHERE parent.rolname = ANY($1::text[]) OR member.rolname = ANY($1::text[])
   ORDER BY parent.rolname,member.rolname`,
  [["huamei_owner", "huamei_migrator", "huamei_runtime"]]
);

try {
  await bootstrap.query(`
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='huamei_owner') THEN
        CREATE ROLE huamei_owner NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='huamei_migrator') THEN
        CREATE ROLE huamei_migrator NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='huamei_runtime') THEN
        CREATE ROLE huamei_runtime NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='huamei_unexpected_owner_member') THEN
        CREATE ROLE huamei_unexpected_owner_member NOLOGIN;
      END IF;
    END
    $roles$;
  `);
  await bootstrap.query("ALTER ROLE huamei_owner LOGIN SUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS CONNECTION LIMIT 7");
  await bootstrap.query("ALTER ROLE huamei_migrator LOGIN SUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS CONNECTION LIMIT 7");
  await bootstrap.query("ALTER ROLE huamei_runtime LOGIN SUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS CONNECTION LIMIT 7");
  await bootstrap.query("ALTER ROLE huamei_owner SET search_path='pg_catalog'");
  await bootstrap.query("ALTER ROLE huamei_runtime SET row_security=off");
  const databaseSettings = await bootstrap.query(
    `SELECT format('ALTER ROLE huamei_runtime IN DATABASE %I SET search_path=%L', current_database(), 'pg_catalog') AS sql,
            format('GRANT CONNECT,TEMPORARY,CREATE ON DATABASE %I TO PUBLIC,huamei_runtime,huamei_migrator', current_database()) AS grant_sql`
  );
  await bootstrap.query(databaseSettings.rows[0].sql);
  await bootstrap.query(databaseSettings.rows[0].grant_sql);
  await bootstrap.query("GRANT CREATE ON SCHEMA public TO PUBLIC,huamei_runtime,huamei_migrator");
  await bootstrap.query("GRANT huamei_owner,pg_read_all_data TO huamei_runtime WITH ADMIN OPTION");
  await bootstrap.query("GRANT pg_write_all_data TO huamei_migrator WITH ADMIN OPTION");
  await bootstrap.query("GRANT pg_monitor TO huamei_owner WITH ADMIN OPTION");
  await bootstrap.query("GRANT huamei_owner TO huamei_unexpected_owner_member WITH ADMIN OPTION");
  await bootstrap.query("CREATE TABLE public.huamei_acl_probe(id integer)");
  await bootstrap.query("CREATE SEQUENCE public.huamei_acl_probe_seq");
  await bootstrap.query("CREATE FUNCTION public.huamei_acl_probe_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
  await bootstrap.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.huamei_acl_probe TO PUBLIC,huamei_runtime,huamei_migrator"
  );
  await bootstrap.query(
    "GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.huamei_acl_probe_seq TO PUBLIC,huamei_runtime,huamei_migrator"
  );
  await bootstrap.query(
    "GRANT EXECUTE ON FUNCTION public.huamei_acl_probe_function() TO PUBLIC,huamei_runtime,huamei_migrator"
  );

  const bootstrapPool = await bootstrap.getPool();
  const competingSession = await bootstrapPool.connect();
  try {
    await competingSession.query("SELECT pg_advisory_lock(1213559661,1886546284)");
    const locked = await runProvision();
    assert.notEqual(locked.status, 0, "并发角色归一化必须失败关闭");
    assert.match(`${locked.stderr}\n${locked.stdout}`, /POSTGRES_ROLE_PROVISIONING_LOCKED/);
    const unchanged = await competingSession.query(
      `SELECT
         (SELECT rolsuper FROM pg_roles WHERE rolname='huamei_owner') AS owner_super,
         pg_has_role('huamei_runtime','pg_read_all_data','MEMBER') AS runtime_read_all_member,
         has_table_privilege('huamei_runtime','public.huamei_acl_probe','TRUNCATE') AS runtime_truncate`
    );
    assert.deepEqual(unchanged.rows[0], {
      owner_super:true,
      runtime_read_all_member:true,
      runtime_truncate:true
    }, "未获锁进程不得进行部分归一化");
  } finally {
    await competingSession.query("SELECT pg_advisory_unlock(1213559661,1886546284)");
    competingSession.release();
  }

  await bootstrap.query("SET ROLE huamei_runtime");
  await bootstrap.query("CREATE TABLE public.huamei_dirty_runtime_owned(id integer)");
  await bootstrap.query("RESET ROLE");

  const blocked = await runProvision();
  assert.notEqual(blocked.status, 0, "未知runtime-owned对象必须阻断自动归一化完成");
  assert.match(`${blocked.stderr}\n${blocked.stdout}`, /POSTGRES_ROLE_OWNERSHIP_REMEDIATION_REQUIRED/);

  const normalizedFlags = await bootstrap.query(
    `SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,
            rolreplication,rolbypassrls,rolconnlimit,rolconfig
     FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [["huamei_migrator", "huamei_owner", "huamei_runtime"]]
  );
  assert.deepEqual(normalizedFlags.rows.map((row) => row.rolname), ["huamei_migrator", "huamei_owner", "huamei_runtime"]);
  for (const row of normalizedFlags.rows) {
    assert.equal(row.rolsuper, false);
    assert.equal(row.rolcreatedb, false);
    assert.equal(row.rolcreaterole, false);
    assert.equal(row.rolinherit, false);
    assert.equal(row.rolreplication, false);
    assert.equal(row.rolconnlimit, -1);
    assert.equal(row.rolconfig, null);
  }
  assert.equal(normalizedFlags.rows.find((row) => row.rolname === "huamei_owner").rolcanlogin, false);
  assert.equal(normalizedFlags.rows.find((row) => row.rolname === "huamei_owner").rolbypassrls, true);
  for (const role of ["huamei_migrator", "huamei_runtime"]) {
    assert.equal(normalizedFlags.rows.find((row) => row.rolname === role).rolcanlogin, true);
    assert.equal(normalizedFlags.rows.find((row) => row.rolname === role).rolbypassrls, false);
  }
  assert.deepEqual((await membershipRows()).rows, [{
    parent_role:"huamei_owner",
    member_role:"huamei_migrator",
    admin_option:false,
    inherit_option:false,
    set_option:true
  }]);
  const databaseRoleSettings = await bootstrap.query(
    `SELECT count(*)::int AS setting_count
     FROM pg_db_role_setting setting
     JOIN pg_roles role ON role.oid=setting.setrole
     WHERE role.rolname = ANY($1::text[])`,
    [["huamei_owner", "huamei_migrator", "huamei_runtime"]]
  );
  assert.equal(databaseRoleSettings.rows[0].setting_count, 0);
  const privilegeBoundary = await bootstrap.query(
    `SELECT
       has_database_privilege('public',current_database(),'TEMP') AS public_temp,
       has_database_privilege('public',current_database(),'CREATE') AS public_create,
       has_database_privilege('huamei_runtime',current_database(),'TEMP') AS runtime_temp,
       has_database_privilege('huamei_runtime',current_database(),'CREATE') AS runtime_create,
       has_database_privilege('huamei_migrator',current_database(),'TEMP') AS migrator_temp,
       has_database_privilege('huamei_migrator',current_database(),'CREATE') AS migrator_create,
       has_schema_privilege('huamei_runtime','public','CREATE') AS runtime_schema_create,
       has_schema_privilege('huamei_migrator','public','CREATE') AS migrator_schema_create`
  );
  assert.deepEqual(privilegeBoundary.rows[0], {
    public_temp:false,
    public_create:false,
    runtime_temp:false,
    runtime_create:false,
    migrator_temp:false,
    migrator_create:false,
    runtime_schema_create:false,
    migrator_schema_create:false
  });
  const objectAclBoundary = await bootstrap.query(
    `SELECT
       has_table_privilege('huamei_runtime','public.huamei_acl_probe','SELECT') AS runtime_select,
       has_table_privilege('huamei_runtime','public.huamei_acl_probe','DELETE') AS runtime_delete,
       has_table_privilege('huamei_runtime','public.huamei_acl_probe','TRUNCATE') AS runtime_truncate,
       has_table_privilege('huamei_migrator','public.huamei_acl_probe','INSERT') AS migrator_insert,
       has_sequence_privilege('huamei_runtime','public.huamei_acl_probe_seq','USAGE') AS runtime_sequence_usage,
       has_sequence_privilege('huamei_runtime','public.huamei_acl_probe_seq','UPDATE') AS runtime_sequence_update,
       has_function_privilege('huamei_runtime','public.huamei_acl_probe_function()','EXECUTE') AS runtime_function_execute,
       (SELECT count(*)::int FROM pg_class object
         CROSS JOIN LATERAL aclexplode(coalesce(object.relacl,acldefault('r',object.relowner))) acl
         WHERE object.oid='public.huamei_acl_probe'::regclass AND acl.grantee=0) AS public_table_acl_count,
       (SELECT count(*)::int FROM pg_class object
         CROSS JOIN LATERAL aclexplode(coalesce(object.relacl,acldefault('S',object.relowner))) acl
         WHERE object.oid='public.huamei_acl_probe_seq'::regclass AND acl.grantee=0) AS public_sequence_acl_count`
  );
  assert.deepEqual(objectAclBoundary.rows[0], {
    runtime_select:false,
    runtime_delete:false,
    runtime_truncate:false,
    migrator_insert:false,
    runtime_sequence_usage:true,
    runtime_sequence_update:false,
    runtime_function_execute:false,
    public_table_acl_count:0,
    public_sequence_acl_count:0
  }, "归一化必须清除历史对象ACL，仅保留runtime序列USAGE/SELECT");

  // Simulate the explicit DBA-reviewed remediation of the exact unexpected
  // object.  The provisioning script deliberately does not choose this action.
  await bootstrap.query("ALTER TABLE public.huamei_dirty_runtime_owned OWNER TO huamei_owner");
  await bootstrap.query("DROP TABLE public.huamei_dirty_runtime_owned");
  const completed = await runProvision();
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);

  await bootstrap.query(
    "CREATE FUNCTION public.legacy_unapproved_security_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'"
  );
  await bootstrap.query(
    "GRANT EXECUTE ON FUNCTION public.legacy_unapproved_security_definer() TO PUBLIC,huamei_runtime"
  );
  const securityDefinerBlocked = await runProvision();
  assert.notEqual(securityDefinerBlocked.status, 0, "未审核SECURITY DEFINER必须阻断归一化完成");
  assert.match(`${securityDefinerBlocked.stderr}\n${securityDefinerBlocked.stdout}`, /POSTGRES_SECURITY_DEFINER_REMEDIATION_REQUIRED/);
  const tightenedUnapprovedFunction = await bootstrap.query(
    `SELECT
       has_function_privilege('huamei_runtime','public.legacy_unapproved_security_definer()','EXECUTE') AS runtime_execute,
       (SELECT count(*)::int
        FROM pg_proc routine
        CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
        WHERE routine.oid='public.legacy_unapproved_security_definer()'::regprocedure
          AND acl.grantee=0) AS public_acl_count`
  );
  assert.deepEqual(tightenedUnapprovedFunction.rows[0], { runtime_execute:false, public_acl_count:0 },
    "失败关闭前也必须先撤销未审核函数的执行权");
  await bootstrap.query("DROP FUNCTION public.legacy_unapproved_security_definer()");
  const completedAfterFunctionRemediation = await runProvision();
  assert.equal(completedAfterFunctionRemediation.status, 0,
    completedAfterFunctionRemediation.stderr || completedAfterFunctionRemediation.stdout);

  const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-role-normalization-runtime" });
  const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-role-normalization-migrator" });
  try {
    const runtimeIdentity = await runtime.query("SELECT current_user,session_user");
    assert.deepEqual(runtimeIdentity.rows[0], { current_user:"huamei_runtime", session_user:"huamei_runtime" },
      "runtime连接必须实际以huamei_runtime身份建立，不能被bootstrap连接串或环境变量覆盖");
    await assert.rejects(
      () => runtime.query("SET ROLE huamei_owner"),
      (error) => error?.code === "42501",
      "runtime必须无法SET ROLE到owner"
    );
    await assert.rejects(
      () => runtime.query("TRUNCATE TABLE public.huamei_acl_probe"),
      (error) => error?.code === "42501",
      "runtime的历史TRUNCATE直授必须被撤销"
    );
    await assert.rejects(
      () => migrator.query("INSERT INTO public.huamei_acl_probe(id) VALUES (1)"),
      (error) => error?.code === "42501",
      "migrator不得保留任何直授DML"
    );
    const migrationIdentity = await migrator.transaction(async (client) => {
      await client.query("SET LOCAL ROLE huamei_owner");
      return client.query("SELECT current_user,session_user");
    });
    assert.deepEqual(migrationIdentity.rows[0], { current_user:"huamei_owner", session_user:"huamei_migrator" });
  } finally {
    await Promise.allSettled([runtime.close(), migrator.close()]);
  }

  await bootstrap.query("DROP FUNCTION public.huamei_acl_probe_function()");
  await bootstrap.query("DROP SEQUENCE public.huamei_acl_probe_seq");
  await bootstrap.query("DROP TABLE public.huamei_acl_probe");
  await bootstrap.query("DROP ROLE huamei_unexpected_owner_member");
  console.log("✓ PostgreSQL脏角色、对象ACL/TRUNCATE、SECURITY DEFINER白名单与所有权失败关闭后可幂等归一通过");
} finally {
  await bootstrap.close();
}
