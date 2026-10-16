import { createHash } from "node:crypto";
import { understandConcern } from "./acquisition-concern-understanding.mjs";
import { createJsonStateStore } from "./platform/json-state-store.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";
import { redactContactPii, redactContactPiiDeep } from "./platform/contact-pii-redaction.mjs";
import { postgresPersistenceEnabled } from "./persistence/postgres-helpers.mjs";
import { getPostgresAcquisitionSessionStore } from "./persistence/postgres-session-store.mjs";
import { deriveChoicePrompt, normalizePendingChoice, resolvePendingChoice } from "./acquisition-choice-slots.mjs";
import { advancePresalesState, extractVisitPreference } from './acquisition-presales-dialogue.mjs';

const SESSION_TTL_MS = Math.max(5 * 60_000, Number(process.env.HUAMEI_ACQUISITION_SESSION_TTL_MS || 30 * 60_000));
const MAX_SESSIONS = Math.max(100, Number(process.env.HUAMEI_ACQUISITION_MAX_SESSIONS || 2_000));
const MAX_TURNS = 16;
const MAX_COMPLETED_STEPS = 24;
const clone = (value) => JSON.parse(JSON.stringify(value));
const sessionStore = createJsonStateStore({
  envName:"HUAMEI_ACQUISITION_SESSION_STORE_FILE",
  defaultFile:".local-data/acquisition-sessions.json",
  initialState:{ version:1, sessions:{} }
});
const sessions = new Map(Object.entries(sessionStore.load().sessions || {}));
const PERSIST_DEBOUNCE_MS = Math.max(25, Number(process.env.HUAMEI_ACQUISITION_SESSION_PERSIST_DEBOUNCE_MS || 250));
let persistTimer = null;
const persistSessionsNow = () => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  sessionStore.save({
    version:1,
    sessions:redactContactPiiDeep(Object.fromEntries(sessions))
  });
};
const persistSessions = () => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSessionsNow, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
};

const maskSensitive = (value = "") => redactContactPii(String(value))
  .replace(/\b\d{15,18}[0-9Xx]\b/g, "[证件号已脱敏]")
  .slice(0, 1_000);

const unique = (values) => [...new Set(values.filter(Boolean))];

export const normalizeAcquisitionSessionId = (value, fallback = "anonymous") => {
  const normalized = String(value || fallback).trim().replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);
  return normalized || String(fallback).slice(0, 128);
};

let lastCleanupAt = 0;
const cleanup = (force = false) => {
  const now = Date.now();
  if (!force && sessions.size <= MAX_SESSIONS && now - lastCleanupAt < 30_000) return;
  lastCleanupAt = now;
  let changed = false;
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) { sessions.delete(id); changed = true; }
  }
  while (sessions.size > MAX_SESSIONS) { sessions.delete(sessions.keys().next().value); changed = true; }
  if (changed) persistSessions();
};

const createSession = (sessionId) => ({
  id:sessionId,
  createdAt:Date.now(),
  updatedAt:Date.now(),
  turns:[],
  // 连续“没听懂”的轮数：用于连续两次仍无法理解时提供人工入口。
  clarificationStreak:0,
  projects:[],
  doctors:[],
  concerns:[],
  knownSlots:{},
  presalesState:{},
  slotSources:{},
  conversationGoal:{ intent:null, project:null, doctor:null, status:"discovering", topic_version:0 },
  pendingFields:[],
  pendingChoice:null,
  completedSteps:[],
  lastIntent:null,
  dialogueStage:"need_discovery",
  activeCriticalRisk:null,
  nextMessageSequence:1,
  nextCommitSequence:1,
  messageReceipts:{},
  counters:{ completed:0, handover_required:0, blocked:0, grounded:0 }
});

