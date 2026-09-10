import assert from "node:assert/strict";
process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE = ":memory:";
const {
  getAcquisitionSession, getAcquisitionSessionMetrics, prepareAcquisitionSessionContext,
  recordAcquisitionSessionTurn, resetAcquisitionSessionsForTest
} = await import("../server/acquisition-session.mjs");
const { invokeAgent } = await import("../server/agent-runtime.mjs");

resetAcquisitionSessionsForTest();
const sessionId = "session-eval-001";
const first = prepareAcquisitionSessionContext(sessionId, "我想做双眼皮，预算一万左右，想要自然一点", []);
assert.ok(first.interests.includes("双眼皮"));
assert.equal(first.known_slots.budget, "一万");
assert.match(first.known_slots.style_preference, /自然/);

recordAcquisitionSessionTurn(sessionId, {
  message:"我想做双眼皮，预算一万左右，想要自然一点",
  projects:["双眼皮"],
  result:{ status:"completed", output:{ message:"先介绍一般信息。", citations:[{ knowledge_id:"KB-P-001" }], recommended_actions:[{ type:"collect_need", fields:["preferred_project"] }], structured_data:{
    intent:"project_explanation",
    intent_analysis:{ primary_intent:"project_explanation", current_turn_overrides_context:true, entities:{ projects:["眼部整形"], doctors:[] } }
  } } }
});
const second = prepareAcquisitionSessionContext(sessionId, "我先不想被推套餐，按这个需求说清楚", []);
assert.ok(second.interests.includes("双眼皮"));
assert.equal(second.known_slots.budget, "一万");
assert.match(second.conversation_summary, /双眼皮/);
assert.match(second.conversation_summary, /一万/);
assert.equal(second.conversation_goal.intent, "project_explanation");
assert.ok(second.pending_fields.includes("preferred_project"));
assert.ok(second.completed_steps.some((step) => step.type === "intent_classified"));

recordAcquisitionSessionTurn(sessionId, {
  message:"现在呼吸困难",
  result:{ status:"handover_required", output:{ message:"请立即联系医务人员。", citations:[], structured_data:{ risk_matches:[{ rule_id:"MEDICAL_EMERGENCY", category:"medical_emergency", critical:true }] } } }
});
const critical = prepareAcquisitionSessionContext(sessionId, "那我先等等看", []);
assert.equal(critical.active_critical_risk.category, "medical_emergency");
const cleared = prepareAcquisitionSessionContext(sessionId, "我已经就医，医生接手了", []);
assert.equal(cleared.active_critical_risk, null);

const snapshot = getAcquisitionSession(sessionId);
assert.equal(snapshot.known_slots.budget, "一万");
assert.ok(snapshot.turn_count >= 2);
const metrics = getAcquisitionSessionMetrics();
assert.equal(metrics.sessions, 1);
assert.equal(metrics.turns, 2);
assert.equal(metrics.grounded, 1);

const birthmarkSession = prepareAcquisitionSessionContext("session-birthmark-001", "我想去胎记，脸上有一块很大的胎记", []);
assert.match(birthmarkSession.profile.concern, /胎记/);

const sourcedSessionId = "session-slot-source-001";
const sourcedMeta = { messageId:"source-message-001" };
const sourced = prepareAcquisitionSessionContext(sourcedSessionId, "预算两万，周末下午方便联系", [], sourcedMeta);
assert.equal(sourced.slot_sources.budget.message_id, sourcedMeta.messageId);
assert.equal(sourced.slot_sources.budget.matched_by, "message_extraction");
assert.equal(sourced.slot_sources.time_preference.message_id, sourcedMeta.messageId);
assert.match(sourced.slot_sources.budget.message_sha256, /^[a-f0-9]{64}$/);
recordAcquisitionSessionTurn(sourcedSessionId, {
  message:"预算两万，周末下午方便联系",
  result:{ status:"completed", output:{ message:"已记录。", citations:[], structured_data:{ intent_analysis:{ primary_intent:"need_discovery", entities:{ projects:[], doctors:[] } } } } }
}, sourcedMeta);
prepareAcquisitionSessionContext(sourcedSessionId, "想找李健医生了解隆鼻", [], { messageId:"source-message-002" });
recordAcquisitionSessionTurn(sourcedSessionId, {
  message:"想找李健医生了解隆鼻",
  result:{ status:"completed", output:{ message:"已记录您的医生偏好。", citations:[], structured_data:{ intent_analysis:{ primary_intent:"physician_discovery", entities:{ projects:["隆鼻"], doctors:["李健"] }, current_turn_overrides_context:true } } } }
}, { messageId:"source-message-002" });
const sourcedSnapshot = getAcquisitionSession(sourcedSessionId);
assert.equal(sourcedSnapshot.known_slots.preferred_doctor, "李健");
assert.equal(sourcedSnapshot.slot_sources.preferred_doctor.message_id, "source-message-002");

