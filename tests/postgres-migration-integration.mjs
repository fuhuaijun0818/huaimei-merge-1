import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  loadRuntimeObjectAclEvidence,
  validateRuntimeObjectAclEvidence
} from "../scripts/production-release-preflight.mjs";

const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "").trim();
const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "").trim();
if (!migrationUrl || !runtimeUrl) {
  throw new Error("迁移集成测试需要HUAMEI_MIGRATION_DATABASE_URL和HUAMEI_DATABASE_URL");
}

const requiredMigrations = [
  "001_initial_schema.sql",
  "002_production_governance.sql",
  "003_force_tenant_isolation.sql",
  "004_outbox_delivery.sql",
  "005_knowledge_release_workflow.sql",
  "006_conversation_idempotency.sql",
  "007_conversation_recovery.sql",
  "008_privacy_execution_controls.sql",
  "009_lead_candidate_isolation.sql",
  "010_privacy_identity_attestations.sql",
  "011_contact_vault.sql",
  "012_langgraph_turn_protocol.sql",
  "013_contact_manual_verification.sql",
  "014_appointment_registration.sql",
  "015_knowledge_intake_persistence.sql",
  "016_knowledge_publication_packages.sql",
  "017_management_accounts.sql"
];
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationsDirectory = join(projectRoot, "db", "migrations");
const expectedMigrations = (await readdir(migrationsDirectory))
  .filter((name) => /^\d{3}_.+\.sql$/.test(name))
  .sort((left, right) => left.localeCompare(right));
for (const name of requiredMigrations) {
  assert.ok(expectedMigrations.includes(name), `必需迁移缺失：${name}`);
}
const checksumFor = (content) => createHash("sha256").update(content).digest("hex");
const { createPostgresClient } = await import("../server/platform/postgres.mjs");
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-migration-contract-it" });
const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-runtime-contract-it" });

try {
  const identities = await migrator.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolinherit,
            rolreplication, rolbypassrls
     FROM pg_roles
     WHERE rolname = ANY($1::text[])
     ORDER BY rolname`,
    [["huamei_migrator", "huamei_owner", "huamei_runtime"]]
  );
  assert.deepEqual(identities.rows.map((row) => row.rolname), ["huamei_migrator", "huamei_owner", "huamei_runtime"]);
  for (const row of identities.rows) {
    assert.equal(row.rolsuper, false, `${row.rolname}不得是超级用户`);
    assert.equal(row.rolcreaterole, false, `${row.rolname}不得创建角色`);
    assert.equal(row.rolcreatedb, false, `${row.rolname}不得创建数据库`);
    assert.equal(row.rolinherit, false, `${row.rolname}不得隐式继承成员角色权限`);
    assert.equal(row.rolreplication, false, `${row.rolname}不得拥有复制权限`);
  }
  const ownerIdentity = identities.rows.find((row) => row.rolname === "huamei_owner");
  assert.equal(ownerIdentity.rolcanlogin, false, "owner必须是不可登录角色");
  assert.equal(ownerIdentity.rolbypassrls, true, "owner作为迁移对象所有者必须显式BYPASSRLS");
  for (const role of ["huamei_migrator", "huamei_runtime"]) {
    const identity = identities.rows.find((row) => row.rolname === role);
    assert.equal(identity.rolcanlogin, true, `${role}必须是受控登录角色`);
    assert.equal(identity.rolbypassrls, false, `${role}不得绕过RLS`);
  }

  const memberships = await migrator.query(
    `SELECT parent.rolname AS parent_role, member.rolname AS member_role,
            membership.admin_option, membership.inherit_option, membership.set_option
     FROM pg_auth_members membership
     JOIN pg_roles parent ON parent.oid=membership.roleid
     JOIN pg_roles member ON member.oid=membership.member
     WHERE parent.rolname = ANY($1::text[]) OR member.rolname = ANY($1::text[])
     ORDER BY parent.rolname,member.rolname`,
    [["huamei_owner", "huamei_migrator", "huamei_runtime"]]
  );
  assert.deepEqual(memberships.rows, [{
    parent_role:"huamei_owner",
    member_role:"huamei_migrator",
    admin_option:false,
    inherit_option:false,
    set_option:true
  }], "数据库角色拓扑必须只有owner授予migrator这一条受控SET ROLE边");

  const expectedChecksums = new Map(await Promise.all(expectedMigrations.map(async (name) => [
    name,
    checksumFor(await readFile(join(migrationsDirectory, name), "utf8"))
  ])));

  const evidence = await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    const currentIdentity = await client.query("SELECT current_user, session_user");
    const migrations = await client.query(
      "SELECT name, checksum FROM schema_migrations ORDER BY name"
    );
    const owners = await client.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public'
         AND c.relkind IN ('r','p')
         AND c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [["schema_migrations", "tenants", "conversation_sessions", "knowledge_releases", "outbox_events", "lead_candidates", "privacy_identity_verifications", "privacy_completion_verifications", "agent_turn_results", "agent_effect_ledger", "agent_turn_leases"]]
    );
    return { currentIdentity:currentIdentity.rows[0], migrations:migrations.rows, owners:owners.rows };
  });

  assert.deepEqual(evidence.currentIdentity, { current_user:"huamei_owner", session_user:"huamei_migrator" });
  assert.deepEqual(evidence.migrations.map((row) => row.name), expectedMigrations, "全新数据库必须应用仓库当前全部迁移，且至少包含001-014");
  for (const row of evidence.migrations) {
    assert.equal(row.checksum, expectedChecksums.get(row.name), `${row.name}已应用checksum必须与仓库一致`);
  }
  assert.equal(evidence.owners.length, 11);
  assert.ok(evidence.owners.every((row) => row.owner === "huamei_owner"), "迁移产物必须归huamei_owner而非登录角色所有");

  const runtimeIdentity = await runtime.query("SELECT current_user, session_user");
  assert.deepEqual(runtimeIdentity.rows[0], { current_user:"huamei_runtime", session_user:"huamei_runtime" });
  await assert.rejects(
    () => runtime.query("CREATE TABLE ci_runtime_must_not_create(id integer)"),
    (error) => error?.code === "42501"
  );
  await assert.rejects(
    () => runtime.query("SET ROLE huamei_owner"),
    (error) => error?.code === "42501",
    "runtime不得通过历史membership切换为owner"
  );
  const objectAclEvidence = await loadRuntimeObjectAclEvidence(runtime);
  const objectAclValidation = validateRuntimeObjectAclEvidence(objectAclEvidence);
  assert.equal(objectAclValidation.ok, true,
    `runtime/migrator/PUBLIC对象ACL必须与白名单完全一致：${objectAclValidation.failures.join(",")}`);

  console.log(`✓ PostgreSQL ${expectedMigrations.length}个迁移checksum、角色分离与对象ACL精确白名单通过`);
} finally {
  await Promise.allSettled([migrator.close(), runtime.close()]);
}
