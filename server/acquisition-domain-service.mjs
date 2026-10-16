import { captureChatContact } from "./chat-contact-capture.mjs";
import { upsertAcquisitionLead } from "./lead-store.mjs";
import { recordLocalConversation } from "./local-conversation-store.mjs";
import { publicationRequestContext, loadActivePublication } from "./knowledge-publication.mjs";
import { withdrawnKnowledgeRecordIds } from "./knowledge-release-policy.mjs";
import { AGENT_DEFINITIONS, invokeAgentAsync } from "./agent-runtime.mjs";
import { getAcquisitionConversationStyleStatus, leadCaptureDecision, splitAcquisitionReplySegments } from "./acquisition-conversation-style.mjs";
import { getIntentEngineStatus } from "./acquisition-intent.mjs";
import { getAcquisitionSession, getAcquisitionSessionMetrics, prepareAcquisitionSessionContext, recordAcquisitionSessionTurn } from "./acquisition-session.mjs";
import { getHuameiKnowledgeStatus, loadHuameiKnowledge } from "./huamei-knowledge.mjs";
import { getLlmStatus } from "./llm-client.mjs";
import { getGraphRagStatus } from "./graphrag-client.mjs";
import { attachPublicKnowledgeMediaPreviews, getPublicKnowledgeMediaStatus, selectPublicKnowledgeMedia } from "./knowledge-media.mjs";
import { buildAcquisitionOrchestration } from "./acquisition-orchestration.mjs";
import { ensureHandoverTask, findOpenHandover, getOperationsStoreStatus, recordInboundDuringHandover } from "./acquisition-operations-store.mjs";
import { ensureKnowledgeReleasePolicyFresh } from "./knowledge-release-policy.mjs";
import { getTenantContextStatus, normalizeTenantId, tenantScopedKey } from "./platform/tenant-context.mjs";

export const ACQUISITION_SERVICE_VERSION = "1.4.0";
const configuredSequenceWaitMs = Number(process.env.HUAMEI_CONVERSATION_SEQUENCE_WAIT_MS || 10_000);
const CONVERSATION_SEQUENCE_WAIT_MS = Number.isFinite(configuredSequenceWaitMs)
  ? Math.min(30_000, Math.max(250, configuredSequenceWaitMs))
  : 10_000;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const recordTurnInReceiptOrder = async (sessionId, payload, metadata) => {
  const deadline = Date.now() + CONVERSATION_SEQUENCE_WAIT_MS;
  let delayMs = 25;
  while (true) {
    try {
      return await recordAcquisitionSessionTurn(sessionId, payload, metadata);
    } catch (error) {
      const pending = [
        "POSTGRES_CONVERSATION_SEQUENCE_PENDING",
        "DEPENDENCY_CONVERSATION_SEQUENCE_PENDING"
      ].includes(error?.code);
      if (!pending) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const busy = new Error("同一会话中更早的消息仍在处理中，请稍后重试当前消息");
        busy.code = "CONVERSATION_SEQUENCE_BUSY";
        busy.retryable = true;
        busy.retry_after_seconds = 1;
        busy.details = error.details || null;
        throw busy;
      }
      await wait(Math.min(delayMs, remaining));
      delayMs = Math.min(250, delayMs * 2);
    }
  }
};

const knownProjectsFrom = (result) => [...new Set([
  ...(result.output.structured_data?.projects || []),
  result.output.structured_data?.project,
  ...(result.output.structured_data?.intent_analysis?.entities?.projects || []),
  ...(result.output.structured_data?.knowledge_hits || []).map((item) => item.project)
].filter(Boolean))].slice(0, 6);