const normalizeSessionState = (sessionId, value = {}) => {
  const safeValue = redactContactPiiDeep(value || {});
  return ({
    ...createSession(sessionId),
    ...safeValue,
    id:sessionId,
    turns:Array.isArray(safeValue?.turns) ? safeValue.turns : [],
    clarificationStreak:Number(safeValue?.clarificationStreak) || 0,
    projects:Array.isArray(safeValue?.projects) ? safeValue.projects : [],
    doctors:Array.isArray(safeValue?.doctors) ? safeValue.doctors : [],
    concerns:Array.isArray(safeValue?.concerns) ? safeValue.concerns : [],
    knownSlots:safeValue?.knownSlots && typeof safeValue.knownSlots === "object" ? safeValue.knownSlots : {},
    slotSources:safeValue?.slotSources && typeof safeValue.slotSources === "object" ? safeValue.slotSources : {},
    conversationGoal:safeValue?.conversationGoal && typeof safeValue.conversationGoal === "object"
      ? { ...createSession(sessionId).conversationGoal, ...safeValue.conversationGoal }
      : createSession(sessionId).conversationGoal,
    pendingFields:Array.isArray(safeValue?.pendingFields)
      ? safeValue.pendingFields.map((item) => maskSensitive(item)).filter(Boolean).slice(0, 12)
      : [],
    pendingChoice:normalizePendingChoice(safeValue?.pendingChoice),
    completedSteps:Array.isArray(safeValue?.completedSteps) ? safeValue.completedSteps.slice(-MAX_COMPLETED_STEPS) : [],
    nextMessageSequence:Math.max(1, Number(safeValue?.nextMessageSequence) || 1),
    nextCommitSequence:Math.max(1, Number(safeValue?.nextCommitSequence) || 1),
    messageReceipts:safeValue?.messageReceipts && typeof safeValue.messageReceipts === "object" ? safeValue.messageReceipts : {},
    counters:{ ...createSession(sessionId).counters, ...(safeValue?.counters || {}) }
  });
};

const normalizeOccurredAt = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  const candidate = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  return Number.isNaN(candidate.getTime()) ? null : candidate.toISOString();
};

const persistenceContext = (sessionId, metadata = {}) => ({
  tenantId:normalizeTenantId(metadata.tenantId || metadata.tenant_id),
  sessionId:normalizeAcquisitionSessionId(sessionId),
  channel:String(metadata.channel || "web").trim().toLowerCase().slice(0, 32) || "web",
  externalConversationId:normalizeAcquisitionSessionId(
    metadata.externalConversationId || metadata.external_conversation_id || sessionId
  ),
  messageId:String(metadata.inboundMessageId || metadata.messageId || metadata.message_id || "").trim(),
  occurredAt:normalizeOccurredAt(metadata.occurredAt || metadata.occurred_at),
  expiresAt:new Date(Date.now() + SESSION_TTL_MS).toISOString()
});

const inboundMessageContext = (message, metadata = {}) => {
  const messageId = String(
    metadata.inboundMessageId || metadata.messageId || metadata.message_id || ""
  ).trim();
  if (!messageId) return null;
  if (messageId.length > 160) {
    const error = new Error("渠道消息ID不能超过160个字符");
    error.code = "CONVERSATION_MESSAGE_ID_INVALID";
    throw error;
  }
  return {
    messageId,
    payloadHash:createHash("sha256").update(String(message || "")).digest("hex")
  };
};

const assistantMessageIdFor = (sessionId, inboundMessageId) => `reply_${createHash("sha256")
  .update(`${sessionId}\u0000${inboundMessageId}\u0000assistant`)
  .digest("hex")}`;

const assertMatchingReceipt = (receipt, payloadHash) => {
  if (receipt?.payload_hash === payloadHash) return;
  const error = new Error("同一渠道消息ID不能用于不同的消息内容");
  error.code = "CONVERSATION_MESSAGE_ID_REUSED";
  throw error;
};

const getSession = (sessionId) => {
  cleanup();
  const id = normalizeAcquisitionSessionId(sessionId);
  if (!sessions.has(id)) sessions.set(id, createSession(id));
  const session = sessions.get(id);
  session.updatedAt = Date.now();
  return session;
};

const projectTerms = [
  "双眼皮", "重睑", "眼综合", "眼袋", "泪沟", "提眉", "隆鼻", "鼻综合", "鼻部整形", "隆胸", "胸部整形",
  "热玛吉", "线雕", "拉皮", "微拉美", "光子嫩肤", "皮秒", "水光", "玻尿酸", "瘦脸针", "肉毒", "吸脂", "脂肪填充",
  "毛发移植", "植发", "牙齿矫正", "口腔", "抗衰", "抗初老", "祛斑", "痘坑", "脱毛"
];

