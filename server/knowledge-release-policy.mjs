import { effectiveManagementRolesFor } from "./platform/phase-one-role-policy.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createJsonStateStore } from "./platform/json-state-store.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";
import { postgresPersistenceEnabled } from "./persistence/postgres-helpers.mjs";
import { getPostgresKnowledgeReleaseStore } from "./persistence/postgres-knowledge-release-store.mjs";

const initialState = { version:1, releases:[], audit_events:[] };
const store = createJsonStateStore({
  envName:"HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE",
  defaultFile:".local-data/knowledge-releases.json",
  initialState
});
const runtimeKnowledgeTenantIds = new Set();

const clone = (value) => JSON.parse(JSON.stringify(value));
const approvalMode = () => String(
  process.env.HUAMEI_KNOWLEDGE_APPROVAL_MODE
    || (process.env.NODE_ENV === "production" ? "enforce" : "preview")
).trim().toLowerCase() === "enforce" ? "enforce" : "preview";

const activeAt = (release, now = Date.now()) => release.status === "active"
  && Date.parse(release.effective_at) <= now
  && (!release.expires_at || Date.parse(release.expires_at) > now);

const validateReviewer = (review, field) => {
  if (!review || review.decision !== "approved" || !String(review.reviewer || "").trim()) {
    const error = new Error(`知识发布缺少${field}审核通过记录`);
    error.code = "KNOWLEDGE_APPROVAL_INCOMPLETE";
    error.details = [{ field:`reviews.${field}`, message:"需要审核人和approved结论" }];
    throw error;
  }
  return {
    reviewer:String(review.reviewer).trim().slice(0, 80),
    decision:"approved",
    reviewed_at:review.reviewed_at || new Date().toISOString(),
    comments:String(review.comments || "").trim().slice(0, 1_000) || null,
    evidence:review.evidence && typeof review.evidence === "object" ? clone(review.evidence) : {}
  };
};

const checksum = (value) => createHash("sha256").update(String(value)).digest("hex");
const validSha256 = (value) => /^[0-9a-f]{64}$/.test(String(value || "").trim().toLowerCase());
const productionRuntime = () => ["prod", "production"].includes(String(
  process.env.HUAMEI_RUNTIME_ENV || process.env.HUAMEI_DEPLOYMENT_ENV || process.env.NODE_ENV || "development"
).trim().toLowerCase());
const formalWorkflowRequired = () => productionRuntime() || approvalMode() === "enforce";

const requirePostgresWorkflow = () => {
  if (!postgresPersistenceEnabled()) {
    const error = new Error("正式知识发布流程需要PostgreSQL、实名审核与不可变审批记录");
    error.code = "FORMAL_KNOWLEDGE_WORKFLOW_REQUIRES_POSTGRES";
    throw error;
  }
  return getPostgresKnowledgeReleaseStore();
};

const requireIdentityRole = (identity, role) => {
  if (!identity?.subject || !effectiveManagementRolesFor(identity).includes(role)) {
    const error = new Error(`当前实名身份缺少${role}权限`);
    error.code = "KNOWLEDGE_IDENTITY_ROLE_FORBIDDEN";
    throw error;
  }
  return identity;
};