// Recheck live handover state when generation finishes and again at the HTTP
// delivery boundary. Cached AI output must never revive an active AI session.
function handoverResponse(envelope, openHandover, metadata = {}) {
  const tenantId = envelope.tenant_id, channel = envelope.channel;
  const externalConversationId = envelope.conversation_id, message = envelope.message.text;
    const claimed = openHandover.ai_suspended === true || openHandover.status === "active";
    return {
      schema_version:"1.1", service:"huamei-acquisition-agent", tenant_id:tenantId,
      request_id:metadata.requestId, run_id:null, status:claimed ? "human_active" : "handover_pending",
      channel, conversation_id:externalConversationId, message_id:envelope.message.id,
      agent:{ id:"A-01", slug:"acquisition-consultant", name:"AI获客顾问·小美", version:"5.9.0" },
      reply:{
        text:claimed ? "" : "已为您转接人工顾问，正在接入中。",
        segments:claimed ? [] : ["已为您转接人工顾问，正在接入中。"],
        citations:[], media:[], suggestions:[]
      },
      handover:{ required:true, id:openHandover.id, task_id:openHandover.task_id, status:openHandover.status, to_team:openHandover.team, reason:openHandover.reason, assignee:openHandover.assignee, sla_due_at:openHandover.sla_due_at },
      delivery:{ suppress_ai:claimed, mode:claimed ? "human_only" : "handover_notice" },
      profile_signals:{ projects:openHandover.projects || [], known_slots:openHandover.known_slots || {}, conversation_summary:openHandover.summary, turn_count:null, session_id:externalConversationId, intent:"human_handover" },
      lead_capture:{ should_prompt:false },
      guardrails:{ medical_diagnosis_allowed:false, suitability_judgement_allowed:false, llm_used:false, compliance_gate_version:"4.2.0", knowledge_version:null },
      usage:{ provider:"handover_orchestrator", model:null, input_characters:message.length, output_characters:claimed ? 0 : 17 }
    };
}

export async function acquisitionHandoverDeliveryOverride(envelope, result = null, metadata = {}) {
  const open = await findOpenHandover({ tenant_id:envelope.tenant_id, channel:envelope.channel, conversation_id:envelope.conversation_id });
  if (!open) return null;
  if (!open.ai_suspended && open.status === "pending" && result?.handover?.id === open.id) return null;
  await recordInboundDuringHandover(open, envelope);
  return handoverResponse(envelope, open, metadata);
}

