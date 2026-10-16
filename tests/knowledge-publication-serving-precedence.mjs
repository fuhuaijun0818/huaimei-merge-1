// C-013 AC4 的前台生效断言：发布包生效时，项目类问答必须以包内资料为准，
// 内置项目知识只在没有生效包时兜底。同时覆盖“回滚后换回另一版”。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";

if (process.env.HUAMEI_PERSISTENCE_BACKEND !== "postgres") {
  throw new Error("核验前台知识来源需要隔离 PostgreSQL（HUAMEI_PERSISTENCE_BACKEND=postgres）");
}
process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON = JSON.stringify({ active_key_id:"c013-ac4", keys:{ "c013-ac4":randomBytes(32).toString("base64") } });

const { getPostgresClient, closePostgresClient } = await import("../server/platform/postgres.mjs");
const kb = await import("../server/knowledge-intake-store.mjs");
const pub = await import("../server/knowledge-publication.mjs");
const { retrieveProjectKnowledge } = await import("../server/agent-runtime.mjs");
const { signEvidenceDocument } = await import("../scripts/formal-evidence-common.mjs");
const policy = await import("../scripts/production-evaluation-policy.mjs");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
process.env.HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64 = Buffer.from(JSON.stringify({
  "c013-ac4-issuer":{ authority_role:"formal_evidence_issuer", allowed_kinds:["evaluation_report"], public_key_spki_der_base64:publicKey.export({ format:"der", type:"spki" }).toString("base64") }
})).toString("base64");

const future = new Date(Date.now() + 86400000).toISOString();
const operator = (tenant, role) => ({ tenantId:tenant, subject:`${role}-c013ac4`, roles:[role], departmentIds:["demo"] });

const buildEvaluatedPackage = async (tenant, fixture, prefix) => {
  const scope = { tenant_id:tenant, actor:"内容专员", permitted_departments:["demo"] };
  const text = await readFile(new URL(`../devkit/fixtures/${fixture}`, import.meta.url), "utf8");
  const created = await kb.createKnowledgeIntakeDocument({ ...scope, idempotency_key:`${prefix}-create-0001`, source_filename:fixture, department:"demo", content_type:"项目介绍", owner:"C013 AC4", customer_facing_candidate:true, public_scope:"public_full", text_content:text, source_reference:"本地验收依据", applicable_campuses:["本地测试院区"], effective_at:new Date(Date.now() - 1000).toISOString(), expires_at:future, tags:["热玛吉","C013AC4"] });
  const target = { ...scope, document_id:created.document.id, expected_version:1 };
  await kb.recordKnowledgeIntakeConfirmation({ ...target, idempotency_key:`${prefix}-confirm-0001`, reference:`本地确认-${prefix}`, confirmed_by:"院方测试确认人", confirmed_at:new Date().toISOString(), confirmation_expires_at:future });
  await kb.submitKnowledgeIntakeDocument({ ...target, idempotency_key:`${prefix}-candidate-0001` });
  const pkg = await pub.createKnowledgePublication({ document_ids:[created.document.id], idempotency_key:`${prefix}-build-0001` }, operator(tenant, "发布与索引管理员"));
  const report = signEvidenceDocument({
    policy_version:policy.PRODUCTION_EVALUATION_POLICY_VERSION,
    package_checksum:pkg.checksum,
    text_index_version:pkg.text_index_version,
    graph_version:pkg.graph_version,
    expires_at:future,
    evaluation_families:Object.fromEntries(Object.keys(policy.REQUIRED_EVALUATION_FAMILIES).map((name) => [name, { dataset_id:`${name}-${prefix}`, evidence_ref:`${name}-${prefix}-local-only`, sample_count:2, deidentified:true, blind:true }])),
    production_metrics:Object.fromEntries(Object.entries(policy.PRODUCTION_METRIC_DEFINITIONS).map(([name, definition]) => [name, { value:definition.target, evidence_ref:`${name}-${prefix}-local-only` }]))
  }, { evidenceKind:"evaluation_report", signerId:"c013-ac4-issuer", privateKey });
  await pub.mutateKnowledgePublication(pkg.id, "evaluate", { report, idempotency_key:`${prefix}-evaluate-0001` }, operator(tenant, "质量与运营人员"));
  return { pkg, document:created.document };
};

