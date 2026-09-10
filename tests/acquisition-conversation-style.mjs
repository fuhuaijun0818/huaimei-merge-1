import assert from "node:assert/strict";
import { invokeAgent } from "../server/agent-runtime.mjs";
import {
  determineAcquisitionDialogueStage,
  evaluateAcquisitionConversationCopy,
  getAcquisitionConversationStyleStatus,
  leadCaptureDecision,
  normalizeAcquisitionConversationCopy,
  splitAcquisitionReplySegments
} from "../server/acquisition-conversation-style.mjs";

const status = getAcquisitionConversationStyleStatus();
assert.equal(status.version, "2.3.0");
assert.equal(status.source_sample_count, 6);
assert.equal(status.source_asset_count, 36);
assert.equal(status.answer_first, true);
assert.equal(status.max_questions, 1);
assert.equal(status.max_segment_characters, 36);
assert.equal(status.segmented_messages, true);
assert.equal(status.dialogue_stages, 6);
assert.equal(status.lead_capture_after_value, true);

assert.equal(normalizeAcquisitionConversationCopy("您好！**可以的**\n\n\n继续说"), "继续说");
assert.equal(normalizeAcquisitionConversationCopy("好的呢，璀璨是水滴形。", { intent:"project_explanation" }), "璀璨是水滴形。");
assert.equal(normalizeAcquisitionConversationCopy("好的，接着讲。", { context:{ recent_turns:[{ role:"assistant", content:"好的，前面说到材料。" }] } }), "接着讲。");
assert.deepEqual(evaluateAcquisitionConversationCopy("您想看原理吗？还是流程？").reason_codes, ["too_many_questions"]);
assert.ok(evaluateAcquisitionConversationCopy("根据资料库检索结果，可以介绍项目。") .reason_codes.includes("internal_language"));
assert.ok(evaluateAcquisitionConversationCopy("建议您先留下手机号，我再介绍。") .reason_codes.includes("premature_lead_push"));
assert.ok(evaluateAcquisitionConversationCopy("亲爱的，这个项目可以了解。") .reason_codes.includes("overfamiliar_address"));
const replySegments = splitAcquisitionReplySegments("隆胸项目的费用因方式不同差异较大，假体隆胸通常涉及假体材料费，自体脂肪隆胸则受抽取和填充量影响，具体价格需结合实际方案由医生面诊后确定。您现在更在意自然感还是恢复时间？");
assert.equal(replySegments.length, 3);
assert.deepEqual(replySegments.slice(-2), ["具体价格需结合实际方案由医生面诊后确定。", "您现在更在意自然感还是恢复时间？"]);
assert.ok(replySegments.every((segment) => segment.split("\n").every((line) => line.length <= 36)));
assert.equal(determineAcquisitionDialogueStage({ intent:"project_explanation" }), "knowledge_explanation");
assert.equal(determineAcquisitionDialogueStage({ intent:"project_comparison" }), "decision_support");
assert.equal(determineAcquisitionDialogueStage({ intent:"appointment_request" }), "appointment_coordination");
assert.equal(leadCaptureDecision({ intent:"project_explanation", turnCount:1, message:"我想丰胸" }).should_prompt, false);
assert.equal(leadCaptureDecision({ intent:"appointment_request", turnCount:2, message:"帮我预约面诊" }).should_prompt, true);
assert.equal(leadCaptureDecision({ intent:"doctor_profile", status:"handover_required" }).should_prompt, true);

const cases = [
  "介绍一下热玛吉",
  "热玛吉和线雕有什么区别？",
  "脸有点松弛",
  "李健院长",
  "胸部整形推荐哪个医生？",
  "李健今天出诊吗？",
  "双眼皮多少钱？",
  "给我看隆鼻案例",
  "帮我预约双眼皮",
  "医院地址在哪里"
  ,"嗯嗯"
  ,"谢谢"
  ,"我先看看"
];

