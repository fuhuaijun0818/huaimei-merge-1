import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "huamei-knowledge-integrity-"));
mkdirSync(join(root, "rag"), { recursive:true });
process.env.HUAMEI_KNOWLEDGE_ROOT = root;
delete process.env.HUAMEI_KNOWLEDGE_PUBLIC_SAFE_CATALOG;
process.env.HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE = ":memory:";
process.env.HUAMEI_KNOWLEDGE_APPROVAL_MODE = "enforce";

const knowledge = await import("../server/huamei-knowledge.mjs");
const releasePolicy = await import("../server/knowledge-release-policy.mjs");
const { invokeAgent } = await import("../server/agent-runtime.mjs");
const { getAcquisitionDomainStatus } = await import("../server/acquisition-domain-service.mjs");

const manifest = {
  package_name:"华美测试知识包",
  version:"integrity-v1",
  generated_date:"2026-08-26",
  knowledge_unit_count:2,
  restricted_asset_count:0
};
const sourceRecords = [
  {
    record_id:"kb_integrity_price",
    record_type:"directory_overview",
    title:"华美资料目录：双眼皮价格",
    content:"双眼皮价格资料目录，仅用于核验当前收费。",
    tags:["双眼皮", "价格"],
    source_relative_path:"项目价格/整形外科/双眼皮",
    sensitivity:"internal",
    verification_note:"当前价格、有效期与包含项必须由人工核验。"
  },
  {
    record_id:"kb_integrity_doctor",
    record_type:"image_ocr",
    title:"医生与专家：测试医生个人介绍",
    content:"测试医生有胸部整形方向的院方介绍。",
    tags:["医生介绍", "胸部整形"],
    source_relative_path:"医生介绍/整形外科/测试医生/个人介绍.png",
    sensitivity:"internal",
    verification_note:"职称、擅长和排班以院方当前正式信息为准。"
  }
];
const signedRecords = sourceRecords.map((record) => ({
  ...record,
  record_content_sha256:knowledge.knowledgeRecordContentSha256(record),
  text:knowledge.officialKnowledgeRecordText(record)
}));
assert.equal(knowledge.knowledgeRecordContentSha256({
  record_id:"kb-测试", record_type:"image_ocr", title:" 标题 ", content:" 正文 ",
  tags:["医生", "胸部"], source_relative_path:"医生介绍/测试.png",
  sensitivity:"INTERNAL", verification_note:" 核验 "
}), "563a8e6050abb74e87451463e0fe4bbff3fc7ad4c0ca5481083df9449d822d81",
"Node canonical record hash必须与official GraphRAG Python实现一致");

