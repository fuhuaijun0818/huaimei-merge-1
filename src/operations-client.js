import { expireAdminSession } from "./admin-session.js";
const requestHeaders = ({ json = false, idempotencyKey = "" } = {}) => {
  return {
    Accept:"application/json",
    ...(json ? { "Content-Type":"application/json" } : {}),
    ...(idempotencyKey ? { "Idempotency-Key":idempotencyKey } : {})
  };
};

const managementRequest = async (path, options = {}) => {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials:"same-origin",
      cache:"no-store"
    });
  } catch (cause) {
    const error = new Error("网络连接中断或本地服务不可用，资料未完成上传，请恢复后重试");
    error.code = "MANAGEMENT_NETWORK_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }
  let body = {};
  try { body = await response.json(); } catch {}
  if (response.ok) return body;
  if (response.status === 401) expireAdminSession();
  const error = new Error(body.error?.message || "人工接管服务当前不可用");
  error.code = body.error?.code || "MANAGEMENT_REQUEST_FAILED";
  error.status = response.status;
  error.details = body.error?.details || [];
  throw error;
};

const operationKeys = new Map();
const idempotencyKey = (action, id) => {
  const logicalOperation = `${action}:${id}`;
  if (!operationKeys.has(logicalOperation)) {
    operationKeys.set(logicalOperation, `${action}-${id}-${crypto.randomUUID()}`.slice(0, 128));
  }
  return operationKeys.get(logicalOperation);
};
const acknowledgeOperation = (action, id) => operationKeys.delete(`${action}:${id}`);

// The management application never treats browser storage as its source of
// truth. These two calls hydrate and persist the compact server-side operator
// overlay while the signed knowledge import stays immutable in the bundle.
export async function getManagementDomainOverlay() {
  const body = await managementRequest("/api/admin/management/domain-overlay", {
    headers:requestHeaders()
  });
  return body.data || null;
}

export async function listManagementAcquisitionChannels() {
  const body = await managementRequest("/api/local/acquisition-channels", {
    headers:requestHeaders()
  });
  return Array.isArray(body.data) ? body.data : [];
}

export async function saveManagementDomainOverlay({ revision, overlay } = {}) {
  const operationId = String(revision ?? "unknown");
  const body = await managementRequest("/api/admin/management/domain-overlay", {
    method:"PUT",
    headers:requestHeaders({ json:true, idempotencyKey:idempotencyKey("management-overlay", operationId) }),
    body:JSON.stringify({ revision, overlay })
  });
  acknowledgeOperation("management-overlay", operationId);
  return { record:body.data, replayed:body.meta?.replayed === true };
}

export async function listManagementHandovers({ status = "", limit = 100 } = {}) {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  query.set("limit", String(Math.min(Math.max(Number(limit) || 100, 1), 500)));
  const body = await managementRequest(`/api/admin/acquisition/handovers?${query}`, {
    headers:requestHeaders()
  });
  return Array.isArray(body.data) ? body.data : [];
}

export async function sendManagementConversationReply(conversationId, text, { handoverVersion = "", idempotencyKey = "" } = {}) {
  const id = String(conversationId || "").trim();
  const requestKey = String(idempotencyKey || `reply-${id}-${crypto.randomUUID()}`).trim().slice(0, 128);
  const body = await managementRequest(`/api/admin/acquisition/conversations/${encodeURIComponent(id)}/reply`, {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:requestKey }),
    body:JSON.stringify({
      text:String(text || "").trim().slice(0, 4000),
      handover_version:String(handoverVersion || "").trim()
    })
  });
  return body.data;
}

export async function getManagementConversationReadReceipts() {
  const body = await managementRequest("/api/admin/acquisition/conversation-read-receipts", { headers:requestHeaders() });
  return body.data || {};
}

export async function saveManagementConversationReadReceipt(conversationId, messageIds) {
  const id = String(conversationId || "").trim();
  if (!id) return null;
  const body = await managementRequest(`/api/admin/acquisition/conversations/${encodeURIComponent(id)}/read-receipt`, {
    method:"POST",
    headers:requestHeaders({ json:true }),
    body:JSON.stringify({ message_ids:Array.isArray(messageIds) ? messageIds.slice(-200) : [] })
  });
  return body.data || null;
}

export async function updateManagementCustomerProfile(customerId, { expectedVersion, patch } = {}) {
  const id = String(customerId || "").trim();
  if (!id) throw new Error("客户编号不能为空");
  const body = await managementRequest(`/api/admin/acquisition/customers/${encodeURIComponent(id)}`, {
    method:"PATCH",
    headers:requestHeaders({ json:true, idempotencyKey:`customer-profile-${id}-${crypto.randomUUID()}`.slice(0, 128) }),
    body:JSON.stringify({ expected_version:expectedVersion, patch:patch || {} })
  });
  return body.data;
}