const choiceSessionId = "session-choice-slot-001";
prepareAcquisitionSessionContext(choiceSessionId, "我想咨询一下丰胸项目", []);
recordAcquisitionSessionTurn(choiceSessionId, {
  message:"我想咨询一下丰胸项目",
  projects:["胸部整形"],
  result:{ status:"completed", output:{
    message:"丰胸可以先分为假体隆胸和自体脂肪隆胸两种方向。您想先了解假体隆胸，还是自体脂肪隆胸？",
    citations:[], recommended_actions:[],
    structured_data:{ intent:"project_explanation", projects:["胸部整形"], next_questions:["您想先了解假体隆胸，还是自体脂肪隆胸？"] }
  } }
});
const fatChoiceContext = prepareAcquisitionSessionContext(choiceSessionId, "自体脂肪方式", []);
assert.equal(fatChoiceContext.pending_choice.field, "breast_method");
assert.deepEqual(fatChoiceContext.pending_choice_resolution, { field:"breast_method", value:"autologous_fat", label:"自体脂肪丰胸" });
const fatChoiceReply = invokeAgent("A-01", {
  message:"自体脂肪方式",
  context:{ macro_stage:"售前", ...fatChoiceContext }
});
assert.match(fatChoiceReply.output.message, /^您选的是自体脂肪丰胸：将自身其他部位脂肪处理后移植到胸部。/);
assert.equal(fatChoiceReply.output.structured_data.intent_analysis.choice_resolution.selection.value, "autologous_fat");
recordAcquisitionSessionTurn(choiceSessionId, { message:"自体脂肪方式", result:fatChoiceReply, projects:["胸部整形"] });
const fatChoiceSnapshot = getAcquisitionSession(choiceSessionId);
assert.equal(fatChoiceSnapshot.known_slots.breast_method, "autologous_fat");
assert.equal(fatChoiceSnapshot.pending_choice.field, "project_information_facet");
const fatPrincipleContext = prepareAcquisitionSessionContext(choiceSessionId, "这是什么原理？", []);
const fatPrincipleReply = invokeAgent("A-01", {
  message:"这是什么原理？",
  context:{ macro_stage:"售前", ...fatPrincipleContext }
});
assert.equal(fatPrincipleReply.output.structured_data.project, "自体脂肪隆胸");
assert.equal(fatPrincipleReply.output.structured_data.facet, "general_principle");
assert.match(fatPrincipleReply.output.message, /自身其他部位的脂肪/);
assert.doesNotMatch(fatPrincipleReply.output.message, /热玛吉|当前改善问题/);
recordAcquisitionSessionTurn(choiceSessionId, { message:"这是什么原理？", result:fatPrincipleReply });
assert.ok(getAcquisitionSession(choiceSessionId).projects.includes("自体脂肪隆胸"));

const orderedSessionId = "session-ordered-001";
const orderedMeta1 = { messageId:"channel-message-1" };
const orderedMeta2 = { messageId:"channel-message-2" };
prepareAcquisitionSessionContext(orderedSessionId, "先了解双眼皮", [], orderedMeta1);
prepareAcquisitionSessionContext(orderedSessionId, "再了解隆鼻", [], orderedMeta2);
const orderedPayload = (message, reply) => ({
  message,
  result:{ status:"completed", output:{ message:reply, citations:[], structured_data:{} } }
});
assert.throws(
  () => recordAcquisitionSessionTurn(orderedSessionId, orderedPayload("再了解隆鼻", "第二条回复"), orderedMeta2),
  (error) => error.code === "DEPENDENCY_CONVERSATION_SEQUENCE_PENDING"
);
const orderedFirst = recordAcquisitionSessionTurn(
  orderedSessionId,
  orderedPayload("先了解双眼皮", "第一条回复"),
  orderedMeta1
);
assert.equal(orderedFirst.turn_count, 1);
const orderedFirstReplay = recordAcquisitionSessionTurn(
  orderedSessionId,
  orderedPayload("先了解双眼皮", "本次重放内容不得重复计数"),
  orderedMeta1
);
assert.equal(orderedFirstReplay.turn_count, 1);
const orderedSecond = recordAcquisitionSessionTurn(
  orderedSessionId,
  orderedPayload("再了解隆鼻", "第二条回复"),
  orderedMeta2
);
assert.equal(orderedSecond.turn_count, 2);
assert.equal(getAcquisitionSession(orderedSessionId).turn_count, 2);
assert.throws(
  () => prepareAcquisitionSessionContext(orderedSessionId, "复用ID但内容不同", [], orderedMeta1),
  (error) => error.code === "CONVERSATION_MESSAGE_ID_REUSED"
);

console.log("✓ 售前多轮状态、已知槽位与安全连续性通过");
console.log("✓ 会话指标保留人工付出时间的独立验收口径");
console.log("✓ 渠道消息幂等、完成顺序门禁与重放不重复计数通过");
