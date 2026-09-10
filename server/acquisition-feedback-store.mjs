import { createHash, randomUUID } from "node:crypto";
import { createJsonStateStore } from "./platform/json-state-store.mjs";
import { redactContactPiiDeep } from "./platform/contact-pii-redaction.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";

// Customer feedback is deliberately kept apart from leads and handovers. It is
// a quality signal, not a customer profile field, and its transcript is masked
// before it is written so operations can improve the agent without exposing a
// contact number in the quality queue.
const initialState = {
  version:1,
  feedback:[],
  events:[]
};

const store = createJsonStateStore({
  envName:"HUAMEI_CONVERSATION_FEEDBACK_STORE_FILE",
  defaultFile:".local-data/conversation-feedback.json",
  initialState
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const nowIso = () => new Date().toISOString();
const clean = (value, limit = 240) => String(value || "")
  .replace(/[<>]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);
const cleanMasked = (value, limit = 1200) => clean(redactContactPiiDeep(String(value || "")), limit);
const boundedLimit = (value, fallback = 100) => Math.min(500, Math.max(1, Number(value) || fallback));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const allowedRatings = new Set(["up", "down"]);
const allowedReviewStatuses = new Set(["triaged", "included_in_eval", "dismissed"]);

const invalid = (code, message) => Object.assign(new Error(message), { code, status:400 });
const conflict = (code, message) => Object.assign(new Error(message), { code, status:409 });

const appendEvent = (state, event) => {
  state.events.unshift(event);
  state.events = state.events.slice(0, 10_000);
};

const normalizeTranscript = (value) => {
  if (!Array.isArray(value)) throw invalid("FEEDBACK_TRANSCRIPT_REQUIRED", "反馈需要关联本次对话内容");
  const transcript = value.slice(-24).map((item) => ({
    id:clean(item?.id, 160),
    role:item?.role === "assistant" ? "assistant" : "user",
    content:cleanMasked(item?.content, 1200),
    at:Number.isNaN(Date.parse(item?.at)) ? null : new Date(item.at).toISOString()
  })).filter((item) => item.content);
  if (transcript.length < 2) throw invalid("FEEDBACK_TRANSCRIPT_REQUIRED", "反馈需要关联至少两条有效对话内容");
  return transcript;
};

const publicFeedback = (item) => {
  if (!item) return null;
  const {
    review_idempotency_key:ignoredKey,
    review_payload_hash:ignoredHash,
    ...safe
  } = item;
  return clone(safe);
};

export function createConversationFeedback(payload = {}) {
  const tenantId = normalizeTenantId(payload.tenant_id);
  const channel = clean(payload.channel || "web", 32).toLowerCase() || "web";
  const conversationId = clean(payload.conversation_id, 160);
  const replyId = clean(payload.reply_id, 160);
  const rating = clean(payload.rating, 12).toLowerCase();
  const comment = cleanMasked(payload.comment, 300);
  if (!conversationId || !replyId) throw invalid("FEEDBACK_CONTEXT_REQUIRED", "反馈必须关联当前会话和回答");
  if (!allowedRatings.has(rating)) throw invalid("FEEDBACK_RATING_INVALID", "反馈类型必须为赞或踩");
  const transcript = normalizeTranscript(payload.transcript);
  const state = store.load();
  const now = nowIso();
  const index = state.feedback.findIndex((item) => item.tenant_id === tenantId
    && item.channel === channel
    && item.conversation_id === conversationId
    && item.reply_id === replyId);
  const previous = index >= 0 ? state.feedback[index] : null;
  const status = rating === "down"
    ? (previous?.status && previous.status !== "positive" ? previous.status : "new")
    : "positive";
  const next = {
    id:previous?.id || `fb_${randomUUID()}`,
    tenant_id:tenantId,
    channel,
    conversation_id:conversationId,
    reply_id:replyId,
    rating,
    is_bad_case:rating === "down",
    status,
    comment,
    transcript,
    transcript_source:"customer_visible",
    created_at:previous?.created_at || now,
    updated_at:now,
    reviewed_at:rating === "down" ? previous?.reviewed_at || null : null,
    reviewed_by:rating === "down" ? previous?.reviewed_by || null : null,
    review_note:rating === "down" ? previous?.review_note || "" : "",
    review_idempotency_key:rating === "down" ? previous?.review_idempotency_key || null : null,
    review_payload_hash:rating === "down" ? previous?.review_payload_hash || null : null
  };
  if (index >= 0) state.feedback[index] = next;
  else state.feedback.unshift(next);
  state.feedback = state.feedback.slice(0, 20_000);
  appendEvent(state, {
    id:`fbev_${randomUUID()}`,
    tenant_id:tenantId,
    type:rating === "down" ? "conversation_feedback.bad_case_reported" : "conversation_feedback.helpful_reported",
    feedback_id:next.id,
    channel,
    conversation_id:conversationId,
    reply_id:replyId,
    at:now
  });
  store.save(state);
  return { feedback:publicFeedback(next), replayed:Boolean(previous && previous.rating === rating) };
}

export function listBadCaseFeedback({ tenant_id, status = "", limit = 100 } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const requestedStatus = clean(status, 40);
  return store.load().feedback
    .filter((item) => item.tenant_id === tenantId
      && item.rating === "down"
      && (!requestedStatus || requestedStatus === "all" || item.status === requestedStatus))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
    .slice(0, boundedLimit(limit))
    .map(publicFeedback);
}

export function reviewConversationFeedback(payload = {}) {
  const tenantId = normalizeTenantId(payload.tenant_id);
  const feedbackId = clean(payload.feedback_id, 160);
  const actor = clean(payload.actor, 120);
  const status = clean(payload.status, 40);
  const note = cleanMasked(payload.note, 500);
  const idempotencyKey = clean(payload.idempotency_key, 160);
  if (!feedbackId || !actor) throw invalid("FEEDBACK_REVIEW_SCOPE_REQUIRED", "处理反馈必须绑定记录和实名操作人");
  if (!allowedReviewStatuses.has(status)) throw invalid("FEEDBACK_REVIEW_STATUS_INVALID", "反馈处理状态不正确");
  if (idempotencyKey.length < 8) throw invalid("IDEMPOTENCY_KEY_REQUIRED", "处理反馈必须提供8位以上幂等键");
  const normalized = { status, note, actor };
  const payloadHash = hash(normalized);
  const state = store.load();
  const index = state.feedback.findIndex((item) => item.id === feedbackId && item.tenant_id === tenantId);
  if (index < 0) return null;
  const current = state.feedback[index];
  if (current.rating !== "down") throw conflict("FEEDBACK_NOT_BAD_CASE", "该反馈当前不是待处理的Bad Case");
  if (current.review_idempotency_key === idempotencyKey) {
    if (current.review_payload_hash !== payloadHash) throw conflict("FEEDBACK_REVIEW_IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同处理结果");
    return { feedback:publicFeedback(current), replayed:true };
  }
  const now = nowIso();
  const next = {
    ...current,
    status,
    review_note:note,
    reviewed_by:actor,
    reviewed_at:now,
    review_idempotency_key:idempotencyKey,
    review_payload_hash:payloadHash,
    updated_at:now
  };
  state.feedback[index] = next;
  appendEvent(state, {
    id:`fbev_${randomUUID()}`,
    tenant_id:tenantId,
    type:"conversation_feedback.reviewed",
    feedback_id:feedbackId,
    actor,
    status,
    at:now
  });
  store.save(state);
  return { feedback:publicFeedback(next), replayed:false };
}

export function resetConversationFeedbackStoreForTests() {
  store.reset();
}

export function getConversationFeedbackStoreStatus() {
  return store.status();
}