const concernTerms = [
  "松弛", "下垂", "皱纹", "法令纹", "暗沉", "发黄", "色斑", "斑点", "痘印", "痘坑", "毛孔", "缺水", "干燥",
  "胎记", "太田痣", "鲜红斑痣", "雀斑样痣", "咖啡斑", "色素痣", "血管瘤",
  "眼袋", "泪沟", "内双", "鼻梁", "鼻尖", "鼻翼", "咬肌", "下颌线", "双下巴", "腰腹", "大腿", "手臂"
];

const extractBudget = (message) => {
  const text = String(message || "");
  const explicit = text.match(/(?:预算|大概|控制在|不超过|以内)[^，。；\n]{0,8}?((?:\d+(?:\.\d+)?\s*[万千百wkWK])|(?:[一二两三四五六七八九十]+万))(?:元|块)?/);
  if (explicit) return explicit[1].replace(/\s+/g, "");
  const standalone = text.match(/(?:^|\D)((?:\d+(?:\.\d+)?\s*[万wkWK])|(?:[一二两三四五六七八九十]+万))(?:元|块|左右|以内|上下)/);
  return standalone?.[1]?.replace(/\s+/g, "") || null;
};

const extractTimePreference = (message) => {
  const visit = extractVisitPreference(message);
  if (visit) return visit;
  const matches = String(message || "").match(/(?:周[一二三四五六日天]|工作日|周末|上午|下午|晚上|下班后|本周|下周|今天|明天)/g);
  return matches ? unique(matches).join("、") : null;
};

const extractStylePreference = (message) => {
  const matches = String(message || "").match(/(?:自然|垂感|垂坠|柔软|挺拔|明显|保守|不夸张|不要套餐|不推套餐|性价比|恢复快|不着急)/g);
  return matches ? unique(matches).join("、") : null;
};

const extractSignals = (message) => {
  const text = String(message || "");
  return {
    projects:projectTerms.filter((term) => text.toLowerCase().includes(term.toLowerCase())),
    concerns:understandConcern(text,concernTerms).concerns,
    negated_concerns:understandConcern(text,concernTerms).negated_concerns,
    budget:extractBudget(text),
    time_preference:extractTimePreference(text),
    style_preference:extractStylePreference(text),
    requests_human:/(?:人工|真人|顾问|客服|转人|不要机器人)/.test(text),
    confirms_care:/(?:已经联系|已联系|已经就医|已就医|医生接手|医务接手|打了120)/.test(text)
  };
};

const summaryFor = (session) => {
  const parts = [];
  if (session.conversationGoal?.intent) parts.push(`当前目标：${session.conversationGoal.intent}`);
  if (session.projects.length) parts.push(`关注项目：${session.projects.join("、")}`);
  if (session.concerns.length) parts.push(`关注点：${session.concerns.join("、")}`);
  if (session.doctors.length) parts.push(`关注医生：${session.doctors.join("、")}`);
  if (session.knownSlots.budget) parts.push(`预算：${session.knownSlots.budget}`);
  if (session.knownSlots.time_preference) parts.push(`时间偏好：${session.knownSlots.time_preference}`);
  if (session.knownSlots.style_preference) parts.push(`沟通偏好：${session.knownSlots.style_preference}`);
  if (session.pendingChoice?.label) parts.push(`待确认：${session.pendingChoice.label}`);
  if (session.activeCriticalRisk) parts.push(`安全状态：${session.activeCriticalRisk.category}待人工/医疗确认`);
  return maskSensitive(parts.join("；")).slice(0, 500);
};

const pendingFieldsFor = (result, intent) => {
  const fields = [];
  for (const action of result?.output?.recommended_actions || []) {
    if (Array.isArray(action?.fields)) fields.push(...action.fields);
  }
  if (intent === "need_clarification") fields.push("preferred_project_or_concern");
  if (["appointment_query", "appointment_request"].includes(intent)) fields.push("preferred_date", "time_preference");
  if (result?.status === "handover_required") fields.push("human_owner");
  return unique(fields.map((item) => maskSensitive(String(item)).replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 64))).slice(0, 12);
};

