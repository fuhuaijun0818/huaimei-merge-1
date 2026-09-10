import { createHash, randomUUID } from "node:crypto";
import { createJsonStateStore } from "./platform/json-state-store.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";
import { postgresPersistenceEnabled } from "./persistence/postgres-helpers.mjs";
import { getPostgresOperationsStore } from "./persistence/postgres-operations-store.mjs";
import { getObservability } from "./observability/index.mjs";
import { redactContactPii } from "./platform/contact-pii-redaction.mjs";

const initialState = { version:1, handovers:[], tasks:[], events:[], human_work_logs:[] };
const store = createJsonStateStore({
  envName:"HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE",
  defaultFile:".local-data/acquisition-operations.json",
  initialState
});
const handoverObservability = getObservability({
  service:process.env.HUAMEI_SERVICE_NAME || "huamei-acquisition",
  environment:process.env.HUAMEI_RUNTIME_ENV || process.env.NODE_ENV || "development"
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const nowIso = () => new Date().toISOString();
const safeText = (value, limit = 500) => redactContactPii(String(value || ""))
  .replace(/\b\d{15,18}[0-9Xx]\b/g, "[证件号已脱敏]")
  .trim()
  .slice(0, limit);
const messagePayloadHash = (value) => createHash("sha256").update(String(value || "")).digest("hex");
const completionPayloadHash = ({ actor, resolution, minutes, notes }) => createHash("sha256")
  .update(JSON.stringify({ actor, resolution, minutes, notes }))
  .digest("hex");
const publicHumanWorkLog = (log) => {
  if (!log) return null;
  const { completion_payload_hash:ignored, notes:privateNotes, ...safeLog } = log;
  return clone(safeLog);
};

const normalizeCompletionWork = (payload = {}) => {
  const tenantId = normalizeTenantId(payload.tenant_id);
  const actor = safeText(payload.actor, 80);
  const resolution = safeText(payload.resolution || "resolved", 200);
  const notes = safeText(payload.notes, 500);
  const minutes = Number(payload.minutes);
  if (!actor) {
    const error = new Error("完结接管必须绑定实名操作人");
    error.code = "HANDOVER_ACTOR_REQUIRED";
    throw error;
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1_440) {
    const error = new Error("人工付出时间必须是0–1440之间的分钟数");
    error.code = "INVALID_HUMAN_WORK_MINUTES";
    throw error;
  }
  const roundedMinutes = Number(minutes.toFixed(2));
  return {
    tenant_id:tenantId,
    actor,
    resolution,
    notes,
    minutes:roundedMinutes,
    work_type:"handover_completion",
    completion_payload_hash:completionPayloadHash({ actor, resolution, minutes:roundedMinutes, notes })
  };
};

const openStatuses = new Set(["pending", "claimed", "active"]);
const priorityFor = (reason) => ["medical_emergency", "critical_risk_continuity"].includes(reason) ? "urgent" : "high";
const slaMinutesFor = (reason) => ["medical_emergency", "critical_risk_continuity"].includes(reason) ? 1 : 10;
const recordHandoverMetric = (event, handover) => {
  if (!handover) return handover;
  handoverObservability.recordHandover({ event, reason:handover.reason || "other" });
  if (event === "claimed" && handover.claimed_at && handover.sla_due_at
    && Date.parse(handover.claimed_at) > Date.parse(handover.sla_due_at)) {
    handoverObservability.recordHandover({ event:"sla_breached", reason:handover.reason || "other" });
  }
  return handover;
};
const observeAsyncHandover = (operation, event) => Promise.resolve(operation)
  .then((handover) => recordHandoverMetric(event, handover));

const persistEvent = (state, event) => {
  state.events.unshift(event);
  state.events = state.events.slice(0, 5_000);
};

export function findOpenHandover({ tenant_id, channel, conversation_id }) {
  const tenantId = normalizeTenantId(tenant_id);
  if (postgresPersistenceEnabled()) {
    return getPostgresOperationsStore().findOpenHandover({ tenantId, channel, conversationId:conversation_id });
  }
  return clone(store.load().handovers.find((item) => item.tenant_id === tenantId
    && item.channel === channel
    && item.conversation_id === conversation_id
    && openStatuses.has(item.status)) || null);
}

export function ensureHandoverTask({ envelope, result, session_snapshot = {}, contact_initiation = "proactive" }) {
  if (result?.handover?.required !== true && result?.status !== "handover_required") return null;
  if (postgresPersistenceEnabled()) {
    return observeAsyncHandover(
      getPostgresOperationsStore().ensureHandoverTask({
        envelope,
        result,
        sessionSnapshot:session_snapshot,
        safeText,
        contactInitiation:contact_initiation
      }),
      "requested"
    );
  }
  const state = store.load();
  const tenantId = normalizeTenantId(envelope.tenant_id);
  const existing = state.handovers.find((item) => item.tenant_id === tenantId
    && item.channel === envelope.channel
    && item.conversation_id === envelope.conversation_id
    && openStatuses.has(item.status));
  if (existing) return clone(existing);
  const now = nowIso();
  const reason = result?.handover?.reason || "human_requested";
  const priority = priorityFor(reason);
  const slaMinutes = slaMinutesFor(reason);
  const handoverId = `ho_${randomUUID()}`;
  const taskId = `task_${randomUUID()}`;
  const handover = {
    id:handoverId,
    task_id:taskId,
    tenant_id:tenantId,
    channel:envelope.channel,
    conversation_id:envelope.conversation_id,
    external_user_id:envelope.actor?.external_user_id || null,
    customer_id:envelope.actor?.customer_id || null,
    trigger_message_id:envelope.message.id,
    team:result?.handover?.to_team || "人工咨询",
    reason,
    priority,
    status:"pending",
    ai_suspended:false,
    summary:safeText(session_snapshot.conversation_summary || envelope.message.text),
    known_slots:clone(session_snapshot.known_slots || {}),
    slot_sources:clone(session_snapshot.slot_sources || {}),
    projects:clone(session_snapshot.projects || []),
    doctors:clone(session_snapshot.doctors || []),
    pending_fields:clone(session_snapshot.pending_fields || []),
    conversation_goal:clone(session_snapshot.conversation_goal || {}),
    active_critical_risk:clone(session_snapshot.active_critical_risk || null),
    last_intent:session_snapshot.last_intent || null,
    created_at:now,
    sla_due_at:new Date(Date.now() + slaMinutes * 60_000).toISOString(),
    claimed_at:null,
    completed_at:null,
    assignee:null
  };
  const task = {
    id:taskId,
    tenant_id:tenantId,
    type:"human_handover",
    handover_id:handoverId,
    title:`${priority === "urgent" ? "紧急" : "售前"}人工接管：${reason}`,
    team:handover.team,
    priority,
    status:"pending",
    due_at:handover.sla_due_at,
    created_at:now,
    updated_at:now
  };
  state.handovers.unshift(handover);
  state.tasks.unshift(task);
  persistEvent(state, {
    id:`evt_${randomUUID()}`, tenant_id:tenantId, type:"handover.requested",
    handover_id:handoverId, task_id:taskId, channel:envelope.channel,
    conversation_id:envelope.conversation_id, reason, priority, at:now
  });
  state.handovers = state.handovers.slice(0, 2_000);
  state.tasks = state.tasks.slice(0, 5_000);
  store.save(state);
  return recordHandoverMetric("requested", clone(handover));
}

export function claimHandover(handoverId, { tenant_id, assignee }) {
  const tenantId = normalizeTenantId(tenant_id);
  const actor = safeText(assignee, 80);
  if (!actor) {
    const error = new Error("接管任务必须指定assignee");
    error.code = "HANDOVER_ASSIGNEE_REQUIRED";
    throw error;
  }
  if (postgresPersistenceEnabled()) {
    return observeAsyncHandover(
      getPostgresOperationsStore().claimHandover({ handoverId, tenantId, assignee:actor }),
      "claimed"
    );
  }
  const state = store.load();
  const index = state.handovers.findIndex((item) => item.id === handoverId && item.tenant_id === tenantId);
  if (index < 0) return null;
  const current = state.handovers[index];
  if (["active", "claimed"].includes(current.status)) {
    if (current.assignee === actor) return clone(current);
    const error = new Error("该转人工任务已由其他顾问接管");
    error.code = "HANDOVER_ALREADY_CLAIMED";
    throw error;
  }
  if (current.status !== "pending") {
    const error = new Error("该转人工任务已结束，不能再次接管");
    error.code = "HANDOVER_ALREADY_CLOSED";
    throw error;
  }
  const now = nowIso();
  state.handovers[index] = { ...current, status:"active", ai_suspended:true, assignee:actor, claimed_at:current.claimed_at || now, updated_at:now };
  state.tasks = state.tasks.map((item) => item.handover_id === handoverId ? { ...item, status:"active", assignee:actor, updated_at:now } : item);
  persistEvent(state, { id:`evt_${randomUUID()}`, tenant_id:tenantId, type:"handover.claimed", handover_id:handoverId, assignee:actor, at:now });
  store.save(state);
  return recordHandoverMetric("claimed", clone(state.handovers[index]));
}

export function completeHandover(handoverId, { tenant_id, actor, resolution = "resolved" }) {
  const tenantId = normalizeTenantId(tenant_id);
  const safeActor = safeText(actor, 80);
  const safeResolution = safeText(resolution, 200);
  if (postgresPersistenceEnabled()) {
    return observeAsyncHandover(
      getPostgresOperationsStore().completeHandover({
        handoverId, tenantId, actor:safeActor, resolution:safeResolution
      }),
      "completed"
    );
  }
  const state = store.load();
  const index = state.handovers.findIndex((item) => item.id === handoverId && item.tenant_id === tenantId);
  if (index < 0) return null;
  const current = state.handovers[index];
  if (current.status === "completed") {
    if (safeActor && safeActor === current.assignee) return clone(current);
    const error = new Error("只有当前接管顾问可以完成该任务");
    error.code = "HANDOVER_ASSIGNEE_MISMATCH";
    throw error;
  }
  if (!["active", "claimed"].includes(current.status) || !current.assignee) {
    const error = new Error("转人工任务必须先被顾问接管后才能完成");
    error.code = "HANDOVER_NOT_CLAIMED";
    throw error;
  }
  if (!safeActor || safeActor !== current.assignee) {
    const error = new Error("只有当前接管顾问可以完成该任务");
    error.code = "HANDOVER_ASSIGNEE_MISMATCH";
    throw error;
  }
  const now = nowIso();
  state.handovers[index] = {
    ...current, status:"completed", ai_suspended:false, completed_at:now,
    completed_by:safeActor, resolution:safeResolution, updated_at:now
  };
  state.tasks = state.tasks.map((item) => item.handover_id === handoverId ? { ...item, status:"completed", updated_at:now } : item);
  persistEvent(state, { id:`evt_${randomUUID()}`, tenant_id:tenantId, type:"handover.completed", handover_id:handoverId, resolution:safeResolution, at:now });
  store.save(state);
  return recordHandoverMetric("completed", clone(state.handovers[index]));
}

// Completing a handover and recording the effort that made it complete are one
// business operation. The JSON implementation performs a single synchronous
// state save; production delegates to one PostgreSQL transaction. A retry with
// the same normalized payload returns the original result, while a different
// payload is rejected so completed work cannot be silently rewritten.
export function completeHandoverWithWork(handoverId, payload = {}) {
  const normalized = normalizeCompletionWork(payload);
  if (postgresPersistenceEnabled()) {
    return getPostgresOperationsStore().completeHandoverWithWork({
      handoverId,
      tenantId:normalized.tenant_id,
      actor:normalized.actor,
      resolution:normalized.resolution,
      notes:normalized.notes,
      minutes:normalized.minutes,
      workType:normalized.work_type,
      completionPayloadHash:normalized.completion_payload_hash,
      safeText
    }).then((result) => result ? {
      ...result,
      handover:recordHandoverMetric(result.replayed ? "completion_replayed" : "completed", result.handover)
    } : null);
  }

  const state = store.load();
  const index = state.handovers.findIndex((item) => item.id === handoverId && item.tenant_id === normalized.tenant_id);
  if (index < 0) return null;
  const current = state.handovers[index];
  if (current.status === "completed") {
    if (current.assignee !== normalized.actor) {
      const error = new Error("只有当前接管顾问可以完成该任务");
      error.code = "HANDOVER_ASSIGNEE_MISMATCH";
      throw error;
    }
    const existingWork = state.human_work_logs.find((item) => item.tenant_id === normalized.tenant_id
      && item.handover_id === handoverId
      && item.work_type === "handover_completion");
    if (!existingWork) {
      const error = new Error("该任务曾通过旧流程完结，需由运营负责人补录并复核工时");
      error.code = "HANDOVER_COMPLETION_WORK_MISSING";
      throw error;
    }
    if (existingWork.completion_payload_hash !== normalized.completion_payload_hash) {
      const error = new Error("该接管任务已经按另一组处理结果和工时完结");
      error.code = "HANDOVER_COMPLETION_PAYLOAD_MISMATCH";
      throw error;
    }
    return {
      handover:clone(current),
      human_work:publicHumanWorkLog(existingWork),
      replayed:true
    };
  }
  if (!["active", "claimed"].includes(current.status) || !current.assignee) {
    const error = new Error("转人工任务必须先被顾问接管后才能完成");
    error.code = "HANDOVER_NOT_CLAIMED";
    throw error;
  }
  if (current.assignee !== normalized.actor) {
    const error = new Error("只有当前接管顾问可以完成该任务");
    error.code = "HANDOVER_ASSIGNEE_MISMATCH";
    throw error;
  }

  const now = nowIso();
  const work = {
    id:`work_${randomUUID()}`,
    tenant_id:normalized.tenant_id,
    conversation_id:safeText(current.conversation_id, 128),
    handover_id:handoverId,
    staff_id:normalized.actor,
    work_type:normalized.work_type,
    minutes:normalized.minutes,
    notes:normalized.notes,
    completion_payload_hash:normalized.completion_payload_hash,
    occurred_at:now,
    created_at:now
  };
  state.handovers[index] = {
    ...current,
    status:"completed",
    ai_suspended:false,
    completed_at:now,
    completed_by:normalized.actor,
    resolution:normalized.resolution,
    completion_work_id:work.id,
    updated_at:now
  };
  state.tasks = state.tasks.map((item) => item.handover_id === handoverId
    ? { ...item, status:"completed", updated_at:now }
    : item);
  state.human_work_logs.unshift(work);
  state.human_work_logs = state.human_work_logs.slice(0, 20_000);
  persistEvent(state, {
    id:`evt_${randomUUID()}`,
    tenant_id:normalized.tenant_id,
    type:"handover.completed_with_work",
    handover_id:handoverId,
    work_log_id:work.id,
    minutes:work.minutes,
    resolution:normalized.resolution,
    at:now
  });
  store.save(state);
  return {
    handover:recordHandoverMetric("completed", clone(state.handovers[index])),
    human_work:publicHumanWorkLog(work),
    replayed:false
  };
}

export function recordInboundDuringHandover(handover, envelope) {
  if (postgresPersistenceEnabled()) {
    return getPostgresOperationsStore().recordInbound(handover, envelope, safeText);
  }
  const state = store.load();
  const payloadHash = messagePayloadHash(envelope.message.text);
  const existing = state.events.find((item) => item.tenant_id === handover.tenant_id
    && item.type === "handover.inbound_received"
    && item.handover_id === handover.id
    && item.message_id === envelope.message.id);
  if (existing) {
    const legacyPreviewMatches = !existing.payload_hash
      && existing.message_preview === safeText(envelope.message.text, 160);
    if (existing.payload_hash !== payloadHash && !legacyPreviewMatches) {
      const error = new Error("同一渠道消息ID不能用于不同的消息内容");
      error.code = "CONVERSATION_MESSAGE_ID_REUSED";
      throw error;
    }
    return clone(existing);
  }
  const event = {
    id:`evt_${randomUUID()}`, tenant_id:handover.tenant_id, type:"handover.inbound_received",
    handover_id:handover.id, channel:envelope.channel, conversation_id:envelope.conversation_id,
    message_id:envelope.message.id, payload_hash:payloadHash,
    message_preview:safeText(envelope.message.text, 160), at:nowIso()
  };
  persistEvent(state, event);
  store.save(state);
  return clone(event);
}

export function recordHumanWork(payload = {}) {
  const tenantId = normalizeTenantId(payload.tenant_id);
  const minutes = Number(payload.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1_440) {
    const error = new Error("人工付出时间必须是0–1440之间的分钟数");
    error.code = "INVALID_HUMAN_WORK_MINUTES";
    throw error;
  }
  const normalized = {
    ...payload,
    tenant_id:tenantId,
    conversation_id:safeText(payload.conversation_id, 128),
    handover_id:safeText(payload.handover_id, 128) || null,
    staff_id:safeText(payload.staff_id, 80),
    work_type:safeText(payload.work_type || "presales_service", 80),
    minutes:Number(minutes.toFixed(2))
  };
  if (!normalized.conversation_id || !normalized.staff_id) {
    const error = new Error("人工工时记录必须包含conversation_id和staff_id");
    error.code = "HUMAN_WORK_LOG_INVALID";
    throw error;
  }
  if (postgresPersistenceEnabled()) {
    return getPostgresOperationsStore().recordHumanWork(normalized, safeText);
  }
  const state = store.load();
  const log = {
    id:`work_${randomUUID()}`, tenant_id:tenantId,
    conversation_id:normalized.conversation_id, handover_id:normalized.handover_id,
    staff_id:normalized.staff_id, work_type:normalized.work_type,
    minutes:normalized.minutes, occurred_at:payload.occurred_at || nowIso(), created_at:nowIso()
  };
  state.human_work_logs.unshift(log);
  state.human_work_logs = state.human_work_logs.slice(0, 20_000);
  persistEvent(state, { id:`evt_${randomUUID()}`, tenant_id:tenantId, type:"human_work.recorded", work_log_id:log.id, conversation_id:log.conversation_id, minutes:log.minutes, at:log.created_at });
  store.save(state);
  return clone(log);
}

export function listHandovers({ tenant_id, status = "", limit = 100 } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  if (postgresPersistenceEnabled()) {
    return getPostgresOperationsStore().listHandovers({ tenantId, status, limit });
  }
  return store.reload().handovers
    .filter((item) => item.tenant_id === tenantId && (!status || item.status === status))
    .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500)).map(clone);
}

