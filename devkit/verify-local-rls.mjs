import { Client } from "pg";
import { listKnowledgeIntakeDocuments } from "../server/knowledge-intake-store.mjs";

const connectionString = String(process.env.HUAMEI_DATABASE_URL || process.env.DATABASE_URL || "").trim();
if (!connectionString) {
  throw new Error("缺少 HUAMEI_DATABASE_URL 或 DATABASE_URL；请通过 --env-file=.env.local 运行");
}

const client = new Client({ connectionString });
const emptyDepartmentScopeVisible = await listKnowledgeIntakeDocuments({
  tenant_id:"team_alpha",
  permitted_departments:[],
  q:"c027-ac2-synthetic",
  limit:10
});

try {
  await client.connect();
  const role = (await client.query(
    "SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user"
  )).rows[0];
  const tables = (await client.query(
    `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force_rls
       FROM pg_class
      WHERE relname = ANY($1::text[])
      ORDER BY relname`,
    [["knowledge_intake_state", "management_accounts", "audit_events"]]
  )).rows;

  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", ["team_beta"]);
    const hiddenAlphaKnowledge = (await client.query(
      "SELECT count(*)::int AS count FROM knowledge_intake_state WHERE tenant_id=$1",
      ["team_alpha"]
    )).rows[0].count;
    const visibleBetaAccounts = (await client.query(
      "SELECT count(*)::int AS count FROM management_accounts WHERE tenant_id=$1",
      ["team_beta"]
    )).rows[0].count;
    await client.query("ROLLBACK");

    const report = {
      role,
      tables,
      team_alpha_knowledge_visible_from_team_beta:hiddenAlphaKnowledge,
      team_beta_accounts_visible:visibleBetaAccounts,
      team_alpha_knowledge_visible_with_empty_department_scope:emptyDepartmentScopeVisible.length
    };
    console.log(JSON.stringify(report, null, 2));

    if (role?.rolsuper || role?.rolbypassrls) {
      throw new Error("RLS_RUNTIME_ROLE_REQUIRED：应用数据库连接不能使用超级用户或 BypassRLS 角色");
    }
    if (tables.length !== 3 || tables.some((table) => !table.rls || !table.force_rls)) {
      throw new Error("RLS_FORCE_POLICY_REQUIRED：目标租户表必须启用并强制 RLS");
    }
    if (hiddenAlphaKnowledge !== 0 || visibleBetaAccounts < 1 || emptyDepartmentScopeVisible.length !== 0) {
      throw new Error("RLS_TENANT_ISOLATION_FAILED：team_beta 上下文不应读取 team_alpha 状态");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
} finally {
  await client.end().catch(() => {});
}