const interactionStateFor = (session, result, linkedProjects = [], linkedDoctors = []) => {
  const analysis = result?.output?.structured_data?.intent_analysis || {};
  const intent = analysis.primary_intent || result?.output?.structured_data?.intent || session.lastIntent || null;
  const project = linkedProjects[0] || session.projects[0] || null;
  const doctor = linkedDoctors[0] || session.doctors[0] || null;
  const previous = session.conversationGoal || createSession(session.id).conversationGoal;
  const topicChanged = analysis.current_turn_overrides_context === true
    && Boolean(previous.intent)
    && (previous.intent !== intent || (project && previous.project && previous.project !== project) || (doctor && previous.doctor && previous.doctor !== doctor));
  const status = result?.status === "handover_required" ? "waiting_human"
    : result?.status === "blocked" ? "blocked"
      : intent === "need_clarification" ? "clarifying"
        : "in_progress";
  const goal = {
    intent,
    project,
    doctor,
    status,
    topic_version:Math.max(0, Number(previous.topic_version) || 0) + (topicChanged ? 1 : 0)
  };
  const recordedAt = new Date().toISOString();
  const evidenceCount = Array.isArray(result?.output?.citations) ? result.output.citations.length : 0;
  const steps = [
    { type:"intent_classified", value:intent || "unknown", at:recordedAt },
    ...(evidenceCount ? [{ type:"evidence_resolved", value:String(evidenceCount), at:recordedAt }] : []),
    ...(topicChanged ? [{ type:"topic_switched", value:String(goal.topic_version), at:recordedAt }] : []),
    ...(result?.status === "handover_required" ? [{ type:"human_handover_requested", value:"required", at:recordedAt }] : [])
  ];
  return {
    goal,
    pending_fields:pendingFieldsFor(result, intent),
    completed_steps:[...session.completedSteps, ...steps].slice(-MAX_COMPLETED_STEPS)
  };
};

const slotSourceFor = ({ message, messageId = "", payloadHash = "", turnIndex, matchedBy, previousValue = null }) => ({
  ...(messageId ? { message_id:messageId } : {}),
  message_sha256:payloadHash || createHash("sha256").update(String(message || "")).digest("hex"),
  turn_index:turnIndex,
  matched_by:matchedBy,
  confirmed:true,
  updated_at:new Date().toISOString(),
  ...(previousValue ? { previous_value:previousValue } : {})
});

const prepareSessionContext = (session, message, providedInterests = [], source = null) => {
  const signals = extractSignals(message);
  session.presalesState = advancePresalesState(session.presalesState, message);
  const currentTurn = Math.floor(session.turns.length / 2) + 1;
  const pendingChoiceExpired = session.pendingChoice?.created_turn
    && currentTurn - session.pendingChoice.created_turn >= session.pendingChoice.expires_after_turn;
  if (pendingChoiceExpired) session.pendingChoice = null;
  const pendingChoiceForCurrentTurn = session.pendingChoice ? clone(session.pendingChoice) : null;
  const choiceResolution = resolvePendingChoice(message, pendingChoiceForCurrentTurn);
  if (["selected", "cancelled"].includes(choiceResolution.status)) session.pendingChoice = null;
  session.projects = unique([
    ...session.projects,
    ...providedInterests.map((item) => maskSensitive(typeof item === "string" ? item : item?.name)),
    ...signals.projects
  ]).slice(0, 12);
  session.concerns = unique([...session.concerns.filter(term=>!signals.negated_concerns.includes(term)), ...signals.concerns]).slice(0, 12);
  for (const field of ["budget", "time_preference", "style_preference"]) {
    if (!signals[field]) continue;
    const previous = session.knownSlots[field] || null;
    session.knownSlots[field] = signals[field];
    session.slotSources[field] = slotSourceFor({
      message,
      messageId:source?.messageId,
      payloadHash:source?.payloadHash,
      turnIndex:currentTurn,
      matchedBy:"message_extraction",
      previousValue:previous && previous !== signals[field] ? previous : null
    });
  }
  if (signals.confirms_care) session.activeCriticalRisk = null;
  session.updatedAt = Date.now();
  return { state:session, result:{
    session_id:session.id,
    interests:session.projects,
    profile:{
      concern:session.concerns.join("、"),
      budget:session.knownSlots.budget || "",
      time_preference:session.knownSlots.time_preference || "",
      style_preference:session.knownSlots.style_preference || ""
    },
    known_slots:{ ...session.knownSlots },
    presales_state:{ ...session.presalesState },
    slot_sources:clone(session.slotSources || {}),
    pending_choice:pendingChoiceForCurrentTurn,
    pending_choice_resolution:choiceResolution.status === "selected"
      ? { field:choiceResolution.choice.field, value:choiceResolution.selection.value, label:choiceResolution.selection.label }
      : null,
    known_projects:[...session.projects],
    known_doctors:[...session.doctors],
    conversation_goal:{ ...session.conversationGoal },
    pending_fields:[...session.pendingFields],
    completed_steps:session.completedSteps.slice(-8),
    last_intent:session.lastIntent,
    clarification_streak:Number(session.clarificationStreak) || 0,
    dialogue_stage:session.dialogueStage || "need_discovery",
    recent_turns:session.turns.slice(-12).map((turn) => ({ role:turn.role, content:maskSensitive(turn.content).slice(0, 320) })),
    conversation_summary:summaryFor(session),
    active_critical_risk:session.activeCriticalRisk,
    turn_index:currentTurn
  } };
};

