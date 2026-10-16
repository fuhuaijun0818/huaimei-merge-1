import { Client } from "pg";

const [tenantId = "team_alpha", action = "management.customer.read"] = process.argv.slice(2);
const connectionString = String(process.env.HUAMEI_DATABASE_URL || process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error("缺少 HUAMEI_DATABASE_URL 或 DATABASE_URL；请通过 --env-file=.env.local 运行");
}

const client = new Client({ connectionString });

try {
  await client.connect();
  const { rows } = await client.query({
    text: `SELECT tenant_id, actor_id, action, resource_type, request_id, outcome, occurred_at
             FROM audit_events
             WHERE tenant_id = $1 AND action = $2
             ORDER BY occurred_at DESC
             LIMIT 3`,
    values: [tenantId, action]
  });
  console.table(rows);
} finally {
  await client.end().catch(() => {});
}
