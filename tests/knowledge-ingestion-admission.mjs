import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "huamei-knowledge-ingestion-"));
process.env.HUAMEI_KNOWLEDGE_INGESTION_ADMISSION_STORE_FILE = join(root, "admissions.json");
const {
  admitKnowledgeUnitsForInternalCatalog,
  getKnowledgeIngestionAdmission,
  resetKnowledgeIngestionAdmissionsForTest
} = await import("../server/knowledge-ingestion-admission.mjs");

try {
  resetKnowledgeIngestionAdmissionsForTest();
  const knowledgeStatus = {
    loaded:true,
    version:"v1",
    total_records:7127,
    public_candidate_records:925,
    integrity:{ manifest_sha256:"a".repeat(64), knowledge_units_sha256:"b".repeat(64) }
  };
  const admission = admitKnowledgeUnitsForInternalCatalog({
    tenant_id:"huamei-shanghai",
    knowledge_status:knowledgeStatus,
    approved_count:7127,
    approval_reference:"project-owner-approved-2026-08-28"
  }, "project-owner");
  assert.equal(admission.status, "approved_for_internal_catalog");
  assert.equal(admission.approved_count, 7127);
  assert.equal(admission.customer_release.status, "not_activated");
  assert.equal(getKnowledgeIngestionAdmission("huamei-shanghai").id, admission.id);
  assert.equal(admitKnowledgeUnitsForInternalCatalog({
    tenant_id:"huamei-shanghai",
    knowledge_status:knowledgeStatus,
    approved_count:7127
  }).idempotent, true);
  assert.throws(() => admitKnowledgeUnitsForInternalCatalog({
    tenant_id:"huamei-shanghai", knowledge_status:knowledgeStatus, approved_count:7126
  }), (error) => error.code === "KNOWLEDGE_INGESTION_COUNT_OR_INTEGRITY_INVALID");
  console.log("✓ 7,127条知识单元内部目录准入、校验和绑定与对客发布隔离通过");
} finally {
  await rm(root, { recursive:true, force:true });
}