const tenantValues = (value) => String(value || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

export function configuredKnowledgeReleaseTenants(env = process.env, clients = []) {
  const clientEntries = Array.isArray(clients)
    ? clients
    : Array.isArray(clients?.clients) ? clients.clients : [];
  const values = [
    ...tenantValues(env.HUAMEI_RELEASE_TENANT_IDS),
    ...tenantValues(env.HUAMEI_CONVERSATION_RECOVERY_TENANT_IDS),
    ...tenantValues(env.HUAMEI_DEFAULT_TENANT_ID),
    ...tenantValues(env.HUAMEI_PUBLIC_TENANT_ID),
    ...clientEntries.flatMap((client) => Array.isArray(client?.tenant_ids) ? client.tenant_ids : [])
  ];
  const tenants = [];
  const seen = new Set();
  for (const value of values) {
    if (String(value || "").trim() === "*") continue;
    const tenantId = normalizeTenantId(value);
    if (seen.has(tenantId)) continue;
    seen.add(tenantId);
    tenants.push(tenantId);
  }
  return tenants.length ? tenants : [normalizeTenantId()];
}

export function registerKnowledgeReleaseTenants(tenantIds = []) {
  const values = Array.isArray(tenantIds) ? tenantIds : [tenantIds];
  for (const value of values) {
    if (!String(value || "").trim() || String(value || "").trim() === "*") continue;
    runtimeKnowledgeTenantIds.add(normalizeTenantId(value));
  }
  return [...runtimeKnowledgeTenantIds];
}

export function listRegisteredKnowledgeReleaseTenants() {
  return [...runtimeKnowledgeTenantIds];
}

const resolvedRefreshTenants = (tenantIds) => {
  if (tenantIds !== undefined && tenantIds !== null) {
    return registerKnowledgeReleaseTenants(tenantIds);
  }
  if (!runtimeKnowledgeTenantIds.size) {
    registerKnowledgeReleaseTenants(configuredKnowledgeReleaseTenants());
  }
  return [...runtimeKnowledgeTenantIds];
};

const knowledgeRefreshTtlMs = (env = process.env) => {
  const configured = Number(env.HUAMEI_KNOWLEDGE_RELEASE_REFRESH_MS || 5_000);
  return Number.isFinite(configured) ? Math.max(1_000, configured) : 5_000;
};

export async function initializeKnowledgeReleasePolicy(tenantIds) {
  if (!postgresPersistenceEnabled()) return getKnowledgeAdmissionStatus();
  const tenants = resolvedRefreshTenants(tenantIds);
  const statuses = await Promise.all(tenants.map((tenantId) => getPostgresKnowledgeReleaseStore().refresh(tenantId)));
  return statuses.length === 1 ? statuses[0] : { tenants:statuses };
}

export async function refreshKnowledgeReleasePolicy(tenantIds) {
  if (!postgresPersistenceEnabled()) return null;
  const tenants = resolvedRefreshTenants(tenantIds);
  const statuses = await Promise.all(tenants.map((tenantId) => getPostgresKnowledgeReleaseStore().refresh(tenantId)));
  return statuses.length === 1 ? statuses[0] : { tenants:statuses };
}

export async function ensureKnowledgeReleasePolicyFresh(tenantId, options = {}) {
  if (!postgresPersistenceEnabled()) return getKnowledgeAdmissionStatus(tenantId);
  const tenant = normalizeTenantId(tenantId);
  registerKnowledgeReleaseTenants(tenant);
  return getPostgresKnowledgeReleaseStore().ensureFresh(tenant, {
    ttlMs:options.ttlMs ?? knowledgeRefreshTtlMs(options.env || process.env),
    force:options.force === true,
    ...(options.now === undefined ? {} : { now:options.now })
  });
}

export function getActiveKnowledgeRelease(tenantId, packageVersion = "") {
  const tenant = normalizeTenantId(tenantId);
  const releases = postgresPersistenceEnabled()
    ? getPostgresKnowledgeReleaseStore().list(tenant)
    : store.load().releases;
  return releases
    .filter((item) => item.tenant_id === tenant && activeAt(item))
    .filter((item) => !packageVersion || item.package_version === packageVersion)
    .sort((a, b) => String(b.activated_at).localeCompare(String(a.activated_at)))[0] || null;
}

// 撤回/失效证据集合：先前生效发布里批准、但当前生效发布不再包含的记录；
// 当前没有生效发布（例如发布包已过期）时，此前批准过的记录全部视为失效。
// 交付前用它做最终重检，避免继续引用已撤回或过期的内容。
export function withdrawnKnowledgeRecordIds(tenantId, packageVersion = "") {
  const tenant = normalizeTenantId(tenantId);
  const releases = (postgresPersistenceEnabled() ? [] : store.load().releases || [])
    .filter((item) => item.tenant_id === tenant)
    .sort((left, right) => String(left.activated_at || "").localeCompare(String(right.activated_at || "")));
  if (!releases.length) return new Set();
  const current = getActiveKnowledgeRelease(tenant, packageVersion);
  const currentIds = new Set(current?.approved_record_ids || []);
  const withdrawn = new Set(current?.withdrawn_record_ids || []);
  for (const release of releases) {
    for (const id of release.approved_record_ids || []) {
      if (!currentIds.has(id)) withdrawn.add(id);
    }
  }
  return withdrawn;
}

export function approvedKnowledgeRecordIds(tenantId, packageVersion = "") {
  const release = getActiveKnowledgeRelease(tenantId, packageVersion);
  return new Set(release?.approved_record_ids || []);
}

export function isKnowledgeRecordAdmitted(recordId, tenantId, packageVersion = "") {
  if (approvalMode() === "preview") return true;
  return approvedKnowledgeRecordIds(tenantId, packageVersion).has(String(recordId || ""));
}

export function publishKnowledgeRelease(payload = {}, actor = "system") {
  if (formalWorkflowRequired() && postgresPersistenceEnabled()) {
    const error = new Error("正式环境禁止在单次请求中自报三位审核人；请使用草稿、三次实名审核、索引绑定和激活流程");
    error.code = "KNOWLEDGE_LEGACY_PUBLISH_FORBIDDEN";
    throw error;
  }
  const tenantId = normalizeTenantId(payload.tenant_id);
  const packageVersion = String(payload.package_version || "").trim().slice(0, 80);
  const approvedRecordIds = [...new Set((payload.approved_record_ids || []).map((item) => String(item).trim()).filter(Boolean))];
  if (!packageVersion || !approvedRecordIds.length) {
    const error = new Error("知识发布必须指定知识包版本和至少一条已审核记录");
    error.code = "KNOWLEDGE_RELEASE_INVALID";
    throw error;
  }
  const reviews = {
    business:validateReviewer(payload.reviews?.business, "business"),
    medical:validateReviewer(payload.reviews?.medical, "medical"),
    compliance:validateReviewer(payload.reviews?.compliance, "compliance")
  };
  const packageChecksum = String(payload.package_checksum || "").trim().toLowerCase();
  const recordListChecksum = String(
    payload.record_list_checksum || payload.approved_record_list_sha256 || payload.manifest?.approved_record_list_sha256 || ""
  ).trim().toLowerCase();
  const indexChecksum = String(payload.index_checksum || payload.manifest?.index_checksum || "").trim().toLowerCase();
  if (postgresPersistenceEnabled() && (!validSha256(packageChecksum) || !validSha256(indexChecksum))) {
    const error = new Error("正式知识发布必须绑定64位package_checksum和index_checksum");
    error.code = "KNOWLEDGE_RELEASE_CHECKSUM_REQUIRED";
    error.details = [
      ...(!validSha256(packageChecksum) ? [{ field:"package_checksum", message:"需要知识包SHA-256" }] : []),
      ...(!validSha256(indexChecksum) ? [{ field:"index_checksum", message:"需要GraphRAG索引SHA-256" }] : [])
    ];
    throw error;
  }
  const now = new Date().toISOString();
  const approvedRecordsChecksum = checksum([...approvedRecordIds].sort().join("\n"));
  const release = {
    id:`krel_${randomUUID()}`,
    tenant_id:tenantId,
    package_version:packageVersion,
    approved_record_ids:approvedRecordIds,
    approved_record_count:approvedRecordIds.length,
    package_checksum:packageChecksum || null,
    record_list_checksum:recordListChecksum || null,
    index_checksum:indexChecksum || null,
    reviews,
    status:"active",
    effective_at:payload.effective_at || now,
    expires_at:payload.expires_at || null,
    activated_at:now,
    activated_by:String(actor || "system").slice(0, 80),
    manifest:{
      ...(payload.manifest && typeof payload.manifest === "object" ? clone(payload.manifest) : {}),
      index_checksum:indexChecksum || null,
      approved_record_ids_checksum:approvedRecordsChecksum,
      approved_record_list_sha256:recordListChecksum || null,
      approved_record_count:approvedRecordIds.length,
      effective_at:payload.effective_at || now,
      expires_at:payload.expires_at || null
    }
  };
  if (postgresPersistenceEnabled()) {
    return getPostgresKnowledgeReleaseStore().publish({ release, reviews, actor:release.activated_by });
  }
  const state = store.load();
  state.releases = state.releases.map((item) => item.tenant_id === tenantId && item.status === "active"
    ? { ...item, status:"superseded", superseded_at:now }
    : item);
  state.releases.unshift(release);
  state.releases = state.releases.slice(0, 100);
  state.audit_events.unshift({ id:`kaudit_${randomUUID()}`, type:"knowledge.release.activated", tenant_id:tenantId, release_id:release.id, actor:release.activated_by, at:now });
  state.audit_events = state.audit_events.slice(0, 500);
  store.save(state);
  return clone(release);
}

export async function createKnowledgeReleaseDraft(payload = {}, identity = {}) {
  const reviewer = requireIdentityRole(identity, "knowledge.release_manager");
  const tenantId = normalizeTenantId(payload.tenant_id);
  const packageVersion = String(payload.package_version || "").trim().slice(0, 128);
  const packageChecksum = String(payload.package_checksum || "").trim().toLowerCase();
  const recordListChecksum = String(
    payload.record_list_checksum || payload.approved_record_list_sha256 || payload.manifest?.approved_record_list_sha256 || ""
  ).trim().toLowerCase();
  const indexVersion = String(payload.index_version || payload.manifest?.index_version || "").trim().slice(0, 128);
  const approvedRecordIds = [...new Set((payload.approved_record_ids || []).map((item) => String(item).trim()).filter(Boolean))];
  if (!packageVersion || !validSha256(packageChecksum) || !validSha256(recordListChecksum) || !indexVersion || !approvedRecordIds.length) {
    const error = new Error("知识审核草稿必须绑定包版本、知识包SHA、批准记录集SHA、索引版本和记录清单");
    error.code = "KNOWLEDGE_DRAFT_BINDING_INVALID";
    throw error;
  }
  const now = new Date().toISOString();
  const release = {
    id:String(payload.release_id || `krel_${randomUUID()}`).trim().slice(0, 128),
    tenant_id:tenantId,
    package_version:packageVersion,
    package_checksum:packageChecksum,
    record_list_checksum:recordListChecksum,
    index_version:indexVersion,
    approved_record_ids:approvedRecordIds,
    effective_at:payload.effective_at || now,
    expires_at:payload.expires_at || null,
    manifest:{
      schema_version:"huamei.knowledge.release-draft.v1",
      tenant_id:tenantId,
      package_version:packageVersion,
      package_checksum:packageChecksum,
      approved_record_list_sha256:recordListChecksum,
      index_version:indexVersion,
      approved_record_count:approvedRecordIds.length,
      created_at:now,
      created_by:reviewer.subject
    }
  };
  return requirePostgresWorkflow().createDraft({ release, actor:reviewer.subject });
}

export async function getKnowledgeReviewScope(tenantId, releaseId) {
  return requirePostgresWorkflow().getReviewScope({ tenantId:normalizeTenantId(tenantId), releaseId:String(releaseId || "") });
}

export async function submitKnowledgeReview({ tenant_id:tenantId, release_id:releaseId, review_type:reviewType, decision, comments, scope_checksum:scopeChecksum } = {}, identity = {}) {
  const tenant = normalizeTenantId(tenantId);
  const normalizedType = String(reviewType || "").trim().toLowerCase();
  if (!["business", "medical", "compliance"].includes(normalizedType)) {
    const error = new Error("审核类型必须为business、medical或compliance");
    error.code = "KNOWLEDGE_REVIEW_TYPE_INVALID";
    throw error;
  }
  requireIdentityRole(identity, `knowledge.${normalizedType}_reviewer`);
  return requirePostgresWorkflow().submitReview({
    tenantId:tenant,
    releaseId:String(releaseId || "").trim(),
    reviewType:normalizedType,
    decision:String(decision || "").trim().toLowerCase(),
    identity,
    comments,
    scopeChecksum:String(scopeChecksum || "").trim().toLowerCase()
  });
}

export async function getKnowledgeReleaseReceipt(tenantId, releaseId) {
  return requirePostgresWorkflow().releaseReceipt({ tenantId:normalizeTenantId(tenantId), releaseId:String(releaseId || "").trim() });
}

export async function attachKnowledgeIndex({ tenant_id:tenantId, release_id:releaseId, index_checksum:indexChecksum, manifest } = {}, identity = {}) {
  const actor = requireIdentityRole(identity, "knowledge.index_manager");
  if (!validSha256(indexChecksum) || !manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    const error = new Error("索引绑定需要正式GraphRAG manifest及其SHA-256");
    error.code = "KNOWLEDGE_INDEX_BINDING_INVALID";
    throw error;
  }
  return requirePostgresWorkflow().attachIndex({
    tenantId:normalizeTenantId(tenantId),
    releaseId:String(releaseId || "").trim(),
    indexChecksum:String(indexChecksum).trim().toLowerCase(),
    manifest,
    actor:actor.subject
  });
}

export async function activateKnowledgeRelease({ tenant_id:tenantId, release_id:releaseId } = {}, identity = {}) {
  requireIdentityRole(identity, "knowledge.publisher");
  return requirePostgresWorkflow().activate({
    tenantId:normalizeTenantId(tenantId),
    releaseId:String(releaseId || "").trim(),
    identity
  });
}

export function getKnowledgeAdmissionStatus(tenantId, packageVersion = "") {
  const tenant = normalizeTenantId(tenantId);
  const release = getActiveKnowledgeRelease(tenant, packageVersion);
  return {
    tenant_id:tenant,
    mode:approvalMode(),
    ready:approvalMode() === "preview" || Boolean(release),
    active_release:release ? clone(release) : null,
    preview_warning:approvalMode() === "preview"
      ? "当前为开发预览模式，未审核资料只可用于联调，不满足正式对客发布准入。"
      : null,
    storage:postgresPersistenceEnabled() ? getPostgresKnowledgeReleaseStore().status(tenant) : store.status()
  };
}

export function listKnowledgeReleases(tenantId) {
  const tenant = normalizeTenantId(tenantId);
  return postgresPersistenceEnabled()
    ? getPostgresKnowledgeReleaseStore().list(tenant)
    : store.load().releases.filter((item) => item.tenant_id === tenant).map(clone);
}

export function resetKnowledgeReleasesForTest() {
  store.reset();
}