export function getHandover(handoverId, tenantId) {
  const tenant = normalizeTenantId(tenantId);
  if (postgresPersistenceEnabled()) {
    return getPostgresOperationsStore().getHandover({ tenantId:tenant, handoverId });
  }
  return clone(store.load().handovers.find((item) => item.id === handoverId && item.tenant_id === tenant) || null);
}

export function listOperationTasks({ tenant_id, status = "", limit = 100 } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  if (postgresPersistenceEnabled()) {
    return getPostgresOperationsStore().listTasks({ tenantId, status, limit });
  }
  return store.load().tasks
    .filter((item) => item.tenant_id === tenantId && (!status || item.status === status))
    .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500)).map(clone);
}

export function getOperationsMetrics(tenantId) {
  const tenant = normalizeTenantId(tenantId);
  if (postgresPersistenceEnabled()) return getPostgresOperationsStore().metrics(tenant);
  const state = store.load();
  const handovers = state.handovers.filter((item) => item.tenant_id === tenant);
  const workLogs = state.human_work_logs.filter((item) => item.tenant_id === tenant);
  const completed = handovers.filter((item) => item.status === "completed");
  const acceptedWithinSla = handovers.filter((item) => item.claimed_at && Date.parse(item.claimed_at) <= Date.parse(item.sla_due_at));
  return {
    tenant_id:tenant,
    handovers_total:handovers.length,
    handovers_open:handovers.filter((item) => openStatuses.has(item.status)).length,
    handovers_completed:completed.length,
    forced_handover_sla_recall:handovers.length ? Number((acceptedWithinSla.length / handovers.length).toFixed(4)) : null,
    human_work_minutes:Number(workLogs.reduce((sum, item) => sum + item.minutes, 0).toFixed(2)),
    human_work_records:workLogs.length,
    measurement_note:"需与同口径基线、服务量和连续4周数据结合，才能计算人均客户付出时间下降比例。",
    storage:store.status()
  };
}

export function getOperationsStoreStatus(tenantId) {
  if (postgresPersistenceEnabled()) return getPostgresOperationsStore().status(normalizeTenantId(tenantId));
  const state = store.load();
  return { ...store.status(), handovers:state.handovers.length, tasks:state.tasks.length, events:state.events.length, human_work_logs:state.human_work_logs.length };
}

export function resetOperationsStoreForTest() {
  store.reset();
}