export function prepareAcquisitionSessionContext(sessionId, message, providedInterests = [], metadata = {}) {
  const inbound = inboundMessageContext(message, metadata);
  if (postgresPersistenceEnabled()) {
    const context = persistenceContext(sessionId, metadata);
    if (!inbound) {
      const error = new Error("PostgreSQL会话必须提供渠道message.id作为业务幂等键");
      error.code = "CONVERSATION_MESSAGE_ID_REQUIRED";
      throw error;
    }
    return getPostgresAcquisitionSessionStore().beginTurn({
      ...context,
      initialState:createSession(context.sessionId),
      messageId:inbound.messageId,
      message:maskSensitive(message),
      payloadHash:inbound.payloadHash,
      operation:(stored) => prepareSessionContext(normalizeSessionState(context.sessionId, stored), message, providedInterests, inbound)
    }).then((value) => value.result);
  }
  const session = getSession(sessionId);
  if (inbound) {
    const existing = session.messageReceipts[inbound.messageId];
    if (existing) {
      assertMatchingReceipt(existing, inbound.payloadHash);
      return prepareSessionContext(
        normalizeSessionState(session.id, clone(session)),
        message,
        providedInterests,
        inbound
      ).result;
    }
    session.messageReceipts[inbound.messageId] = {
      message_id:inbound.messageId,
      payload_hash:inbound.payloadHash,
      turn_sequence:session.nextMessageSequence,
      processing_state:"received",
      assistant_message_id:null,
      received_at:new Date().toISOString(),
      completed_at:null,
      session_snapshot:null
    };
    session.nextMessageSequence += 1;
  }
  const mutation = prepareSessionContext(session, message, providedInterests, inbound);
  persistSessions();
  return mutation.result;
}

