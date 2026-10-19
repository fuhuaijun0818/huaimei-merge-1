import assert from "node:assert/strict";
import { routeAcquisitionAnswer } from "../server/acquisition-answer-routing.mjs";
import { buildAcquisitionOrchestration, buildHandoverAppointmentProposal } from "../server/acquisition-orchestration.mjs";

const scheduleRoute = routeAcquisitionAnswer({
  message:"李健院长本周六有排班吗？",
  intent:"doctor_schedule_verification",
  analysis:{ entities:{ doctors:["李健"] } }
});
assert.equal(scheduleRoute.route, "enterprise_knowledge_graph");
assert.equal(scheduleRoute.retrieval_strategy, "structured_business_data");
assert.equal(scheduleRoute.freshness.required, true);
assert.equal(scheduleRoute.freshness.verification_required, true);

const priceRoute = routeAcquisitionAnswer({
  message:"热玛吉现在多少钱？",
  intent:"price_verification",
  analysis:{ entities:{ projects:["热玛吉"] } }
});
assert.equal(priceRoute.retrieval_strategy, "structured_business_data");
assert.equal(priceRoute.freshness.required, true);

const policyRoute = routeAcquisitionAnswer({
  message:"6月份皮肤套餐政策有哪些？",
  intent:"policy_verification",
  analysis:{ entities:{ projects:["皮肤美容"] } }
});
assert.equal(policyRoute.retrieval_strategy, "graph_rag");
assert.equal(policyRoute.freshness.required, true);
assert.equal(policyRoute.freshness.verification_required, true);

const projectRoute = routeAcquisitionAnswer({
  message:"热玛吉是什么原理？",
  intent:"project_explanation",
  analysis:{ entities:{ projects:["热玛吉"] } }
});
assert.equal(projectRoute.retrieval_strategy, "graph_rag");

const doctorRoute = routeAcquisitionAnswer({
  message:"李健院长的胸部整形方向介绍一下。",
  intent:"doctor_profile",
  analysis:{ entities:{ doctors:["李健"], projects:["胸部整形"] } }
});
assert.equal(doctorRoute.retrieval_strategy, "graph_rag");

const doctorProjectRoute = routeAcquisitionAnswer({
  message:"李健院长擅长哪些项目？",
  intent:"doctor_project_verification",
  analysis:{ entities:{ doctors:["李健"] } }
});
assert.equal(doctorProjectRoute.retrieval_strategy, "graph_rag");

const comparisonRoute = routeAcquisitionAnswer({
  message:"李健院长和叶丽萍院长的胸部整形方向怎么选？",
  intent:"doctor_comparison",
  analysis:{ entities:{ doctors:["李健", "叶丽萍"], projects:["胸部整形"] } }
});
assert.equal(comparisonRoute.retrieval_strategy, "graph_rag");

const serviceRoute = routeAcquisitionAnswer({
  message:"医院地址和停车怎么走？",
  intent:"service_information",
  analysis:{ entities:{} }
});
assert.equal(serviceRoute.retrieval_strategy, "rag_metadata");

const result = {
  status:"completed",
  guardrails:{ graphrag_used:false, graphrag_fallback_reason:"not_selected_structured_business_data" },
  output:{
    structured_data:{ intent:"appointment_request", answer_routing:{
      ...routeAcquisitionAnswer({ message:"我想预约双眼皮面诊", intent:"appointment_request", analysis:{ entities:{ projects:["眼部整形"] } } })
    } },
    citations:[{
      knowledge_id:"service-address-1",
      source_relative_path:"项目介绍/整形外科/眼部整形/预约说明.md",
      excerpt:"预约时间需以院方实时确认结果为准。",
      requires_verification:true
    }]
  }
};
const orchestration = buildAcquisitionOrchestration({
  envelope:{ tenant_id:"huamei-shanghai", conversation_id:"conversation-1", message:{ id:"message-1", text:"我想预约双眼皮面诊" } },
  result,
  sessionSnapshot:{
    projects:["眼部整形"], doctors:[], known_slots:{},
    conversation_goal:{ intent:"appointment_request", project:"眼部整形", status:"in_progress", topic_version:1 },
    pending_fields:["preferred_date", "time_preference"],
    completed_steps:[{ type:"intent_classified", value:"appointment_request" }]
  }
});
assert.equal(orchestration.routing.retrieval_strategy, "structured_business_data");
assert.equal(orchestration.task_plan.complexity, "multi_step");
assert.ok(orchestration.task_plan.steps.some((step) => step.type === "structured_business_data" && step.status === "verification_required"));
assert.equal(orchestration.action_proposal.status, "confirmation_required");
assert.equal(orchestration.action_proposal.write_operation, true);
assert.equal(orchestration.action_proposal.adapter_status, "internal_ready");
assert.equal(orchestration.action_proposal.execution_target, "internal_appointment_intake");
assert.equal(orchestration.action_proposal.blocked_reason, null);
assert.match(orchestration.action_proposal.id, /^act_[a-f0-9]{24}$/);
assert.equal(orchestration.evidence_claims[0].claim_type, "source_fact");
assert.equal(orchestration.evidence_claims[0].verification_required, true);
assert.deepEqual(orchestration.conversation_state.pending_fields, ["preferred_date", "time_preference"]);

const externalSearch = buildAcquisitionOrchestration({
  envelope:{ tenant_id:"huamei-shanghai", conversation_id:"conversation-2", message:{ id:"message-2", text:"国家卫健委最新政策怎么说？" } },
  result:{ status:"completed", output:{ structured_data:{ intent:"need_clarification", answer_routing:{ route:"deterministic_policy", retrieval_strategy:"none" } }, citations:[] }, guardrails:{} },
  sessionSnapshot:{}
});
assert.equal(externalSearch.routing.external_search.required, true);
assert.equal(externalSearch.routing.external_search.provider_status, "not_configured");
assert.ok(externalSearch.task_plan.steps.some((step) => step.type === "authorized_web_search"));

const handoverAppointment = buildHandoverAppointmentProposal({
  tenantId:"huamei-shanghai", conversationId:"handover-conversation", messageId:"handover-book-1", message:"我想预约热玛吉"
});
assert.equal(handoverAppointment?.type, "appointment_request", "人工接管期间的明确预约请求仍应提供待确认登记动作");
assert.match(handoverAppointment?.id || "", /^act_[a-f0-9]{24}$/);
assert.equal(buildHandoverAppointmentProposal({
  tenantId:"huamei-shanghai", conversationId:"handover-conversation", messageId:"handover-book-2", message:"我暂时不想预约"
}), null, "客户明确拒绝预约时不得展示登记入口");

console.log("✓ 动态检索路由、会话任务状态、证据声明与待确认业务动作通过");