for (const message of cases) {
  const result = invokeAgent("A-01", { message, context:{ macro_stage:"售前", interests:[] } });
  const evaluation = evaluateAcquisitionConversationCopy(result.output.message);
  assert.equal(evaluation.valid, true, `${message}: ${evaluation.reason_codes.join(",")}`);
  assert.ok(evaluation.characters <= 520);
  assert.ok(evaluation.question_count <= 1 || (evaluation.question_count === 2 && result.output.message.endsWith("还有其他想了解的吗？或者帮您预约专家做进一步分析？")));
  assert.doesNotMatch(result.output.message, /^(?:您好|关于您提到的内容|根据上述)/);
  assert.doesNotMatch(result.output.message, /知识库|资料库|检索结果|系统判断|\*\*/);
}

const project = invokeAgent("A-01", { message:"介绍一下热玛吉", context:{} });
assert.match(project.output.message, /^热玛吉/);
assert.match(project.output.message, /还有其他想了解的吗？或者帮您预约专家做进一步分析？/);
assert.doesNotMatch(project.output.message, /^可以的/);

const greeting = invokeAgent("A-01", { message:"你好", context:{} });
const greetingStyle = evaluateAcquisitionConversationCopy(greeting.output.message, { intent:"conversation_greeting" });
assert.equal(greetingStyle.valid, true, greetingStyle.reason_codes.join(","));
assert.match(greeting.output.message, /AI获客顾问小美/);
assert.equal(greetingStyle.question_count, 1);
const greetingSegments = splitAcquisitionReplySegments(greeting.output.message);
assert.ok(greetingSegments.every((segment) => segment.length <= 64));
assert.equal(greetingSegments.join("").replace(/\s/g, ""), greeting.output.message.replace(/\s/g, ""));
assert.doesNotMatch(greeting.output.message, /安安|网约车|会员权益/);

const eyeProject = invokeAgent("A-01", { message:"我想了解双眼皮项目", context:{} });
const eyeProjectStyle = evaluateAcquisitionConversationCopy(eyeProject.output.message);
assert.equal(eyeProjectStyle.valid, true, eyeProjectStyle.reason_codes.join(","));
assert.ok(eyeProjectStyle.characters <= 180);
assert.ok(eyeProjectStyle.sentence_count <= 4);
assert.ok(splitAcquisitionReplySegments(eyeProject.output.message).every((segment) => segment.split("\n").every((line) => line.length <= 36)));

const concern = invokeAgent("A-01", { message:"脸有点松弛", context:{} });
assert.match(concern.output.message, /^明白/);

const doctor = invokeAgent("A-01", { message:"胸部整形推荐哪个医生？", context:{} });
assert.doesNotMatch(doctor.output.message, /^可以的/);
assert.match(doctor.output.message, /^做胸部整形的相关医生/);

const appointment = invokeAgent("A-01", { message:"帮我预约双眼皮", context:{} });
assert.doesNotMatch(appointment.output.message, /^(?:好的|可以的)[，,]/);
assert.doesNotMatch(appointment.output.message, /留下手机号|联系方式/);
assert.match(appointment.output.message, /期望到院日期和时段/);
assert.match(appointment.output.message, /不锁定指定医生或接诊名额/);

const caseRequest = invokeAgent("A-01", { message:"给我看隆鼻案例", context:{} });
assert.match(caseRequest.output.message, /想先看实际案例很正常/);
assert.match(caseRequest.output.message, /核验授权/);

const acknowledgement = invokeAgent("A-01", { message:"嗯嗯", context:{ interests:["胸部整形"], turn_index:2 } });
assert.equal(acknowledgement.output.structured_data.intent, "conversation_acknowledgement");
assert.equal(acknowledgement.output.structured_data.next_questions.length, 0);
assert.equal(acknowledgement.output.message, "好，您接着说。");

console.log("✓ 真人售前沟通风格、单问题推进和自然承接规则通过");
console.log("✓ 回复已按独立短消息分段，内部措辞、提前催留资与未授权案例表达保持拦截");