const recordSessionTurn = (session, {
  message,
  result,
  projects = [],
  messageId = null,
  assistantMessageId = null,
  turnSequence = null
}) => {
  const intentAnalysis = result?.output?.structured_data?.intent_analysis || {};
  const linkedProjects = Array.isArray(intentAnalysis.entities?.projects) ? intentAnalysis.entities.projects : [];
  const linkedDoctors = unique([
    ...(Array.isArray(intentAnalysis.entities?.doctors) ? intentAnalysis.entities.doctors : []),
    ...(Array.isArray(result?.output?.structured_data?.doctors) ? result.output.structured_data.doctors : []),
    ...(Array.isArray(result?.output?.structured_data?.doctor_candidates) ? result.output.structured_data.doctor_candidates.map((item) => item?.name) : [])
  ]);
  const explicitProjectSwitch = intentAnalysis.current_turn_overrides_context === true && linkedProjects.length > 0;
  session.projects = unique((explicitProjectSwitch ? [...linkedProjects, ...projects, ...session.projects] : [...session.projects, ...projects, ...linkedProjects]).map(maskSensitive)).slice(0, 12);
  if (explicitProjectSwitch && linkedProjects.every((project) => !/(?:胸|乳房)/.test(project)) && session.knownSlots.breast_method) {
    const previous = session.knownSlots.breast_method;
    delete session.knownSlots.breast_method;
    session.slotSources = { ...(session.slotSources || {}), breast_method:{ ...(session.slotSources?.breast_method || {}),
      confirmed:false, previous_value:previous, invalidated_by_message_id:messageId, reason:"project_changed" } };
  }
  session.doctors = unique((explicitProjectSwitch ? linkedDoctors : [...session.doctors, ...linkedDoctors]).map(maskSensitive)).slice(0, 12);
  if (explicitProjectSwitch && !linkedDoctors.length && session.knownSlots.preferred_doctor) {
    const previous = session.knownSlots.preferred_doctor;
    delete session.knownSlots.preferred_doctor;
    session.slotSources.preferred_doctor = {
      ...(session.slotSources.preferred_doctor || {}),
      confirmed:false,
      previous_value:previous,
      invalidated_by_message_id:messageId,
      reason:"project_changed",
      updated_at:new Date().toISOString()
    };
  }
  if (linkedDoctors[0]) {
    const previous = session.knownSlots.preferred_doctor || null;
    session.knownSlots.preferred_doctor = linkedDoctors[0];
    session.slotSources.preferred_doctor = slotSourceFor({
      message,
      messageId,
      turnIndex:Math.floor(session.turns.length / 2) + 1,
      matchedBy:"entity_linking",
      previousValue:previous && previous !== linkedDoctors[0] ? previous : null
    });
  }
  const interaction = interactionStateFor(session, result, linkedProjects, linkedDoctors);
  session.conversationGoal = interaction.goal;
  session.pendingFields = interaction.pending_fields;
  // 记录本次是否“没听懂”：澄清轮累加，其它轮清零（连续两次即触发人工入口）。
  const turnIntent = intentAnalysis?.primary_intent || result.output?.structured_data?.intent || "";
  // 已经给出业务回执（留资保存、人工受理等）的轮次不算“没听懂”：否则“留资 + 联系偏好”
  // 这类正常轮次会被计入连续澄清，导致下一轮被误升级到人工。
  const businessHandled = Boolean(result.lead_receipt)
    || result.handover?.required === true
    || /已保存|已记录您希望/.test(String(result.output?.message || ""));
  session.clarificationStreak = (turnIntent === "need_clarification" && !businessHandled)
    ? (Number(session.clarificationStreak) || 0) + 1
    : 0;
  const selectedChoice = intentAnalysis.choice_resolution?.status === "selected"
    ? intentAnalysis.choice_resolution.selection
    : null;
  if (selectedChoice && intentAnalysis.choice_resolution.field) {
    const field = intentAnalysis.choice_resolution.field;
    const previous = session.knownSlots[field] || null;
    session.knownSlots[field] = selectedChoice.value;
    session.slotSources = { ...(session.slotSources || {}), [field]:{
      message_id:messageId, confirmed:true, updated_at:new Date().toISOString(),
      matched_by:intentAnalysis.choice_resolution.matched_by,
      ...(previous && previous !== selectedChoice.value ? { previous_value:previous } : {})
    } };
  }
  const nextChoice = deriveChoicePrompt(result?.output?.structured_data || {});
  session.pendingChoice = nextChoice
    ? { ...nextChoice, created_at:new Date().toISOString(), created_turn:Math.floor(session.turns.length / 2) + 1 }
    : selectedChoice || intentAnalysis.choice_resolution?.status === "cancelled"
      ? null
      : intentAnalysis.current_turn_overrides_context === true
        ? null
      : session.pendingChoice;
  if(result?.output?.structured_data?.contact_capture_status==='accepted')session.knownSlots.contact_capture_status='accepted';
  const turnPlan = result?.output?.structured_data?.turn_plan;
  if (turnPlan?.used && turnPlan.version === '1.0.0') {
    for (const update of turnPlan.slot_updates || []) {
      if (!['budget','time_preference','style_preference','concern'].includes(update.field) || !message.normalize('NFKC').includes(update.value)) continue;
      const previous = session.knownSlots[update.field];
      session.knownSlots[update.field] = update.value;
      session.slotSources[update.field] = slotSourceFor({message,messageId,turnIndex:Math.floor(session.turns.length/2)+1,matchedBy:'validated_turn_plan',previousValue:previous});
      if(update.field==='time_preference')session.presalesState.visit_preference=update.value;
      if(update.field==='concern')session.concerns=[update.value];
    }
    if (['interested','deferred'].includes(turnPlan.task?.willingness)) session.presalesState.willingness=turnPlan.task.willingness;
    if (turnPlan.next_step==='defer') session.presalesState.willingness='deferred';
    // Only the latest compact plan is persisted, not raw model reasoning.
    session.lastTurnPlan={intent:turnPlan.intent,next_step:turnPlan.next_step};
  }
  session.completedSteps = interaction.completed_steps;
  session.lastIntent = intentAnalysis.primary_intent || result?.output?.structured_data?.intent || session.lastIntent;
  session.dialogueStage = result?.output?.structured_data?.dialogue_stage || session.dialogueStage || "need_discovery";
  const recordedAt = new Date().toISOString();
  session.turns.push(
    {
      role:"user", content:maskSensitive(message), at:recordedAt,
      ...(messageId ? { message_id:messageId } : {}),
      ...(turnSequence ? { turn_sequence:turnSequence } : {})
    },
    {
      role:"assistant", content:maskSensitive(result?.output?.message || ""), at:recordedAt,
      status:result?.status || "unknown",
      ...(assistantMessageId ? { message_id:assistantMessageId, parent_message_id:messageId } : {}),
      ...(turnSequence ? { turn_sequence:turnSequence } : {})
    }
  );
  session.turns = session.turns.slice(-MAX_TURNS * 2);
  const status = result?.status || "completed";
  if (status in session.counters) session.counters[status] += 1;
  if ((result?.output?.citations || []).length) session.counters.grounded += 1;
  const riskMatches = result?.output?.structured_data?.risk_matches || [];
  const critical = riskMatches.find((match) => match.critical === true || match.category === "medical_emergency");
  if (critical) session.activeCriticalRisk = { category:critical.category, rule_id:critical.rule_id, since:new Date().toISOString() };
  session.updatedAt = Date.now();
  return { state:session, result:{
    session_id:session.id,
    turn_count:Math.floor(session.turns.length / 2),
    projects:session.projects,
    doctors:session.doctors,
    last_intent:session.lastIntent,
    dialogue_stage:session.dialogueStage,
    known_slots:{ ...session.knownSlots },
    presales_state:{ ...session.presalesState },
    slot_sources:clone(session.slotSources || {}),
    pending_choice:session.pendingChoice ? clone(session.pendingChoice) : null,
    conversation_goal:{ ...session.conversationGoal },
    pending_fields:[...session.pendingFields],
    completed_steps:session.completedSteps.slice(-8),
    conversation_summary:summaryFor(session),
    active_critical_risk:session.activeCriticalRisk
  } };
};