export async function recheckManagementCustomerMemberCheck(customerId) {
  const id = String(customerId || "").trim();
  if (!id) throw new Error("客户编号不能为空");
  const body = await managementRequest(`/api/admin/acquisition/customers/${encodeURIComponent(id)}/member-check`, {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:`member-recheck-${id}-${crypto.randomUUID()}`.slice(0, 128) }),
    body:JSON.stringify({})
  });
  return body.data;
}

export async function listManagementBadCases({ status = "", limit = 100 } = {}) {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  query.set("limit", String(Math.min(Math.max(Number(limit) || 100, 1), 500)));
  const body = await managementRequest(`/api/admin/acquisition/bad-cases?${query}`, {
    headers:requestHeaders()
  });
  return Array.isArray(body.data) ? body.data : [];
}

export async function reviewManagementBadCase(feedbackId, { status, note = "" } = {}) {
  const body = await managementRequest(`/api/admin/acquisition/bad-cases/${encodeURIComponent(feedbackId)}/review`, {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:idempotencyKey("bad-case-review", feedbackId) }),
    body:JSON.stringify({ status, note:String(note || "").trim().slice(0, 500) })
  });
  acknowledgeOperation("bad-case-review", feedbackId);
  return { feedback:body.data, replayed:body.meta?.replayed === true };
}

export async function claimManagementHandover(handoverId) {
  const body = await managementRequest(`/api/admin/acquisition/handovers/${encodeURIComponent(handoverId)}/claim`, {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:idempotencyKey("claim", handoverId) }),
    body:"{}"
  });
  acknowledgeOperation("claim", handoverId);
  return body.data;
}

export async function completeManagementHandoverWithWork(handoverId, { resolution, minutes, notes = "" }) {
  const payload = {
    resolution:String(resolution || "resolved").trim().slice(0, 200),
    minutes:Number(minutes),
    notes:String(notes || "").trim().slice(0, 500)
  };
  const body = await managementRequest(`/api/admin/acquisition/handovers/${encodeURIComponent(handoverId)}/complete`, {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:idempotencyKey("complete-with-work", handoverId) }),
    body:JSON.stringify(payload)
  });
  acknowledgeOperation("complete-with-work", handoverId);
  return body.data;
}

export async function revealManagementHandoverContact(handoverId) {
  // Deliberately generate a new one-time request id per explicit click. The
  // revealed value is returned to the caller only; this module never caches it
  // in browser storage or the operation-key map.
  const revealRequestId = `contact-reveal-${crypto.randomUUID()}`.slice(0, 128);
  const body = await managementRequest(
    `/api/admin/acquisition/handovers/${encodeURIComponent(handoverId)}/contact-reveal`,
    {
      method:"POST",
      headers:requestHeaders({ json:true, idempotencyKey:revealRequestId }),
      body:"{}"
    }
  );
  return body.data;
}

export async function recordManagementHumanWork({ conversationId, handoverId, minutes, notes = "" }) {
  const payload = {
    conversation_id:String(conversationId || "").trim().slice(0, 128),
    handover_id:String(handoverId || "").trim().slice(0, 128),
    work_type:"presales_service",
    minutes:Number(minutes),
    notes:String(notes || "").trim().slice(0, 500)
  };
  const body = await managementRequest("/api/admin/acquisition/human-work", {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:idempotencyKey("work", handoverId || conversationId) }),
    body:JSON.stringify(payload)
  });
  acknowledgeOperation("work", handoverId || conversationId);
  return body.data;
}

export async function getManagementKnowledgeGovernance() {
  const body = await managementRequest("/api/admin/knowledge/governance", {
    headers:requestHeaders()
  });
  return body.data || null;
}

export async function listManagementKnowledgeIntakeDocuments({ department = "", status = "", contentType = "", publicScope = "", query:searchQuery = "", validOn = "", limit = 100 } = {}) {
  const query = new URLSearchParams({ limit:String(Math.min(Math.max(Number(limit) || 100, 1), 500)) });
  if (department) query.set("department", department);
  if (status) query.set("status", status);
  if (contentType) query.set("content_type", contentType);
  if (publicScope) query.set("public_scope", publicScope);
  if (searchQuery) query.set("q", String(searchQuery).trim().slice(0, 120));
  if (validOn) query.set("valid_on", validOn);
  const body = await managementRequest(`/api/admin/knowledge/intake/documents?${query}`, { headers:requestHeaders() });
  return Array.isArray(body.data) ? body.data : [];
}

