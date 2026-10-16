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
  getKnowledgeIntakeDocument,
  listKnowledgeIntakeDocuments,
  prepareKnowledgeIntakeAsset,
  saveKnowledgeIntakeAssetContent,
  submitKnowledgeIntakeDocument,
  updateKnowledgeIntakeDocument
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

  const parsedPreview = createKnowledgeIntakeDocument({
    ...common,
    idempotency_key:"knowledge-intake-preview-create-0001",
    source_filename:"解析预览验收.md",
    text_content:"# C005 AC1 解析预览验收\n\n第一段用于验证原文件与行号定位。\n\n第二段用于验证多段解析预览不会混淆来源。\n\n| 项目 | 说明 |\n| --- | --- |\n| 本地验收 | 不含客户资料 |"
  });
  const previewDetail = getKnowledgeIntakeDocument({ tenant_id:tenantId, document_id:parsedPreview.document.id, permitted_departments:["整形外科"] });
  assert.equal(previewDetail.parse_preview.length, 4, "已解析文本必须保留可预览的源段");
  assert.deepEqual(previewDetail.parse_preview.map((segment) => segment.source_filename), Array(4).fill("解析预览验收.md"));
  assert.deepEqual(previewDetail.parse_preview.map((segment) => segment.paragraph), [1, 2, 3, 4]);
  assert.equal(previewDetail.parse_preview.at(-1).kind, "table", "Markdown表格必须以来源段单独呈现");
  assert.match(previewDetail.parse_preview.at(-1).locator, /第 7–9 行/);

  const needsAttention = createKnowledgeIntakeDocument({
    ...common,
    idempotency_key:"knowledge-intake-quality-create-0001",
    source_filename:"解析质量异常验收.md",
    text_content:"# C005 AC2 解析质量异常验收\n\nC005AC2_QA_GUARD_9284 第一段正常文字。\n\n\n\n含乱码 � 的文字必须人工核对。\n\n| 列A | 列B |\n| --- |\n| 本地验收 | 待处理 |"
  });
  assert.equal(needsAttention.document.parser_status, "needs_attention");
  assert.equal(needsAttention.document.status, "parsing_pending");
  assert.equal(needsAttention.document.retrieval_index_status, "awaiting_correction");
  assert.equal(needsAttention.document.indexed_chunk_count, 0, "解析待处理资料不得被标为索引就绪");
  const qualityDetail = getKnowledgeIntakeDocument({ tenant_id:tenantId, document_id:needsAttention.document.id, permitted_departments:["整形外科"] });
  assert.equal(qualityDetail.parse_quality.status, "needs_attention");
  assert.deepEqual(new Set(qualityDetail.parse_quality.issues.map((item) => item.code)), new Set(["EMPTY_BLOCK", "GARBLED_TEXT", "TABLE_STRUCTURE_INVALID"]));
  assert.ok(qualityDetail.parse_preview.some((segment) => segment.issue_codes.includes("GARBLED_TEXT")));
  assert.ok(qualityDetail.parse_preview.some((segment) => segment.issue_codes.includes("TABLE_STRUCTURE_INVALID")));
  assert.ok(searchRuntimeKnowledge("C005AC2_QA_GUARD_9284", { tenant_id:tenantId, audience:"internal" }).every((item) => item.item.uploaded_document_id !== needsAttention.document.id), "待处理解析不得进入内部检索");
  assert.throws(() => submitKnowledgeIntakeDocument({
    tenant_id:tenantId, document_id:needsAttention.document.id, actor:"dept-owner-a", permitted_departments:["整形外科"],
    idempotency_key:"knowledge-intake-quality-candidate-blocked-0001", expected_version:needsAttention.document.version
  }), (error) => error.code === "KNOWLEDGE_INTAKE_PARSE_PENDING", "解析待处理资料不得自动进入审核/发布候选");
  const repaired = updateKnowledgeIntakeDocument({
    ...common,
    document_id:needsAttention.document.id,
    idempotency_key:"knowledge-intake-quality-repaired-0001",
    expected_version:1,
    title:"C005 AC2 解析质量异常验收（已修正）",
    text_content:"# C005 AC2 解析质量异常验收（已修正）\n\n人工核对后正文正常，下面的表格列数与分隔行一致。\n\n| 列A | 列B |\n| --- | --- |\n| 本地验收 | 已修正 |"
  });
  assert.equal(repaired.document.parser_status, "parsed");
  assert.equal(repaired.document.retrieval_index_status, "indexed");

  const concurrent = createKnowledgeIntakeDocument({
    ...common,
    idempotency_key:"knowledge-intake-concurrent-create-0001",
    source_filename:"并发校订验收.md",
    text_content:"# 并发校订验收\n\n仅用于本地并发版本冲突验证，不包含客户资料或医疗结论。"
  });
  const concurrentUpdate = updateKnowledgeIntakeDocument({
    ...common,
    document_id:concurrent.document.id,
    idempotency_key:"knowledge-intake-concurrent-update-0001",
    expected_version:1,
    title:"并发校订验收（先保存）",
    text_content:"# 并发校订验收（先保存）\n\n第一位操作人已保存的本地版本，用于验证后续陈旧版本会被拒绝。"
  });
  assert.equal(concurrentUpdate.document.version, 2);
  assert.throws(() => updateKnowledgeIntakeDocument({
    ...common,
    document_id:concurrent.document.id,
    idempotency_key:"knowledge-intake-concurrent-stale-0001",
    expected_version:1,
    title:"并发校订验收（陈旧保存）",
    text_content:"# 并发校订验收（陈旧保存）\n\n第二位操作人使用陈旧版本保存，必须触发冲突而不是覆盖对方版本。"
  }), (error) => error.code === "KNOWLEDGE_VERSION_CONFLICT"
    && error.details?.[0]?.current_version === 2
    && error.details?.[0]?.field === "expected_version", "陈旧版本必须返回可比较的当前版本信息");
  assert.ok(created.document.indexed_chunk_count >= 1);
  assert.equal(Object.hasOwn(created.document, "raw_text"), false, "列表与响应不能返回完整内部原文");
  assert.equal(createKnowledgeIntakeDocument(payload).replayed, true, "同一幂等键重试不得重复创建");
  assert.equal(listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"] }).length, 4);
  assert.equal(listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"], q:"丰胸服务" }).length, 1);
  assert.equal(listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"], q:"不存在的资料" }).length, 0);
  assert.equal(listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"], content_type:"医生介绍" }).length, 0);
  assert.equal(listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"], public_scope:"internal" }).length, 4);
  assert.throws(() => listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"], valid_on:"不是日期" }), (error) => error.code === "KNOWLEDGE_VALID_ON_INVALID");
  assert.throws(() => listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["皮肤科"], department:"整形外科" }), (error) => error.code === "KNOWLEDGE_DEPARTMENT_FORBIDDEN");
  assert.throws(() => createKnowledgeIntakeDocument({ ...payload, idempotency_key:"knowledge-intake-create-0002", source_filename:"内部资料.pdf" }), (error) => error.code === "KNOWLEDGE_RAW_UPLOAD_REQUIRED");
  assert.throws(() => createKnowledgeIntakeDocument({ ...payload, idempotency_key:"knowledge-intake-create-0003", department:"皮肤科" }), (error) => error.code === "KNOWLEDGE_DEPARTMENT_FORBIDDEN");
  assert.throws(() => createKnowledgeIntakeDocument({
    ...payload, idempotency_key:"knowledge-intake-create-required-fields-0001", department:"", content_type:"未定义类型", owner:""
  }), (error) => error.code === "KNOWLEDGE_INTAKE_METADATA_REQUIRED"
    && error.details.map((item) => item.field).join(",") === "department,content_type,owner", "必填元数据错误必须精确指向字段");
  assert.throws(() => createKnowledgeIntakeDocument({
    ...payload, idempotency_key:"knowledge-intake-create-date-conflict-0001", effective_at:"2026-12-31T00:00:00.000Z", expires_at:"2026-10-08T00:00:00.000Z"
  }), (error) => error.code === "KNOWLEDGE_EFFECTIVE_RANGE_INVALID"
    && error.details.map((item) => item.field).join(",") === "effective_at,expires_at", "日期冲突必须同时指向生效与失效字段");

  const customerHits = searchRuntimeKnowledge("想了解自体脂肪丰胸的服务流程", { tenant_id:tenantId, audience:"public" });
  assert.equal(customerHits.length, 0, "内部草稿不得加入对客问答向量检索");
  assert.ok(searchRuntimeKnowledge("自体脂肪丰胸", { tenant_id:tenantId, audience:"internal" }).length > 0);
  const answerHits = retrieveHuameiKnowledge("想了解自体脂肪丰胸的服务流程", { tenantId, audience:"public" });
  assert.ok(answerHits.every((item) => !item.item.record_id.startsWith(`krt_${created.document.id}_`)), "售前问答不得读取内部草稿");

  const unconfirmedMarker = "C003_AC4_UNCONFIRMED_PUBLIC_GUARD";
  const unconfirmed = createKnowledgeIntakeDocument({
    ...common,
    idempotency_key:"knowledge-intake-unconfirmed-public-guard-0001",
    source_filename:"未确认事实草稿.md",
    source_reference:"本地验收依据，尚未登记院方确认",
    applicable_campuses:["本地测试院区"],
    public_scope:"customer_summary",
    effective_at:"2026-10-08T00:00:00.000Z",
    expires_at:"2026-12-31T00:00:00.000Z",
    text_content:`# 未确认事实草稿\n\n${unconfirmedMarker}：仅供内部验收追溯，未经院方确认不得作为对客事实。`
  });
  assert.deepEqual(unconfirmed.document.publication_readiness.missing, ["hospital_confirmation"]);
  assert.throws(() => submitKnowledgeIntakeDocument({
    tenant_id:tenantId, document_id:unconfirmed.document.id, actor:"dept-owner-a", permitted_departments:["整形外科"],
    idempotency_key:"knowledge-intake-unconfirmed-candidate-0001", expected_version:unconfirmed.document.version
  }), (error) => error.code === "KNOWLEDGE_PUBLICATION_PREREQUISITES_MISSING"
    && error.details.some((item) => item.field === "hospital_confirmation"), "未经确认的事实不得进入候选发布");
  assert.ok(searchRuntimeKnowledge(unconfirmedMarker, { tenant_id:tenantId, audience:"internal" }).some((item) => item.item.record_id.startsWith(`krt_${unconfirmed.document.id}_`)), "未确认草稿仅供内部追溯");
  assert.equal(searchRuntimeKnowledge(unconfirmedMarker, { tenant_id:tenantId, audience:"public" }).length, 0, "未确认草稿不得自动进入对客检索");

  const textBytes = Buffer.from("# 眼部项目原始素材\n\n这是通过原始素材三段式上传进入隔离区的文本资料，解析并建立向量索引后可直接用于问答。", "utf8");
  const preparedText = prepareKnowledgeIntakeAsset({
    ...common,
    idempotency_key:"knowledge-asset-prepare-text-0001",
    source_filename:"眼部项目说明.md",
    mime:"text/markdown",
    size:textBytes.length
  });
  await assert.rejects(() => completeKnowledgeIntakeAsset({
    tenant_id:tenantId, asset_id:preparedText.asset.id, actor:"dept-owner-a", permitted_departments:["整形外科"],
    idempotency_key:"knowledge-asset-complete-before-upload-0001"
  }), (error) => error.code === "KNOWLEDGE_ASSET_STATE_INVALID", "仅获得上传地址而未写入对象时不得完成入库");
  assert.throws(() => prepareKnowledgeIntakeAsset({
    ...common, idempotency_key:"knowledge-asset-prepare-type-0001", source_filename:"不支持素材.exe",
    mime:"application/octet-stream", size:64
  }), (error) => error.code === "KNOWLEDGE_FILE_TYPE_UNSUPPORTED");
  assert.throws(() => prepareKnowledgeIntakeAsset({
    ...common, idempotency_key:"knowledge-asset-prepare-mime-0001", source_filename:"MIME不匹配.pdf",
    mime:"text/plain", size:64
  }), (error) => error.code === "KNOWLEDGE_ASSET_MIME_UNSUPPORTED");
  assert.throws(() => prepareKnowledgeIntakeAsset({
    ...common, idempotency_key:"knowledge-asset-prepare-size-0001", source_filename:"超限文本.md",
    mime:"text/markdown", size:256 * 1024 + 1
  }), (error) => error.code === "KNOWLEDGE_ASSET_SIZE_INVALID" && error.message.includes("256KB"));
  assert.throws(() => prepareKnowledgeIntakeAsset({
    ...common, idempotency_key:"knowledge-asset-prepare-content-type-0001", source_filename:"内容类型不匹配.md",
    mime:"text/markdown", size:64, content_type:"未定义类型"
  }), (error) => error.code === "KNOWLEDGE_INTAKE_METADATA_REQUIRED");
  assert.throws(() => prepareKnowledgeIntakeAsset({
    ...common, idempotency_key:"knowledge-asset-prepare-other-department-0001", source_filename:"跨科室素材.md",
    mime:"text/markdown", size:64, department:"皮肤科"
  }), (error) => error.code === "KNOWLEDGE_DEPARTMENT_FORBIDDEN");
  assert.match(preparedText.asset.upload_url, /\/api\/admin\/knowledge\/intake\/assets\//);
  await assert.rejects(() => saveKnowledgeIntakeAssetContent({
    tenant_id:tenantId, asset_id:preparedText.asset.id, actor:"dept-owner-b", permitted_departments:["整形外科"],
    buffer:textBytes, mime:"text/markdown"
  }), (error) => error.code === "KNOWLEDGE_ASSET_OWNER_FORBIDDEN", "同科室的其他操作人也不能替换上传人的素材");
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
  const correctedAssetText = updateKnowledgeIntakeDocument({
    ...common,
    document_id:completedText.document.id,
    idempotency_key:"knowledge-asset-correction-history-0001",
    expected_version:1,
    title:"眼部项目原始素材（人工校订版）",
    text_content:"# 眼部项目原始素材（人工校订版）\n\n人工校订后保留原始文件来源、文件指纹与编辑记录；本段仅用于本地验收，不包含客户资料。"
  });
  assert.equal(correctedAssetText.document.version, 2);
  const correctionDetail = getKnowledgeIntakeDocument({ tenant_id:tenantId, document_id:completedText.document.id, permitted_departments:["整形外科"] });
  assert.equal(correctionDetail.correction_history.length, 1, "人工校订必须保留一次可追溯记录");
  assert.equal(correctionDetail.correction_history[0].from_version, 1);
  assert.equal(correctionDetail.correction_history[0].to_version, 2);
  assert.equal(correctionDetail.correction_history[0].original_source.source_filename, "眼部项目说明.md");
  assert.equal(correctionDetail.correction_history[0].original_source.source_asset_id, preparedText.asset.id);
  assert.equal(correctionDetail.correction_history[0].original_source.source_sha256, completedText.document.source_sha256);
  assert.equal(correctionDetail.correction_history[0].corrected_by, "dept-owner-a");
  assert.match(correctionDetail.correction_history[0].original_text, /通过原始素材三段式上传/);
  assert.notEqual(correctionDetail.correction_history[0].original_content_hash, correctionDetail.correction_history[0].corrected_content_hash);
  const listProjection = listKnowledgeIntakeDocuments({ tenant_id:tenantId, permitted_departments:["整形外科"] }).find((item) => item.id === completedText.document.id);
  assert.equal(Object.hasOwn(listProjection, "correction_history"), false, "列表投影不得泄露原文快照或编辑记录");

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
