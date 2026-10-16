import { createHash, randomUUID } from "node:crypto";
import { appointmentStateTransaction, readAppointmentStates } from "./persistence/appointment-state-store.mjs";
import { normalizeAppointmentTime } from "./appointment-time.mjs";
import { redactContactPii } from "./platform/contact-pii-redaction.mjs";

const clean = (v, size = 160) => redactContactPii(String(v || "").replace(/[<>]/g, "").trim()).slice(0, size);
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }); };
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const publicAppointment = (item) => {
  if (!item) return null;
  const { internal_customer_reference, confirmation, ...safe } = item;
  return structuredClone(safe);
};
const publicResult = (item, replayed = false) => ({ intake:publicAppointment(item), replayed });
const currentFor = (state, payload) => {
  const item = state.registrations.find((r) => r.id === payload.appointment_intake_id);
  if (item && payload.conversation_id && (item.conversation_id !== payload.conversation_id || item.channel !== (payload.channel || "web"))) return null;
  return item;
};
const checkVersion = (item, value) => {
  if (!Number.isInteger(value) || value !== item.version) fail("APPOINTMENT_VERSION_CONFLICT", "登记内容已更新，请重新查看并确认。", 409);
};
const operationKey = (payload, fallback = "") => {
  const value = String(payload.idempotency_key || fallback).trim();
  if (value.length < 8 || value.length > 128) fail("IDEMPOTENCY_KEY_REQUIRED", "请提供有效的提交标识。");
  return value;
};
const replayFor = (state, key, fingerprint, actor) => {
  const receipt = state.receipts.find((r) => r.key === key);
  if (!receipt) return null;
  if (receipt.hash !== fingerprint || receipt.actor !== actor) fail("APPOINTMENT_IDEMPOTENCY_CONFLICT", "同一提交标识不能用于不同内容。", 409);
  return { intake:structuredClone(receipt.result), replayed:true };
};
const addEvent = (state, item, type, actor, details = {}) => state.events.push({ id:`aptev_${randomUUID()}`, type, appointment_id:item.id, version:item.version, actor, at:item.updated_at, details });
const saveReceipt = (state, key, fingerprint, actor, item) => state.receipts.push({ key, hash:fingerprint, actor, result:publicAppointment(item) });
const normalizeNextFollowupAt = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) fail("APPOINTMENT_NEXT_FOLLOWUP_INVALID", "请填写有效的下次跟进时间。");
  return new Date(timestamp).toISOString();
};
const syncFollowup = (state, item) => {
  let task = state.followups.find((t) => t.appointment_id === item.id);
  if (!task) { task = { id:`aptfollow_${randomUUID()}`, appointment_id:item.id }; state.followups.push(task); }
  Object.assign(task, { registration_version:item.version, customer_time:item.time_preference, assignee:item.assignee,
    status:item.status === "cancelled" ? "cancelled" : item.followup_status === "completed" ? "completed" : "pending" });
  for (const notice of state.notices.filter((n) => n.appointment_id === item.id && ["pending", "manual_required"].includes(n.status))) notice.status = "cancelled";
  state.notices.push({ id:`aptnotice_${randomUUID()}`, appointment_id:item.id, registration_version:item.version,
    status:"manual_required", reason:"channel_delivery_not_connected", kind:item.status === "cancelled" ? "cancellation" : "registration", created_at:item.updated_at });
};

