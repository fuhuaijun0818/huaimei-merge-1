import { createHash, randomUUID } from "node:crypto";
import { createJsonStateStore } from "./platform/json-state-store.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";

const store = createJsonStateStore({
  envName:"HUAMEI_KNOWLEDGE_INGESTION_ADMISSION_STORE_FILE",
  defaultFile:".local-data/knowledge-ingestion-admissions.json",
  initialState:{ version:1, admissions:[], audit_events:[] }
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (value) => createHash("sha256").update(String(value || "")).digest("hex");
const validSha256 = (value) => /^[0-9a-f]{64}$/i.test(String(value || "").trim());

export function admitKnowledgeUnitsForInternalCatalog({ tenant_id:tenantId, knowledge_status:knowledgeStatus, approved_count:approvedCount, approval_reference:approvalReference } = {}, actor = "project-owner") {
  const tenant = normalizeTenantId(tenantId);
  const status = knowledgeStatus && typeof knowledgeStatus === "object" ? knowledgeStatus : {};
  const totalRecords = Number(status.total_records || 0);
  const requestedCount = Number(approvedCount || 0);
  const integrity = status.integrity && typeof status.integrity === "object" ? status.integrity : {};
  if (status.loaded !== true || totalRecords < 1 || requestedCount !== totalRecords) {
    const error = new Error("知识入库批准数量必须与完整、已加载的知识单元数量一致");
    error.code = "KNOWLEDGE_INGESTION_COUNT_OR_INTEGRITY_INVALID";
    throw error;
  }
  if (!validSha256(integrity.knowledge_units_sha256) || !validSha256(integrity.manifest_sha256)) {
    const error = new Error("知识入库批准必须绑定知识单元与清单校验和");
    error.code = "KNOWLEDGE_INGESTION_CHECKSUM_INVALID";
    throw error;
  }
  const reference = String(approvalReference || "project-owner-approved-knowledge-ingestion").trim().slice(0, 160);
  const now = new Date().toISOString();
  const fingerprint = sha256([
    tenant, status.version || "", totalRecords,
    integrity.knowledge_units_sha256, integrity.manifest_sha256
  ].join("\n"));
  const state = store.load();
  const existing = state.admissions.find((item) => item.tenant_id === tenant && item.fingerprint === fingerprint);
  if (existing) return { ...clone(existing), idempotent:true };
  const admission = {
    id:`kingest_${randomUUID()}`,
    tenant_id:tenant,
    status:"approved_for_internal_catalog",
    approved_count:requestedCount,
    package_version:status.version || null,
    knowledge_units_sha256:integrity.knowledge_units_sha256,
    manifest_sha256:integrity.manifest_sha256,
    fingerprint,
    approval_reference:reference,
    approved_at:now,
    approved_by:String(actor || "project-owner").slice(0, 80),
    customer_release:{
      status:"not_activated",
      public_candidate_count:Number(status.public_candidate_records || 0),
      reason:"完整知识单元已获内部目录入库批准；对客发布仍须使用公开安全目录、三方审核、正式索引绑定和激活流程。"
    }
  };
  state.admissions.unshift(admission);
  state.admissions = state.admissions.slice(0, 100);
  state.audit_events.unshift({
    id:`kingest_audit_${randomUUID()}`,
    type:"knowledge.ingestion.approved",
    tenant_id:tenant,
    admission_id:admission.id,
    approved_count:requestedCount,
    actor:admission.approved_by,
    at:now
  });
  state.audit_events = state.audit_events.slice(0, 500);
  store.save(state);
  return clone(admission);
}

export function getKnowledgeIngestionAdmission(tenantId) {
  const tenant = normalizeTenantId(tenantId);
  const state = store.load();
  return clone(state.admissions.find((item) => item.tenant_id === tenant) || null);
}

export const resetKnowledgeIngestionAdmissionsForTest = () => store.reset();