export async function processAcquisitionEnvelope(envelope, metadata = {}) {
  recordLocalConversation(envelope,{});
  const publication=await loadActivePublication(envelope.tenant_id);
  const response = await publicationRequestContext.run(publication,()=>processAcquisitionEnvelopeWithPublication(envelope,metadata));
  recordLocalConversation(envelope,response);
  return response;
}
async function processAcquisitionEnvelopeWithPublication(envelope, metadata = {}) {
  const tenantId = envelope.tenant_id;
  await ensureKnowledgeReleasePolicyFresh(tenantId);
  const channel = envelope.channel;
  const externalConversationId = envelope.conversation_id;
  const internalSessionId = tenantScopedKey(tenantId, channel, externalConversationId);
  const message = envelope.message.text;
  const openHandover = await findOpenHandover({ tenant_id:tenantId, channel, conversation_id:externalConversationId });
  if (openHandover) {
    await recordInboundDuringHandover(openHandover, envelope);
    return handoverResponse(envelope, openHandover, metadata);
  }
  const persistenceMetadata = {
    tenantId,
    channel,
    externalConversationId,
    inboundMessageId:envelope.message.id,
    occurredAt:envelope.message.timestamp
  };
  const sessionContext = await prepareAcquisitionSessionContext(internalSessionId, message, envelope.interests, persistenceMetadata);
  const result = await invokeAgentAsync("A-01", {
    message,
    mode:"reply",
    channel,
    customer_id:envelope.actor.customer_id,
    context:{
      ...envelope.context,
      macro_stage:"售前",
      micro_stage:"项目咨询",
      service_consent:true,
      marketing_consent:false,
      owner:envelope.context.owner || `${channel}渠道`,
      tenant_id:tenantId,
      external_user_id:envelope.actor.external_user_id,
      ...sessionContext
    }
  }, {
    captureContact:async () => captureChatContact(envelope, payload => upsertAcquisitionLead({
      ...payload, interests:[...new Set([...(sessionContext.known_projects || []), ...payload.interests])].slice(0,10)
    })),
    requestId:metadata.requestId,
    caller:metadata.caller || `${channel}_channel_adapter`,
    ...(metadata.formalLoadTaxonomyEntry ? { formalLoadTaxonomyEntry:metadata.formalLoadTaxonomyEntry } : {})
  });
  const sessionSnapshot = await recordTurnInReceiptOrder(
    internalSessionId,
    { message_id:envelope.message.id, message, result, projects:knownProjectsFrom(result) },
    persistenceMetadata
  );
  const handoverTask = await ensureHandoverTask({
    envelope,
    result:{ status:result.status, handover:result.output.handover },
    session_snapshot:sessionSnapshot,
    // This path only runs while processing the customer's current inbound
    // message. It is not permission for a later callback or campaign contact.
    contact_initiation:"customer_inbound"
  });
  const deliveryOverride = await acquisitionHandoverDeliveryOverride(envelope, { handover:handoverTask }, metadata);
  if (deliveryOverride) return deliveryOverride;
  const knowledgeVersion = result.output.structured_data?.knowledge_package?.version || null;
  const knowledgeAdmission = getHuameiKnowledgeStatus(tenantId).admission;
  const suppressLeadPrompt=sessionSnapshot.presales_state?.willingness==='deferred' || sessionSnapshot.known_slots?.contact_capture_status==='accepted';
  const leadDecision = suppressLeadPrompt ? {should_prompt:false,reason:'contact_saved_or_customer_deferred'} : leadCaptureDecision({
    intent:result.output.structured_data?.intent || "",
    status:result.status,
    turnCount:sessionSnapshot.turn_count,
    knownSlots:sessionSnapshot.known_slots,
    message,
    recommendedActions:result.output.recommended_actions
  });
  const citations = attachPublicKnowledgeMediaPreviews(result.output.citations);
  // A-014 AC4：最终输出前重检撤回/过期证据，交付时不再引用已经失效的记录。
  const withdrawnEvidence = withdrawnKnowledgeRecordIds(tenantId);
  const deliveredCitations = withdrawnEvidence.size
    ? citations.filter((item) => !withdrawnEvidence.has(item.source_record_id) && !withdrawnEvidence.has(item.evidence_source_record_id))
    : citations;
  const media = selectPublicKnowledgeMedia({
    message,
    citations:deliveredCitations,
    intent:result.output.structured_data?.intent || ""
  });
  const orchestration = buildAcquisitionOrchestration({ envelope, result, sessionSnapshot });
  return {
    ...(result.lead_receipt ? {lead_receipt:result.lead_receipt} : {}),
    schema_version:"1.1",
    service:"huamei-acquisition-agent",
    tenant_id:tenantId,
    request_id:result.request_id,
    run_id:result.run_id,
    status:result.status,
    channel,
    conversation_id:externalConversationId,
    message_id:envelope.message.id,
    agent:result.agent,
    reply:{
      text:result.output.message,
      segments:splitAcquisitionReplySegments(result.output.message),
      citations:deliveredCitations,
      media,
      suggestions:result.output.structured_data?.next_questions || []
    },
    handover:handoverTask ? {
      ...result.output.handover,
      id:handoverTask.id,
      task_id:handoverTask.task_id,
      status:handoverTask.status,
      priority:handoverTask.priority,
      sla_due_at:handoverTask.sla_due_at
    } : result.output.handover,
    delivery:{ suppress_ai:false, mode:"agent_reply" },
    profile_signals:{
      projects:sessionSnapshot.projects,
      known_slots:sessionSnapshot.known_slots,
      conversation_summary:sessionSnapshot.conversation_summary,
      turn_count:sessionSnapshot.turn_count,
      session_id:externalConversationId,
      intent:result.output.structured_data?.intent || null,
      intent_confidence:result.output.structured_data?.intent_analysis?.confidence ?? null,
      intent_domain:result.output.structured_data?.intent_analysis?.domain || null,
      dialogue_act:result.output.structured_data?.intent_analysis?.dialogue_act || null,
      dialogue_stage:result.output.structured_data?.dialogue_stage || sessionSnapshot.dialogue_stage || null,
      answer_route:result.output.structured_data?.answer_routing?.route || null,
      emotion:result.output.structured_data?.emotion?.emotion || "neutral",
      clarification_required:result.output.structured_data?.intent_analysis?.clarification_required === true,
      conversation_goal:sessionSnapshot.conversation_goal || null,
      pending_fields:sessionSnapshot.pending_fields || [],
      doctors:sessionSnapshot.doctors || [],
      next_action:result.output.recommended_actions?.[0]?.type || null
    },
    orchestration,
    lead_capture:leadDecision.should_prompt ? {
      should_prompt:true,
      title:result.status === "handover_required" ? "留下联系方式，由人工顾问继续协助" : "需要人工顾问继续为您解答吗？",
      description:"留下手机号后，人工顾问可以沿用本次关注点继续沟通，您不用重新说明。",
      consent_text:"我同意时代之美人工顾问基于本次咨询联系我；不代表同意营销推广。",
      reason:leadDecision.reason
    } : { should_prompt:false, reason:leadDecision.reason },
    guardrails:{
      medical_diagnosis_allowed:false,
      suitability_judgement_allowed:false,
      llm_used:result.guardrails.llm_used === true,
      turn_planning:result.guardrails.turn_planning || null,
      client_output_source:result.guardrails.client_output_source || null,
      compliance_gate_version:result.guardrails.compliance_gate_version,
      intent_engine_version:result.guardrails.intent_engine_version,
      conversation_style_version:result.guardrails.conversation_style_version,
      graphrag_used:result.guardrails.graphrag_used === true,
      graphrag_engine:result.guardrails.graphrag_engine || null,
      graphrag_index_version:result.guardrails.graphrag_index_version || null,
      // Digest of the privacy-approved taxonomy query actually accepted by
      // GraphRAG. It contains no raw customer text and lets formal capacity
      // evidence bind cache misses to the exact retrieval-service workload.
      graphrag_query_sha256:result.guardrails.graphrag_query_sha256 || null,
      graphrag_evidence_admitted:result.guardrails.graphrag_evidence_admitted || 0,
      graphrag_fallback_reason:result.guardrails.graphrag_fallback_reason || null,
      ...(result.guardrails.formal_load_taxonomy ? {
        formal_load_taxonomy:result.guardrails.formal_load_taxonomy
      } : {}),
      knowledge_version:knowledgeVersion,
      knowledge_admission_mode:knowledgeAdmission.mode,
      knowledge_admitted:knowledgeAdmission.ready,
      knowledge_release_id:knowledgeAdmission.active_release?.id || null
    },
    usage:result.usage
  };
}

export async function getAcquisitionDomainStatus(tenantId) {
  const tenant = normalizeTenantId(tenantId);
  await ensureKnowledgeReleasePolicyFresh(tenant);
  const knowledge = getHuameiKnowledgeStatus(tenant);
  const admission = knowledge.admission;
  return {
    service:"huamei-acquisition-agent",
    version:ACQUISITION_SERVICE_VERSION,
    status:knowledge.loaded && admission.ready ? "ok" : "degraded",
    boundary:"independent_http_service",
    agent:AGENT_DEFINITIONS.find((item) => item.id === "A-01"),
    knowledge,
    intent_engine:getIntentEngineStatus(loadHuameiKnowledge().records),
    conversation_style:getAcquisitionConversationStyleStatus(),
    public_media:getPublicKnowledgeMediaStatus(),
    sessions:await getAcquisitionSessionMetrics(tenant),
    tenant_context:getTenantContextStatus(),
    operations:await getOperationsStoreStatus(tenant),
    knowledge_admission:admission,
    graphrag:getGraphRagStatus(),
    llm:getLlmStatus(),
    time:new Date().toISOString()
  };
}