const ask = async (ctx, tenant, message) => pub.publicationRequestContext.run(ctx, () => retrieveProjectKnowledge(message, { tenant_id:tenant, interests:[], known_projects:[] }, 3));

try {
  const tenant = "c013ac4-" + randomUUID().slice(0, 8);
  const action = { confirmed:true, reason:"C013 AC4 前台生效验收" };

  const first = await buildEvaluatedPackage(tenant, "c013-ac4-material-a.md", "c013ac4-a");
  const second = await buildEvaluatedPackage(tenant, "c013-ac4-material-b.md", "c013ac4-b");
  await pub.mutateKnowledgePublication(first.pkg.id, "activate", { ...action, expected_revision:0, idempotency_key:"c013ac4-activate-a-0001" }, operator(tenant, "发布与索引管理员"));
  await pub.mutateKnowledgePublication(second.pkg.id, "activate", { ...action, expected_revision:1, idempotency_key:"c013ac4-activate-b-0001" }, operator(tenant, "发布与索引管理员"));

  // 1. 当前启用乙：前台项目问答必须命中包内乙版资料，而不是内置 K-001/KB-P-002
  const activeB = await pub.loadActivePublication(tenant);
  assert.equal(activeB.package.id, second.pkg.id);
  const hitsB = await ask(activeB, tenant, "热玛吉一般原理");
  assert.ok(hitsB.length >= 1, "发布包生效时项目问答必须命中包内资料");
  const chunkOfB = activeB.package.text_index.chunks[0].record_id;
  assert.equal(hitsB[0].item.id, chunkOfB, "命中项必须是当前启用包的资料记录");
  assert.equal(hitsB[0].item.knowledge_id, chunkOfB, "引用编号必须指向包内记录");
  assert.match(hitsB[0].item.introduction, /C013AC4_MATERIAL_B/, "回答内容必须来自当前启用版本");
  assert.notEqual(hitsB[0].item.id, "KB-P-002");

  // 2. 不重启进程，回滚到甲后同一提问必须换成甲版资料
  await pub.mutateKnowledgePublication(first.pkg.id, "rollback", { ...action, expected_revision:2, idempotency_key:"c013ac4-rollback-a-0001" }, operator(tenant, "发布与索引管理员"));
  const activeA = await pub.loadActivePublication(tenant);
  assert.equal(activeA.package.id, first.pkg.id);
  const hitsA = await ask(activeA, tenant, "热玛吉一般原理");
  assert.ok(hitsA.length >= 1);
  assert.equal(hitsA[0].item.id, activeA.package.text_index.chunks[0].record_id, "回滚后命中项必须换成回滚目标版本");
  assert.match(hitsA[0].item.introduction, /C013AC4_MATERIAL_A/, "回滚后回答内容必须来自回滚目标版本");
  assert.notEqual(hitsA[0].item.id, hitsB[0].item.id, "回滚前后命中的必须是不同版本");

  // 3. 没有生效包时保留内置项目知识兜底，避免影响未启用发布包的租户
  const bareTenant = "c013ac4-" + randomUUID().slice(0, 8);
  const hitsFallback = await ask({ tenantId:bareTenant, revision:0, package:null }, bareTenant, "热玛吉一般原理");
  assert.ok(hitsFallback.length >= 1, "没有生效发布包时仍应使用内置项目知识");
  assert.notEqual(hitsFallback[0].item.published, true, "兜底项必须来自内置数据集");

  console.log("✓ 发布包生效时前台项目问答使用包内资料，回滚后切换版本；无生效包时保留内置兜底");
} finally {
  await closePostgresClient();
}