const writePackage = (publicCatalogRecords, manifestOverrides = {}) => {
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify({ ...manifest, ...manifestOverrides })}\n`, "utf8");
  writeFileSync(join(root, "rag", "knowledge_units.jsonl"), `${sourceRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  writeFileSync(join(root, "rag", "huamei-public-safe.jsonl"), `${publicCatalogRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  knowledge.resetHuameiKnowledgeForTest();
  return knowledge.loadHuameiKnowledge({ force:true, root });
};

try {
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  writeFileSync(join(root, "rag", "knowledge_units.jsonl"), `${sourceRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  knowledge.resetHuameiKnowledgeForTest();
  let state = knowledge.loadHuameiKnowledge({ force:true, root });
  assert.equal(state.loaded, false, "自定义host包缺公共安全目录时不得回退到仓库目录");
  assert.equal(state.error, "KNOWLEDGE_PUBLIC_SAFE_CATALOG_NOT_FOUND");

  state = writePackage(signedRecords);
  assert.equal(state.loaded, true);
  assert.equal(state.declaredRecordHashCount, 2);
  assert.match(state.packageChecksum, /^[0-9a-f]{64}$/);
  assert.match(state.allRecordListChecksum, /^[0-9a-f]{64}$/);

  for (const field of ["content", "title", "source_relative_path", "verification_note"]) {
    const tampered = structuredClone(signedRecords);
    tampered[0][field] = `${tampered[0][field]}（未重新签署的修改）`;
    state = writePackage(tampered);
    assert.equal(state.loaded, false, `${field}变化后旧record hash必须失效`);
    assert.equal(state.error, "KNOWLEDGE_RECORD_HASH_MISMATCH");
  }

  const staleText = structuredClone(signedRecords);
  staleText[0].text = `${staleText[0].text}\n未审批文本`;
  state = writePackage(staleText);
  assert.equal(state.loaded, false, "GraphRAG text与canonical字段不一致必须失败关闭");
  assert.equal(state.error, "KNOWLEDGE_RECORD_TEXT_MISMATCH");

  for (const field of ["content", "title", "source_relative_path", "verification_note"]) {
    const incomplete = structuredClone(signedRecords);
    delete incomplete[0][field];
    state = writePackage(incomplete);
    assert.equal(state.loaded, false, `缺少${field}必须失败关闭`);
    assert.equal(state.error, `KNOWLEDGE_RECORD_${field.toUpperCase()}_MISSING`);
  }

  state = writePackage(signedRecords);
  releasePolicy.resetKnowledgeReleasesForTest();
  const approvedRecordIds = signedRecords.map((record) => record.record_id);
  const correctRecordListChecksum = knowledge.computeApprovedKnowledgeRecordListChecksum(approvedRecordIds, { state });
  const reviews = {
    business:{ reviewer:"业务审核人", decision:"approved" },
    medical:{ reviewer:"医务审核人", decision:"approved" },
    compliance:{ reviewer:"合规审核人", decision:"approved" }
  };
  releasePolicy.publishKnowledgeRelease({
    tenant_id:"integrity-tenant",
    package_version:state.version,
    package_checksum:state.packageChecksum,
    record_list_checksum:correctRecordListChecksum,
    approved_record_ids:approvedRecordIds,
    reviews
  }, "release-owner");
  assert.equal(knowledge.getHuameiKnowledgeStatus("integrity-tenant").admission.ready, true);
  assert.ok(knowledge.retrieveHuameiKnowledge("双眼皮价格", {
    audience:"public", tenantId:"integrity-tenant"
  }).length > 0);

  // A host package can be internally self-consistent after a rewrite and still
  // be unauthorized. The active release checksum remains the immutable anchor.
  const rewritten = structuredClone(signedRecords);
  rewritten[0].content = "被重新打包但未重新发布审批的价格资料。";
  const { record_content_sha256:_previousHash, text:_previousText, ...rewrittenMaterial } = rewritten[0];
  rewritten[0].record_content_sha256 = knowledge.knowledgeRecordContentSha256(rewrittenMaterial);
  rewritten[0].text = knowledge.officialKnowledgeRecordText(rewrittenMaterial);
  state = writePackage(rewritten);
  assert.equal(state.loaded, true);
  const mismatched = knowledge.getHuameiKnowledgeStatus("integrity-tenant");
  assert.equal(mismatched.admission.ready, false);
  assert.equal(mismatched.admission.error, "KNOWLEDGE_PACKAGE_CHECKSUM_MISMATCH");
  assert.equal(knowledge.retrieveHuameiKnowledge("双眼皮价格", {
    audience:"public", tenantId:"integrity-tenant"
  }).length, 0);
  const blockedReply = invokeAgent("A-01", {
    message:"双眼皮多少钱？",
    mode:"reply",
    context:{ tenant_id:"integrity-tenant", interests:[], known_projects:[] }
  });
  assert.equal(blockedReply.status, "handover_required");
  assert.equal(blockedReply.output.handover.reason, "knowledge_integrity_not_ready");
  assert.equal(blockedReply.output.citations.length, 0);
  const domain = await getAcquisitionDomainStatus("integrity-tenant");
  assert.equal(domain.status, "degraded");
  assert.equal(domain.knowledge_admission.ready, false);

  state = writePackage(signedRecords);
  releasePolicy.publishKnowledgeRelease({
    tenant_id:"integrity-tenant",
    package_version:state.version,
    package_checksum:state.packageChecksum,
    record_list_checksum:"f".repeat(64),
    approved_record_ids:approvedRecordIds,
    reviews
  }, "release-owner-2");
  const wrongApprovedSet = knowledge.getHuameiKnowledgeStatus("integrity-tenant");
  assert.equal(wrongApprovedSet.admission.ready, false);
  assert.equal(wrongApprovedSet.admission.error, "KNOWLEDGE_RECORD_LIST_CHECKSUM_MISMATCH");

  console.log("✓ Node知识fallback完整重算record/package/批准记录集并绑定active release");
  console.log("✓ 正文、标题、path、verification_note旧hash及缺字段均失败关闭");
  console.log("✓ host包或批准记录集与release不一致时domain降级、知识意图转人工");
} finally {
  rmSync(root, { recursive:true, force:true });
}