export async function createManagementKnowledgeIntakeDocument(payload = {}) {
  const fingerprint = await knowledgeOperationFingerprint(payload);
  const body = await managementRequest("/api/admin/knowledge/intake/documents", {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:idempotencyKey("knowledge-intake-create", fingerprint) }),
    body:JSON.stringify({
      source_filename:String(payload.source_filename || "").slice(0, 160),
      department:String(payload.department || "").slice(0, 80),
      content_type:String(payload.content_type || "").slice(0, 40),
      owner:String(payload.owner || "").slice(0, 80),
      tags:Array.isArray(payload.tags) ? payload.tags.map((item) => String(item).slice(0, 80)).slice(0, 12) : [],
      effective_at:payload.effective_at || "",
      expires_at:payload.expires_at || "",
      source_reference:payload.source_reference || "",
      applicable_campuses:payload.applicable_campuses || [],
      public_scope:payload.public_scope || "internal",
      customer_facing_candidate:payload.customer_facing_candidate === true,
      text_content:String(payload.text_content || "")
    })
  });
  acknowledgeOperation("knowledge-intake-create", fingerprint);
  return { document:body.data, replayed:body.meta?.replayed === true, duplicate:body.meta?.duplicate === true };
}

async function knowledgeOperationFingerprint(payload) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getManagementKnowledgeIntakeDocument(documentId) {
  const body = await managementRequest(`/api/admin/knowledge/intake/documents/${encodeURIComponent(documentId)}`, { headers:requestHeaders() });
  return body.data;
}

export async function mutateManagementKnowledgeIntakeDocument(documentId, action, payload) {
  if (!["edit", "confirmation", "candidate"].includes(action)) throw new Error("不支持的资料操作");
  const fingerprint = await knowledgeOperationFingerprint({ documentId, action, payload });
  const operation = `knowledge-intake-${action}`;
  const body = await managementRequest(`/api/admin/knowledge/intake/documents/${encodeURIComponent(documentId)}${action === "edit" ? "" : `/${action}`}`, {
    method:"POST", headers:requestHeaders({ json:true, idempotencyKey:idempotencyKey(operation, fingerprint) }), body:JSON.stringify(payload)
  });
  acknowledgeOperation(operation, fingerprint);
  return body.data;
}

const knowledgeAssetMime = (file) => {
  const filename = String(file?.name || "").toLowerCase();
  const extension = filename.split(".").pop();
  const inferred = {
    txt:"text/plain", md:"text/markdown", markdown:"text/markdown", csv:"text/csv", json:"application/json",
    pdf:"application/pdf", docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp"
  }[extension];
  return inferred || String(file?.type || "").split(";")[0].toLowerCase();
};

// The browser only streams the original file after the server has created a
// tenant-scoped, immutable upload reservation. It never turns source material
// into a knowledge record locally.
export async function uploadManagementKnowledgeIntakeAsset({ file, ...metadata } = {}) {
  if (!(file instanceof File)) throw new Error("请选择需要入库的原始素材");
  const fingerprint = await knowledgeOperationFingerprint({ name:file.name, size:file.size, lastModified:file.lastModified, metadata });
  const prepareKey = idempotencyKey("knowledge-asset-prepare", fingerprint);
  const completeKey = idempotencyKey("knowledge-asset-complete", fingerprint);
  const payload = {
    source_filename:String(file.name || "").slice(0, 160),
    mime:knowledgeAssetMime(file),
    size:Number(file.size),
    department:String(metadata.department || "").slice(0, 80),
    content_type:String(metadata.content_type || "").slice(0, 40),
    owner:String(metadata.owner || "").slice(0, 80),
    tags:Array.isArray(metadata.tags) ? metadata.tags.map((item) => String(item).slice(0, 80)).slice(0, 12) : [],
    effective_at:metadata.effective_at || "",
    expires_at:metadata.expires_at || "",
    source_reference:metadata.source_reference || "",
    applicable_campuses:metadata.applicable_campuses || [],
    public_scope:metadata.public_scope || "internal",
    customer_facing_candidate:metadata.customer_facing_candidate === true
  };
  const prepared = await managementRequest("/api/admin/knowledge/intake/assets/prepare", {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:prepareKey }),
    body:JSON.stringify(payload)
  });
  const asset = prepared.data;
  if (!asset?.upload_url) throw new Error("原始素材上传会话无效，请重新选择文件");
  await managementRequest(asset.upload_url, {
    method:"PUT",
    headers:{ Accept:"application/json", "Content-Type":payload.mime },
    body:file
  });
  const completed = await managementRequest(`/api/admin/knowledge/intake/assets/${encodeURIComponent(asset.id)}/complete`, {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:completeKey }),
    body:"{}"
  });
  acknowledgeOperation("knowledge-asset-prepare", fingerprint);
  acknowledgeOperation("knowledge-asset-complete", fingerprint);
  return { document:completed.data, replayed:completed.meta?.replayed === true, duplicate:completed.meta?.duplicate === true };
}

