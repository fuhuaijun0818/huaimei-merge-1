import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.HUAMEI_KNOWLEDGE_INTAKE_STORE_FILE = ":memory:";
process.env.HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE = ":memory:";
const assetRoot = await mkdtemp(join(tmpdir(), "huamei-knowledge-intake-"));
process.env.HUAMEI_KNOWLEDGE_INTAKE_ASSET_ROOT = assetRoot;
const {
  completeKnowledgeIntakeAsset,
  createKnowledgeIntakeDocument,
  listKnowledgeIntakeDocuments,
  prepareKnowledgeIntakeAsset,
  saveKnowledgeIntakeAssetContent,
  submitKnowledgeIntakeDocument
} = await import(`../server/knowledge-intake-store.mjs?test=${Date.now()}`);
const { resetRuntimeKnowledgeIndexForTest, searchRuntimeKnowledge } = await import("../server/runtime-knowledge-index.mjs");
const { retrieveHuameiKnowledge } = await import("../server/huamei-knowledge.mjs");
resetRuntimeKnowledgeIndexForTest();

const tenantId = "huamei-shanghai";
const common = {
  tenant_id:tenantId,
  actor:"dept-owner-a",
  permitted_departments:["整形外科"],
  department:"整形外科",
  content_type:"项目介绍",
  owner:"整形外科内容负责人",
  tags:["丰胸", "服务流程"],
  customer_facing_candidate:true
};

