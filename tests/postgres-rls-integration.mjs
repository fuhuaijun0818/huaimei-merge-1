import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "");
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "");
if (!runtimeUrl || !migrationUrl) {
  throw new Error("RLS集成测试需要HUAMEI_DATABASE_URL(runtime)和HUAMEI_MIGRATION_DATABASE_URL(migrator)");
}

const suffix = randomUUID().slice(0, 8);
const tenantA = `rls-a-${suffix}`;
const tenantB = `rls-b-${suffix}`;
const unknownTenant = `rls-x-${suffix}`;
const { createPostgresClient } = await import("../server/platform/postgres.mjs");
const { ensureTenant } = await import("../server/persistence/postgres-helpers.mjs");
const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-rls-runtime-test" });
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-rls-migration-test" });

try {
  await migrator.query("SET ROLE huamei_owner");
  await migrator.query(
    `INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1),($2,$2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantA, tenantB]
  );

  const role = await runtime.query(
    `SELECT rolname, rolsuper, rolbypassrls
     FROM pg_roles WHERE rolname=current_user`
  );
  assert.equal(role.rows[0].rolname, "huamei_runtime");
  assert.equal(role.rows[0].rolsuper, false);
  assert.equal(role.rows[0].rolbypassrls, false);

  const forced = await runtime.query(
    `SELECT count(*)::int AS total
     FROM pg_class
     WHERE relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity`,
    [["tenants","conversation_sessions","leads","lead_candidates","handovers","knowledge_releases","audit_events","agent_runs","privacy_execution_actions","contact_suppressions","privacy_identity_verifications","privacy_completion_verifications","contact_vault_entries"]]
  );
  assert.equal(forced.rows[0].total, 13);

  const withoutContext = await runtime.query("SELECT tenant_id FROM tenants WHERE tenant_id = ANY($1::text[])", [[tenantA, tenantB]]);
  assert.equal(withoutContext.rowCount, 0, "未设置tenant上下文时不能读取任何租户行");

  const visibleA = await runtime.tenantQuery(
    tenantA,
    "SELECT tenant_id FROM tenants WHERE tenant_id = ANY($1::text[]) ORDER BY tenant_id",
    [[tenantA, tenantB]]
  );
  assert.deepEqual(visibleA.rows.map((row) => row.tenant_id), [tenantA]);
  const visibleB = await runtime.tenantQuery(
    tenantB,
    "SELECT tenant_id FROM tenants WHERE tenant_id = ANY($1::text[]) ORDER BY tenant_id",
    [[tenantA, tenantB]]
  );
  assert.deepEqual(visibleB.rows.map((row) => row.tenant_id), [tenantB]);

  await assert.rejects(
    () => runtime.tenantQuery(tenantA, "INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1)", [unknownTenant]),
    (error) => error?.code === "42501"
  );

  process.env.NODE_ENV = "production";
  await assert.rejects(
    () => runtime.tenantTransaction(unknownTenant, (client) => ensureTenant(client, unknownTenant)),
    (error) => error?.code === "TENANT_NOT_PROVISIONED"
  );

  console.log("✓ PostgreSQL运行账号最小权限、FORCE RLS、无上下文拒绝、跨租户隔离与生产禁自建租户通过");
} finally {
  try {
    await migrator.query("SET ROLE huamei_owner");
    await migrator.query("DELETE FROM tenants WHERE tenant_id = ANY($1::text[])", [[tenantA, tenantB, unknownTenant]]);
  } catch {}
  await Promise.allSettled([runtime.close(), migrator.close()]);
}