export async function listManagementAppointmentIntakes({ status = "", followupStatus = "", preferredDate = "", assignee = "", limit = 100 } = {}) {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (followupStatus) query.set("followup_status", followupStatus);
  if (preferredDate) query.set("preferred_date", preferredDate);
  if (assignee) query.set("assignee", assignee);
  query.set("limit", String(Math.min(Math.max(Number(limit) || 100, 1), 500)));
  const body = await managementRequest(`/api/admin/appointment-intakes?${query}`, { headers:requestHeaders() });
  return Array.isArray(body.data) ? body.data : [];
}

export async function claimManagementAppointmentIntake(intakeId) {
  const body = await managementRequest(`/api/admin/appointment-intakes/${encodeURIComponent(intakeId)}/claim`, {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:idempotencyKey("appointment-claim", intakeId) }),
    body:"{}"
  });
  acknowledgeOperation("appointment-claim", intakeId);
  return body.data;
}

export async function resolveManagementAppointmentIntake(intakeId, { status, note = "", nextFollowupAt = "" }) {
  const body = await managementRequest(`/api/admin/appointment-intakes/${encodeURIComponent(intakeId)}/resolve`, {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:idempotencyKey("appointment-resolve", intakeId) }),
    body:JSON.stringify({ status, note:String(note || "").slice(0, 500), next_followup_at:nextFollowupAt || "" })
  });
  acknowledgeOperation("appointment-resolve", intakeId);
  return { intake:body.data, replayed:body.meta?.replayed === true };
}

export async function listManagementScheduleSlots({ from = "", limit = 100 } = {}) {
  const query = new URLSearchParams({ limit:String(Math.min(Math.max(Number(limit) || 100, 1), 500)) });
  if (from) query.set("from", from);
  const body = await managementRequest(`/api/admin/schedule-slots?${query}`, { headers:requestHeaders() });
  return Array.isArray(body.data) ? body.data : [];
}

export async function createManagementScheduleSlot(payload = {}) {
  const fingerprint = `${payload.doctor || "slot"}-${payload.starts_at || ""}`.replace(/[^a-z0-9_-]/gi, "").slice(-72) || "slot";
  const body = await managementRequest("/api/admin/schedule-slots", {
    method:"POST",
    headers:requestHeaders({ json:true, idempotencyKey:idempotencyKey("schedule-create", fingerprint) }),
    body:JSON.stringify({
      branch:String(payload.branch || "").slice(0, 80),
      department:String(payload.department || "").slice(0, 80),
      doctor:String(payload.doctor || "").slice(0, 80),
      starts_at:payload.starts_at,
      ends_at:payload.ends_at,
      capacity:Number(payload.capacity)
    })
  });
  acknowledgeOperation("schedule-create", fingerprint);
  return { slot:body.data, replayed:body.meta?.replayed === true };
}

export async function revealManagementAppointmentContact(intakeId) {
  const body = await managementRequest(`/api/admin/appointment-intakes/${encodeURIComponent(intakeId)}/contact-reveal`, {
    method:"POST", headers:requestHeaders({ json:true, idempotencyKey:`contact-reveal-${crypto.randomUUID()}` }), body:"{}", cache:"no-store"
  });
  return body.data;
}

export const getManagementIdentity = async () => (await managementRequest('/api/admin/identity')).data;
export const getManagementAccounts = async () => (await managementRequest('/api/admin/accounts')).data;
export const saveManagedAccount = async payload => (await managementRequest('/api/admin/accounts',{method:'POST',headers:requestHeaders({json:true}),body:JSON.stringify(payload)})).data;
export const getMemberIntegrationStatus = async () => (await managementRequest('/api/admin/integrations/member-check')).data;
export const getKnowledgePublications = async () => (await managementRequest('/api/admin/knowledge/publications')).data;
export const writeKnowledgePublication = async (id,action,payload,key) => (await managementRequest('/api/admin/knowledge/publications'+(id?`/${encodeURIComponent(id)}/${action}`:''),{method:'POST',headers:requestHeaders({json:true,idempotencyKey:key}),body:JSON.stringify(payload)})).data;