export async function createAppointmentIntake(payload = {}) {
  if (!payload.conversation_id || !/^act_[a-f0-9]{24}$/i.test(String(payload.source_action_id || ""))) fail("APPOINTMENT_SOURCE_INVALID", "请从当前咨询中的到院时间登记入口提交。");
  if (!payload.internal_customer_reference) fail("APPOINTMENT_CONTACT_REQUIRED", "请先保存本次咨询的联系方式。");
  if (payload.customer_confirmed !== true) fail("APPOINTMENT_CONFIRMATION_REQUIRED", "请先核对并确认到院登记摘要。");
  const projects = [...new Set((Array.isArray(payload.projects) ? payload.projects : []).map((v) => clean(v, 80)).filter(Boolean))].slice(0, 6);
  const doctor = clean(payload.doctor, 80) || null;
  const branch = clean(payload.branch, 80);
  if (!projects.length && !doctor) fail("APPOINTMENT_SUBJECT_REQUIRED", "请先确认想咨询的项目或医生。");
  if (!branch) fail("APPOINTMENT_BRANCH_REQUIRED", "请先确认期望到院的院区。");
  const input = { projects, doctor, branch, preferred_date:payload.preferred_date || "", preferred_time:payload.preferred_time || "", time_period:payload.time_period || "", source_action_id:payload.source_action_id };
  const fingerprint = hash(input);
  const actor = `customer:${payload.conversation_id}`;
  const key = operationKey(payload, payload.source_action_id);
  return appointmentStateTransaction(payload, (state) => {
    const replay = replayFor(state, key, fingerprint, actor);
    if (replay) return replay;
    const sameAction = state.registrations.find((r) => r.confirmation.action_id === payload.source_action_id);
    if (sameAction) {
      if (sameAction.confirmation.creation_hash !== fingerprint) fail("APPOINTMENT_IDEMPOTENCY_CONFLICT", "该确认已用于其他登记内容，请重新确认。", 409);
      return publicResult(sameAction, true);
    }
    if (state.registrations.some((r) => r.status === "registered")) fail("APPOINTMENT_ACTIVE_EXISTS", "当前咨询已有有效到院登记，请在原登记中改期或取消。", 409);
    const time = normalizeAppointmentTime(payload);
    const now = new Date().toISOString();
    const id = `apt_${randomUUID()}`;
    const item = { id, tenant_id:payload.tenant_id, channel:payload.channel || "web", conversation_id:payload.conversation_id,
      projects, doctor, branch, ...time, status:"registered", version:1, contact_status:"pending_manual",
      internal_customer_reference:payload.internal_customer_reference,
      confirmation:{ action_id:payload.source_action_id, creation_hash:fingerprint, summary_hash:fingerprint, confirmed_at:now, source:"customer_summary_form" },
      appointment_no:`HM${id.slice(4).replaceAll("-", "").toUpperCase()}`, assignee:null, followup_status:"pending",
      notification_status:"manual_required", schedule_slot_id:null, schedule_reference:null, followup_history:[],
      created_at:now, updated_at:now, confirmed_at:now };
    state.registrations.push(item);
    syncFollowup(state, item);
    addEvent(state, item, "appointment.registered", actor);
    saveReceipt(state, key, fingerprint, actor, item);
    return publicResult(item);
  });
}

export async function listAppointmentIntakes({ tenant_id, status = "", followup_status = "", preferred_date = "", assignee = "", limit = 100, actor = "", assigned_only = false } = {}) {
  const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(preferred_date || "")) ? String(preferred_date) : "";
  const requestedAssignee = String(assignee || "").trim().slice(0, 120);
  const states = await readAppointmentStates({ tenant_id, limit });
  return states.flatMap((state) => state.registrations).filter((r) => (!status || r.status === status)
    && (!followup_status || r.followup_status === followup_status)
    && (!requestedDate || r.preferred_date === requestedDate)
    && (!requestedAssignee || (requestedAssignee === "__unassigned__" ? !r.assignee : r.assignee === requestedAssignee))
    && (!assigned_only || !r.assignee || r.assignee === actor))
    .sort((a,b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Math.min(500, Math.max(1, Number(limit) || 100))).map(publicAppointment);
}
export async function getAppointmentIntake(payload) {
  return appointmentStateTransaction(payload, (state) => {
    const item = currentFor(state, payload);
    if (item && payload.assigned_only && item.assignee && item.assignee !== payload.actor) return null;
    return publicAppointment(item);
  });
}

export async function claimAppointmentIntake(payload) {
  const actor = clean(payload.actor, 120);
  if (!actor) fail("APPOINTMENT_ACTOR_REQUIRED", "领取跟进任务需要实名身份。");
  return appointmentStateTransaction(payload, (state) => {
    const item = currentFor(state, payload);
    if (!item) return null;
    if (item.status !== "registered" || item.followup_status === "completed") fail("APPOINTMENT_ALREADY_CLOSED", "此到院登记的跟进任务已结束。", 409);
    if (item.assignee && item.assignee !== actor) fail("APPOINTMENT_ALREADY_CLAIMED", "此跟进任务已由其他顾问领取。", 409);
    if (item.assignee === actor) return publicAppointment(item);
    item.assignee = actor;
    item.followup_status = "claimed";
    item.updated_at = new Date().toISOString();
    const task = state.followups.find((t) => t.appointment_id === item.id);
    if (task) task.assignee = actor;
    addEvent(state, item, "appointment.followup_claimed", actor);
    return publicAppointment(item);
  });
}