export function recordAcquisitionSessionTurn(sessionId, payload, metadata = {}) {
  const inbound = inboundMessageContext(payload?.message || "", {
    ...metadata,
    inboundMessageId:metadata.inboundMessageId || metadata.messageId || metadata.message_id || payload?.message_id
  });
  if (postgresPersistenceEnabled()) {
    const context = persistenceContext(sessionId, metadata);
    if (!inbound) {
      const error = new Error("PostgreSQL会话必须提供渠道message.id作为业务幂等键");
      error.code = "CONVERSATION_MESSAGE_ID_REQUIRED";
      throw error;
    }
    return getPostgresAcquisitionSessionStore().recordTurn({
      ...context,
      initialState:createSession(context.sessionId),
      messageId:inbound.messageId,
      payloadHash:inbound.payloadHash,
      assistantMessage:maskSensitive(payload?.result?.output?.message || ""),
      status:payload?.result?.status || "completed",
      operation:(stored, turnContext) => recordSessionTurn(
        normalizeSessionState(context.sessionId, stored),
        {
          ...payload,
          messageId:turnContext.messageId,
          assistantMessageId:turnContext.assistantMessageId,
          turnSequence:turnContext.turnSequence
        }
      )
    }).then((value) => value.result);
  }
  const session = getSession(sessionId);
  if (inbound) {
    const receipt = session.messageReceipts[inbound.messageId];
    if (!receipt) {
      const error = new Error("必须先登记渠道入站消息，再记录智能体回复");
      error.code = "DEPENDENCY_CONVERSATION_RECEIPT_REQUIRED";
      throw error;
    }
    assertMatchingReceipt(receipt, inbound.payloadHash);
    if (receipt.processing_state === "completed") return clone(receipt.session_snapshot);
    if (receipt.turn_sequence !== session.nextCommitSequence) {
      const error = new Error(`会话第${receipt.turn_sequence}条消息必须等待第${session.nextCommitSequence}条完成`);
      error.code = "DEPENDENCY_CONVERSATION_SEQUENCE_PENDING";
      error.retryable = true;
      throw error;
    }
    const mutation = recordSessionTurn(session, {
      ...payload,
      messageId:inbound.messageId,
      assistantMessageId:assistantMessageIdFor(session.id, inbound.messageId),
      turnSequence:receipt.turn_sequence
    });
    receipt.processing_state = "completed";
    receipt.assistant_message_id = assistantMessageIdFor(session.id, inbound.messageId);
    receipt.completed_at = new Date().toISOString();
    receipt.session_snapshot = clone(mutation.result);
    session.nextCommitSequence += 1;
    persistSessions();
    return mutation.result;
  }
  const mutation = recordSessionTurn(session, payload);
  persistSessions();
  return mutation.result;
}

