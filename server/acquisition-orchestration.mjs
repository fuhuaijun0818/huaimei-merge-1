import { createHash } from "node:crypto";
import { extractVisitPreference } from './acquisition-presales-dialogue.mjs';

export const ACQUISITION_ORCHESTRATION_VERSION = "1.0.0";

const unique = (values) => [...new Set(values.filter(Boolean))];
const short = (value, limit = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
const actionIdFor = ({ tenantId, conversationId, messageId, type }) => `act_${createHash("sha256")
  .update(`${tenantId}\u0000${conversationId}\u0000${messageId}\u0000${type}`)
  .digest("hex")
  .slice(0, 24)}`;

const EXTERNAL_SEARCH_PATTERN = /(?:国家卫健委|卫健委|药监局|监管(?:规定|政策)|最新(?:法规|政策|指南)|外部新闻|全网|网上查)/;
const ACTION_TYPES = [
  { type:"appointment_request", pattern:/(?:帮我|我要|想)?(?:预约|约面诊|安排到院)/, title:"确认到院时间登记" },
  { type:"activity_registration", pattern:/(?:报名|参加).{0,12}(?:活动|体验|讲座|沙龙)/, title:"提交活动报名申请" },
  { type:"service_ticket", pattern:/(?:创建|提交|开).{0,8}(?:工单|申请)/, title:"创建服务工单" }
];

const sourceTypeFor = (path = "") => {
  const normalized = String(path);
  if (normalized.startsWith("医生介绍/")) return "doctor_profile";
  if (normalized.startsWith("项目价格/") || normalized.startsWith("6月份政策/") || normalized.startsWith("荟员升级权益/")) return "business_metadata";
  if (normalized.startsWith("项目介绍/")) return "project_material";
  return "approved_knowledge";
};

const evidenceClaimsFor = (citations = [], freshness = {}) => unique(citations.map((citation) => {
  const sourcePath = String(citation?.source_relative_path || "");
  const fact = short(citation?.excerpt || citation?.title || "已核验资料", 240);
  if (!fact) return null;
  return JSON.stringify({
    claim_type:"source_fact",
    statement:fact,
    source_type:sourceTypeFor(sourcePath),
    source_record_id:String(citation?.source_record_id || citation?.knowledge_id || "").slice(0, 160) || null,
    source_path:sourcePath.slice(0, 500) || null,
    applicable_region:"上海华美医疗美容医院",
    effective_at:null,
    verified_at:freshness.verified_at || null,
    verification_required:citation?.requires_verification === true || freshness.verification_required === true
  });
}).filter(Boolean)).map((item) => JSON.parse(item));

const actionProposalFor = ({ message, tenantId, conversationId, messageId, intent, salesPlan, turnPlan }) => {
  const visitChange = salesPlan?.willingness === 'interested' && extractVisitPreference(message) && /去吧|去面诊|过来|过去|改到|改成|还是/.test(message);
  const plannedAppointment=turnPlan?.used && turnPlan.next_step==='offer_appointment' && turnPlan.task?.willingness==='interested';
  const matched = (plannedAppointment ? ACTION_TYPES[0] : null) || ACTION_TYPES.find((candidate) => candidate.pattern.test(String(message))) || (visitChange ? ACTION_TYPES[0] : null);
  if (!matched) return null;
  const internalAppointment = matched.type === "appointment_request";
  if (internalAppointment && (turnPlan?.next_step==='defer' || turnPlan?.task?.willingness==='deferred' || salesPlan?.suppress_booking_invitation || /(?:先不|暂时不|不想|不要)(?:预约|约)|别.{0,3}预约/.test(message))) return null;
  return {
    id:actionIdFor({ tenantId, conversationId, messageId, type:matched.type }),
    type:matched.type,
    title:matched.title,
    status:"confirmation_required",
    write_operation:true,
    confirmation_required:true,
    idempotency_scope:"tenant_conversation_message_action",
    rollback:internalAppointment
      ? "客户确认摘要后登记期望到院时间；可按版本改期或取消，不锁定医生名额。"
      : "未派发前可取消；派发后由业务系统按其撤销规则处理",
    adapter_status:internalAppointment ? "internal_ready" : "not_connected",
    ...(internalAppointment
      ? { execution_target:"internal_appointment_intake", blocked_reason:null }
      : { blocked_reason:"当前本地环境尚未接入活动或工单业务系统，不能伪造执行成功。" }),
    requested_intent:intent || null
  };
};

// 人工接管期间不能恢复模型生成，但客户仍可在本轮明确提出到院登记。
// 这里仅生成需要客户再次确认的本地登记动作；不会创建真实号源、排班或
// 任何外部预约。动作标识仍绑定租户、会话和这条客户消息，保留可审计的
// 动作来源。
export const buildHandoverAppointmentProposal = ({ tenantId, conversationId, messageId, message } = {}) => {
  const proposal = actionProposalFor({
    tenantId:String(tenantId || ""),
    conversationId:String(conversationId || ""),
    messageId:String(messageId || ""),
    message:String(message || ""),
    intent:"appointment_request",
    salesPlan:null,
    turnPlan:null
  });
  return proposal?.type === "appointment_request" ? proposal : null;
};

const taskPlanFor = ({ routing, result, actionProposal, externalSearchRequired }) => {
  const strategy = routing?.retrieval_strategy || "none";
  const graphUsed = result?.guardrails?.graphrag_used === true;
  const steps = [
    { id:"intent", type:"intent_and_state", status:"completed" },
    ...(strategy === "structured_business_data" ? [{ id:"structured_data", type:"structured_business_data", status:"verification_required" }] : []),
    ...(strategy === "rag_metadata" ? [{ id:"rag", type:"approved_rag", status:"completed" }] : []),
    ...(strategy === "graph_rag" ? [{ id:"graph", type:"graphrag_relationship", status:graphUsed ? "completed" : "fallback", reason:result?.guardrails?.graphrag_fallback_reason || null }] : []),
    ...(externalSearchRequired ? [{ id:"web", type:"authorized_web_search", status:"provider_not_configured" }] : []),
    ...(actionProposal ? [{ id:"action", type:"business_write", status:"awaiting_confirmation" }] : []),
    ...(result?.status === "handover_required" ? [{ id:"handover", type:"human_collaboration", status:"required" }] : [])
  ];
  return {
    strategy,
    complexity:steps.length >= 3 ? "multi_step" : "direct",
    steps,
    terminal_status:result?.status || "completed"
  };
};

/**
 * Constructs a channel-neutral, auditable decision packet. This module never
 * executes a business write: write requests are explicit proposals which need
 * customer confirmation plus an approved connector before dispatch.
 */
export function buildAcquisitionOrchestration({ envelope, result, sessionSnapshot = {} } = {}) {
  const tenantId = String(envelope?.tenant_id || "").trim();
  const conversationId = String(envelope?.conversation_id || "").trim();
  const messageId = String(envelope?.message?.id || "").trim();
  const message = String(envelope?.message?.text || "");
  const structured = result?.output?.structured_data || {};
  const routing = structured.answer_routing || {};
  const freshness = routing.freshness || {
    required:false, source_of_truth:"approved_knowledge_release", verification_required:false, verified_at:null
  };
  const externalSearchRequired = EXTERNAL_SEARCH_PATTERN.test(message);
  const actionProposal = actionProposalFor({
    message, tenantId, conversationId, messageId,
    intent:structured.intent || structured.intent_analysis?.primary_intent || "",
    salesPlan:structured.sales_dialogue,
    turnPlan:structured.turn_plan
  });
  return {
    version:ACQUISITION_ORCHESTRATION_VERSION,
    conversation_state:{
      current_goal:sessionSnapshot.conversation_goal || null,
      presales:structured.sales_dialogue || sessionSnapshot.presales_state || null,
      confirmed:{
        projects:sessionSnapshot.projects || [],
        doctors:sessionSnapshot.doctors || [],
        slots:sessionSnapshot.known_slots || {}
      },
      pending_fields:sessionSnapshot.pending_fields || [],
      completed_steps:sessionSnapshot.completed_steps || []
    },
    routing:{
      answer_route:routing.route || "deterministic_policy",
      retrieval_strategy:routing.retrieval_strategy || "none",
      freshness,
      external_search:{ required:externalSearchRequired, provider_status:externalSearchRequired ? "not_configured" : "not_required" }
    },
    task_plan:taskPlanFor({ routing, result, actionProposal, externalSearchRequired }),
    evidence_claims:evidenceClaimsFor(result?.output?.citations || [], freshness),
    uncertainty:{
      level:result?.status === "blocked" ? "refused" : result?.status === "handover_required" ? "human_required"
        : freshness.verification_required ? "verification_required" : "grounded_or_general",
      reason:externalSearchRequired ? "external_source_provider_not_configured"
        : freshness.verification_required ? "time_sensitive_fact_requires_verification"
          : null
    },
    action_proposal:actionProposal
  };
}
