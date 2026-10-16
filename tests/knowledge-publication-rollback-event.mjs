// C-013 AC3：回滚必须产生独立事件，并记录原版、目标版、操作者与时间。
import assert from "node:assert/strict";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";

if (process.env.HUAMEI_PERSISTENCE_BACKEND !== "postgres") {
  throw new Error("核验回滚事件需要隔离 PostgreSQL（HUAMEI_PERSISTENCE_BACKEND=postgres）");
}
process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON = JSON.stringify({ active_key_id:"c013-ac3", keys:{ "c013-ac3":randomBytes(32).toString("base64") } });

const { getPostgresClient, closePostgresClient } = await import("../server/platform/postgres.mjs");
const kb = await import("../server/knowledge-intake-store.mjs");
const pub = await import("../server/knowledge-publication.mjs");
const { signEvidenceDocument } = await import("../scripts/formal-evidence-common.mjs");
const policy = await import("../scripts/production-evaluation-policy.mjs");

const tenant = "c013ac3-" + randomUUID().slice(0, 8);
const operator = (role) => ({ tenantId:tenant, subject:`${role}-c013ac3`, roles:[role], departmentIds:["demo"] });
const publisher = operator("发布与索引管理员");
const quality = operator("质量与运营人员");
const scope = { tenant_id:tenant, actor:"内容专员", permitted_departments:["demo"] };
const now = Date.now();
const future = new Date(now + 86400000).toISOString();

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
process.env.HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64 = Buffer.from(JSON.stringify({
  "c013-ac3-issuer":{ authority_role:"formal_evidence_issuer", allowed_kinds:["evaluation_report"], public_key_spki_der_base64:publicKey.export({ format:"der", type:"spki" }).toString("base64") }
})).toString("base64");

const reportFor = (pkg) => signEvidenceDocument({
  policy_version:policy.PRODUCTION_EVALUATION_POLICY_VERSION,
  package_checksum:pkg.checksum,
  text_index_version:pkg.text_index_version,
  graph_version:pkg.graph_version,
  expires_at:future,
  evaluation_families:Object.fromEntries(Object.keys(policy.REQUIRED_EVALUATION_FAMILIES).map((name) => [name, { dataset_id:`${name}-c013ac3`, evidence_ref:`${name}-c013ac3-local-only`, sample_count:2, deidentified:true, blind:true }])),
  production_metrics:Object.fromEntries(Object.entries(policy.PRODUCTION_METRIC_DEFINITIONS).map(([name, definition]) => [name, { value:definition.target, evidence_ref:`${name}-c013ac3-local-only` }]))
}, { evidenceKind:"evaluation_report", signerId:"c013-ac3-issuer", privateKey });

const createCandidate = async (label, prefix) => {
  const created = await kb.createKnowledgeIntakeDocument({ ...scope, idempotency_key:`${prefix}-create-0001`, source_filename:`${label}.md`, department:"demo", content_type:"服务流程", owner:"C013 AC3", customer_facing_candidate:true, public_scope:"public_full", text_content:`${label}：仅用于本地隔离环境的回滚事件验收，不含客户信息与真实结论。`, source_reference:"本地验收依据", applicable_campuses:["本地测试院区"], effective_at:new Date(Date.now() - 1000).toISOString(), expires_at:future, tags:["C013"] });
  const target = { ...scope, document_id:created.document.id, expected_version:1 };
  await kb.recordKnowledgeIntakeConfirmation({ ...target, idempotency_key:`${prefix}-confirm-0001`, reference:`本地确认-${label}`, confirmed_by:"院方测试确认人", confirmed_at:new Date().toISOString(), confirmation_expires_at:future });
  await kb.submitKnowledgeIntakeDocument({ ...target, idempotency_key:`${prefix}-candidate-0001` });
  return created.document;
};

const buildEvaluated = async (document, prefix) => {
  const pkg = await pub.createKnowledgePublication({ document_ids:[document.id], idempotency_key:`${prefix}-build-0001` }, publisher);
  await pub.mutateKnowledgePublication(pkg.id, "evaluate", { report:reportFor(pkg), idempotency_key:`${prefix}-evaluate-0001` }, quality);
  return pkg;
};

const action = { confirmed:true, reason:"C013 AC3 回滚事件验收" };

try {
  const first = await buildEvaluated(await createCandidate("C013AC3_回滚目标_A", "c013ac3-a"), "c013ac3-a");
  const second = await buildEvaluated(await createCandidate("C013AC3_当前版本_B", "c013ac3-b"), "c013ac3-b");

  await pub.mutateKnowledgePublication(first.id, "activate", { ...action, expected_revision:0, idempotency_key:"c013ac3-activate-first-0001" }, publisher);
  await pub.mutateKnowledgePublication(second.id, "activate", { ...action, expected_revision:1, idempotency_key:"c013ac3-activate-second-0001" }, publisher);
  await pub.mutateKnowledgePublication(first.id, "rollback", { ...action, expected_revision:2, idempotency_key:"c013ac3-rollback-first-0001" }, publisher);

  const rows = (await getPostgresClient().tenantQuery(tenant, "SELECT package_id,kind,payload,created_at FROM knowledge_publication_events ORDER BY created_at")).rows;
  const rollback = rows.filter((row) => row.kind === "rollback");
  assert.equal(rollback.length, 1, "回滚必须产生且只产生一条独立事件");
  const [event] = rollback;

  // 目标版与操作者、时间
  assert.equal(event.package_id, first.id, "回滚事件必须绑定目标版本");
  assert.equal(event.payload.actor, publisher.subject, "回滚事件必须记录操作者");
  assert.equal(event.payload.reason, action.reason, "回滚事件必须记录操作原因");
  assert.ok(event.created_at instanceof Date, "回滚事件必须记录时间");
  assert.equal(event.payload.result?.id, first.id);

  // 原版：本次改动的核心
  assert.equal(event.payload.from_package_id, second.id, "回滚事件必须记录原版（被替换的启用包）");
  assert.equal(event.payload.from_revision, 2, "回滚事件必须记录操作前的 head revision");
  assert.equal(event.payload.result?.head_revision, 3, "回滚后 head revision 必须前进");

  // 激活事件同样记录原版，首个激活的原版为空
  const activationOfSecond = rows.find((row) => row.kind === "activate" && row.package_id === second.id);
  const activationOfFirst = rows.find((row) => row.kind === "activate" && row.package_id === first.id);
  assert.equal(activationOfSecond.payload.from_package_id, first.id, "第二次激活必须记录当时的启用包");
  assert.equal(activationOfFirst.payload.from_package_id, null, "首个激活没有原版包");
  assert.equal(activationOfFirst.payload.from_revision, 0);

  // 审计行必须同样带上原版，便于按操作追溯
  const audit = (await getPostgresClient().tenantQuery(tenant, "SELECT details FROM audit_events WHERE action='knowledge.package.rollback'")).rows;
  assert.equal(audit.length, 1, "回滚必须写入一条审计记录");
  assert.equal(audit[0].details.from_package_id, second.id, "审计记录必须带上原版包");
  assert.equal(audit[0].details.from_revision, 2);
  assert.equal(audit[0].details.head_revision, 3);

  console.log("✓ 回滚事件独立留痕，并记录原版/目标版/操作者/时间（审计同步）");
} finally {
  await closePostgresClient();
}