export async function resolveAppointmentIntake(payload) {
  const actor = clean(payload.actor, 120);
  if (!actor) fail("APPOINTMENT_ACTOR_REQUIRED", "处理跟进任务需要实名身份。");
  if (!["completed", "needs_customer_info"].includes(payload.status)) fail("APPOINTMENT_STATUS_INVALID", "顾问只能记录跟进结果；到院时间由客户确认。");
  const note = clean(payload.note, 500);
  if (!note) fail("APPOINTMENT_NOTE_REQUIRED", "请填写跟进结果。");
  const nextFollowupAt = normalizeNextFollowupAt(payload.next_followup_at);
  if (payload.status === "needs_customer_info" && !nextFollowupAt) fail("APPOINTMENT_NEXT_FOLLOWUP_REQUIRED", "待客户补充信息时请记录下次跟进时间。");
  const key = operationKey(payload);
  const fingerprint = hash(["resolve", payload.appointment_intake_id, payload.status, note, nextFollowupAt]);
  return appointmentStateTransaction(payload, (state) => {
    const item = currentFor(state, payload);
    if (!item) return null;
    if (item.assignee !== actor) fail("APPOINTMENT_ASSIGNEE_MISMATCH", "只有当前领取人可以记录跟进结果。", 403);
    const replay = replayFor(state, key, fingerprint, actor);
    if (replay) return replay;
    if (item.status !== "registered" || item.followup_status === "completed") fail("APPOINTMENT_ALREADY_CLOSED", "跟进任务已结束。", 409);
    item.followup_status = payload.status;
    item.resolution_note = note;
    item.next_followup_at = nextFollowupAt;
    item.updated_at = new Date().toISOString();
    item.followup_history = Array.isArray(item.followup_history) ? item.followup_history : [];
    item.followup_history.push({ id:`aptfollowevent_${randomUUID()}`, status:payload.status, note, next_followup_at:nextFollowupAt, actor, occurred_at:item.updated_at });
    const task = state.followups.find((t) => t.appointment_id === item.id);
    if (task) Object.assign(task, { status:payload.status === "completed" ? "completed" : "pending", last_note:note, next_followup_at:nextFollowupAt, updated_at:item.updated_at });
    addEvent(state, item, "appointment.followup_updated", actor, { status:payload.status, next_followup_at:nextFollowupAt });
    saveReceipt(state, key, fingerprint, actor, item);
    return publicResult(item);
  });
}

export async function changeCustomerAppointment(payload) {
  if (!payload.conversation_id) fail("APPOINTMENT_SOURCE_INVALID", "缺少当前咨询身份。");
  if (!["reschedule", "cancel"].includes(payload.action)) fail("APPOINTMENT_ACTION_INVALID", "不支持的到院登记操作。");
  if (payload.customer_confirmed !== true) fail("APPOINTMENT_CONFIRMATION_REQUIRED", "请先确认本次变更。");
  const key = operationKey(payload);
  const fingerprint = hash([payload.action, payload.appointment_intake_id, payload.expected_version, payload.preferred_date || "", payload.preferred_time || "", payload.time_period || ""]);
  const actor = `customer:${payload.conversation_id}`;
  return appointmentStateTransaction(payload, (state) => {
    const item = currentFor(state, payload);
    if (!item) return null;
    const replay = replayFor(state, key, fingerprint, actor);
    // A retry of a previously accepted reschedule must never surface the
    // pre-cancellation snapshot after the customer has cancelled the intake.
    // Return the latest terminal state instead, while retaining the replay
    // marker so callers can distinguish it from a new mutation.
    if (replay) {
      if (item.status === "cancelled" && payload.action === "reschedule") return publicResult(item, true);
      return replay;
    }
    checkVersion(item, payload.expected_version);
    if (item.status === "cancelled" && payload.action === "cancel") return publicResult(item, true);
    if (item.status !== "registered") fail("APPOINTMENT_ALREADY_CLOSED", "此登记已经取消，请重新登记。", 409);
    const time = payload.action === "reschedule" ? normalizeAppointmentTime(payload) : null;
    if (time) Object.assign(item, time);
    else item.status = "cancelled";
    item.version++;
    item.updated_at = new Date().toISOString();
    item.confirmation = { ...item.confirmation, summary_hash:fingerprint, confirmed_at:item.updated_at };
    if (time) item.followup_status = item.assignee ? "claimed" : "pending";
    syncFollowup(state, item);
    addEvent(state, item, `appointment.${payload.action}`, actor);
    saveReceipt(state, key, fingerprint, actor, item);
    return publicResult(item);
  });
}

export const createInternalScheduleSlot = () => fail("SCHEDULE_NOT_IN_PHASE_ONE", "一期按客户确认时间登记，不维护医生排班或名额。", 410);
export const listInternalScheduleSlots = () => [];
export async function getAppointmentStoreStatus(tenant_id) {
  const items = await listAppointmentIntakes({ tenant_id, limit:500 });
  return { appointment_intakes:items.length, appointment_open:items.filter((i) => i.status === "registered" && i.followup_status !== "completed").length,
    appointment_registered:items.filter((i) => i.status === "registered").length, schedule_slots:0 };
}