try {
  const payload = {
    ...common,
    idempotency_key:"knowledge-intake-create-0001",
    source_filename:"丰胸服务说明.md",
    text_content:"# 丰胸项目服务说明\n\n本文说明自体脂肪丰胸的一般服务流程，可用于客户了解常规项目知识；个体方案仍需医生面诊确认。"
  };
  const created = createKnowledgeIntakeDocument(payload);
  assert.equal(created.replayed, false);
  assert.equal(created.document.status, "draft");
  assert.equal(created.document.parser_status, "parsed");
  assert.equal(created.document.knowledge_base_status, "internal_only");
  assert.ok(created.document.indexed_chunk_count >= 1);
  assert.equal(Object.hasOwn(created.document, "raw_text"), false, "列表与响应不能返回完整内部原文");
  assert.equal(createKnowledgeIntakeDocument(payload).replayed, true, "同一幂等键重试不得重复创建");
  assert.equal(listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"] }).length, 1);
  assert.equal(listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"], q:"丰胸服务" }).length, 1);
  assert.equal(listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"], q:"不存在的资料" }).length, 0);
  assert.equal(listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"], content_type:"医生介绍" }).length, 0);
  assert.equal(listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"], public_scope:"internal" }).length, 1);
  assert.throws(() => listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"], valid_on:"不是日期" }), (error) => error.code === "KNOWLEDGE_VALID_ON_INVALID");
  assert.throws(() => listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["皮肤科"], department:"整形外科" }), (error) => error.code === "KNOWLEDGE_DEPARTMENT_FORBIDDEN");
  assert.throws(() => createKnowledgeIntakeDocument({ ...payload, idempotency_key:"knowledge-intake-create-0002", source_filename:"内部资料.pdf" }), (error) => error.code === "KNOWLEDGE_RAW_UPLOAD_REQUIRED");
  assert.throws(() => createKnowledgeIntakeDocument({ ...payload, idempotency_key:"knowledge-intake-create-0003", department:"皮肤科" }), (error) => error.code === "KNOWLEDGE_DEPARTMENT_FORBIDDEN");

  const customerHits = searchRuntimeKnowledge("想了解自体脂肪丰胸的服务流程", { tenant_id:tenantId, audience:"public" });
  assert.equal(customerHits.length, 0, "内部草稿不得加入对客问答向量检索");
  assert.ok(searchRuntimeKnowledge("自体脂肪丰胸", { tenant_id:tenantId, audience:"internal" }).length > 0);
  const answerHits = retrieveHuameiKnowledge("想了解自体脂肪丰胸的服务流程", { tenantId, audience:"public" });
  assert.ok(answerHits.every((item) => !item.item.record_id.startsWith(`krt_${created.document.id}_`)), "售前问答不得读取内部草稿");

  const textBytes = Buffer.from("# 眼部项目原始素材\n\n这是通过原始素材三段式上传进入隔离区的文本资料，解析并建立向量索引后可直接用于问答。", "utf8");
  const preparedText = prepareKnowledgeIntakeAsset({
    ...common,
    idempotency_key:"knowledge-asset-prepare-text-0001",
    source_filename:"眼部项目说明.md",
    mime:"text/markdown",
    size:textBytes.length
  });
  assert.match(preparedText.asset.upload_url, /\/api\/admin\/knowledge\/intake\/assets\//);
  const uploadedText = await saveKnowledgeIntakeAssetContent({
    tenant_id:tenantId, asset_id:preparedText.asset.id, actor:"dept-owner-a", permitted_departments:["整形外科"],
    buffer:textBytes, mime:"text/markdown"
  });
  assert.equal(uploadedText.status, "uploaded");
  const completedText = await completeKnowledgeIntakeAsset({
    tenant_id:tenantId, asset_id:preparedText.asset.id, actor:"dept-owner-a", permitted_departments:["整形外科"],
    idempotency_key:"knowledge-asset-complete-text-0001"
  });
  assert.equal(completedText.document.status, "draft");
  assert.equal(completedText.document.parser_status, "parsed");
  assert.equal(completedText.document.knowledge_base_status, "internal_only");
  assert.equal(completedText.document.source_asset_id, preparedText.asset.id);
  assert.match(completedText.document.id, /^kidoc_/);
  assert.notEqual(completedText.document.id, preparedText.asset.id);
  assert.equal(Object.hasOwn(completedText.document, "raw_text"), false);

  const pdfBytes = Buffer.from("%PDF-1.7\n%test\n", "ascii");
  const preparedPdf = prepareKnowledgeIntakeAsset({
    ...common,
    idempotency_key:"knowledge-asset-prepare-pdf-0001",
    source_filename:"公开项目海报.pdf",
    content_type:"公开海报",
    mime:"application/pdf",
    size:pdfBytes.length
  });
  await saveKnowledgeIntakeAssetContent({
    tenant_id:tenantId, asset_id:preparedPdf.asset.id, actor:"dept-owner-a", permitted_departments:["整形外科"],
    buffer:pdfBytes, mime:"application/pdf"
  });
  const completedPdf = await completeKnowledgeIntakeAsset({
    tenant_id:tenantId, asset_id:preparedPdf.asset.id, actor:"dept-owner-a", permitted_departments:["整形外科"],
    idempotency_key:"knowledge-asset-complete-pdf-0001"
  });
  assert.equal(completedPdf.document.status, "parsing_pending");
  assert.equal(completedPdf.document.parser_status, "pending_controlled_parse");
  assert.throws(() => submitKnowledgeIntakeDocument({
    tenant_id:tenantId, document_id:completedPdf.document.id, actor:"dept-owner-a", permitted_departments:["整形外科"],
    idempotency_key:"knowledge-intake-submit-pdf-0001"
  }), (error) => error.code === "KNOWLEDGE_INTAKE_PARSE_PENDING");

  process.env.HUAMEI_RUNTIME_ENV = "production";
  process.env.HUAMEI_PERSISTENCE_BACKEND = "postgres";
  await assert.rejects(() => listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"] }), { code:"POSTGRES_NOT_CONFIGURED" }, "仅声明postgres不能让尚未迁移的资料模块写入本地JSON");
  console.log("✓ 原始素材隔离、受控解析、内部索引与对客隔离及生产持久化缺失门禁通过");
} finally {
  await rm(assetRoot, { recursive:true, force:true });
}