const summarizeMetrics = (sessionValues, storage) => {
  const totals = { sessions:sessionValues.length, turns:0, completed:0, handover_required:0, blocked:0, grounded:0 };
  for (const session of sessionValues) {
    const counters = session.counters || {};
    const turnCount = Number(counters.completed || 0) + Number(counters.handover_required || 0) + Number(counters.blocked || 0);
    totals.turns += turnCount;
    totals.completed += Number(counters.completed || 0);
    totals.handover_required += Number(counters.handover_required || 0);
    totals.blocked += Number(counters.blocked || 0);
    totals.grounded += Number(counters.grounded || 0);
  }
  return {
    ...totals,
    ai_independent_turn_rate:totals.turns ? Number((totals.completed / totals.turns).toFixed(4)) : 0,
    handover_rate:totals.turns ? Number((totals.handover_required / totals.turns).toFixed(4)) : 0,
    knowledge_grounded_rate:totals.turns ? Number((totals.grounded / totals.turns).toFixed(4)) : 0,
    storage,
    measurement_note:"运行指标仅反映智能体处理与接管情况；人工付出时间下降需结合坐席实际分钟数和连续4周同口径基线验证。"
  };
};

export function getAcquisitionSessionMetrics(tenantId) {
  if (postgresPersistenceEnabled()) {
    const store = getPostgresAcquisitionSessionStore();
    return store.listStates({
      tenantId:normalizeTenantId(tenantId),
      activeSince:new Date(Date.now() - SESSION_TTL_MS).toISOString()
    })
      .then((states) => summarizeMetrics(states, store.status()));
  }
  cleanup();
  return summarizeMetrics([...sessions.values()], sessionStore.status());
}

const publicSession = (session) => {
  if (!session) return null;
  return redactContactPiiDeep({
    session_id:session.id,
    projects:[...session.projects],
    doctors:[...session.doctors],
    concerns:[...session.concerns],
    known_slots:{ ...session.knownSlots },
    presales_state:{ ...session.presalesState },
    slot_sources:clone(session.slotSources || {}),
    pending_choice:session.pendingChoice ? clone(session.pendingChoice) : null,
    active_critical_risk:session.activeCriticalRisk,
    last_intent:session.lastIntent,
    dialogue_stage:session.dialogueStage || "need_discovery",
    turn_count:Math.floor(session.turns.length / 2),
    conversation_summary:summaryFor(session)
  });
};

export function getAcquisitionSession(sessionId, metadata = {}) {
  if (postgresPersistenceEnabled()) {
    const context = persistenceContext(sessionId, metadata);
    return getPostgresAcquisitionSessionStore().get(context)
      .then((state) => publicSession(state ? normalizeSessionState(context.sessionId, state) : null));
  }
  return publicSession(sessions.get(normalizeAcquisitionSessionId(sessionId)));
}

export const flushAcquisitionSessions = () => postgresPersistenceEnabled() ? Promise.resolve() : persistSessionsNow();
export const resetAcquisitionSessionsForTest = () => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  sessions.clear();
  sessionStore.reset();
};
