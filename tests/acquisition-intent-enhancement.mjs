import assert from "node:assert/strict";
import { buildAcquisitionEntityCatalog, getIntentEngineStatus, recognizeAcquisitionIntent } from "../server/acquisition-intent.mjs";
import { invokeAgent } from "../server/agent-runtime.mjs";
import { loadHuameiKnowledge } from "../server/huamei-knowledge.mjs";

const knowledge = loadHuameiKnowledge();
const catalog = buildAcquisitionEntityCatalog(knowledge.records);
const intent = (message, context = {}) => recognizeAcquisitionIntent(message, {
  catalog,
  context,
  risk:{ decision:"allow", matches:[] }
});

assert.equal(getIntentEngineStatus(knowledge.records).version, "3.4.0");

const hot = catalog.projects.find((item) => item.alias === "热玛吉");
const ultrasound = catalog.projects.find((item) => item.alias === "超声炮");
assert.equal(hot?.canonical, "热玛吉");
assert.equal(ultrasound?.canonical, "抗初老/紧致除皱");
assert.equal(ultrasound?.source, "brand_or_model");

const comparison = intent("热玛吉和超声炮有什么区别");
assert.equal(comparison.primary_intent, "project_comparison");
assert.deepEqual(comparison.entities.projects, ["热玛吉", "抗初老/紧致除皱"]);
assert.ok(comparison.entities.project_mentions.some((item) => item.mention === "超声炮"));

const contextualComparison = intent("这两个怎么选", {
  known_projects:["热玛吉", "超声炮"]
});
assert.equal(contextualComparison.primary_intent, "project_comparison");
assert.deepEqual(contextualComparison.entities.projects, ["热玛吉", "超声炮"]);

const switchProjectReply = invokeAgent("A-01", {
  message:"还想了解一下超声炮",
  context:{
    known_projects:["热玛吉"],
    interests:["热玛吉"],
    recent_turns:[
      { role:"user", content:"我想了解热玛吉" },
      { role:"assistant", content:"热玛吉是一种基于射频技术的非侵入性皮肤紧致与提升疗程。" }
    ],
    last_intent:"project_explanation",
    turn_index:2
  }
});
assert.equal(switchProjectReply.output.structured_data.intent, "project_explanation");
assert.match(switchProjectReply.output.message, /超声炮/);
assert.doesNotMatch(switchProjectReply.output.message, /先按资料比较/);

const corrected = intent("不是热玛吉，是超声炮", { known_projects:["热玛吉"] });
assert.equal(corrected.primary_intent, "project_explanation");
assert.deepEqual(corrected.entities.projects, ["抗初老/紧致除皱"]);
assert.deepEqual(corrected.entities.project_correction.rejected_projects, ["热玛吉"]);
assert.ok(corrected.reason_codes.includes("explicit_project_correction"));

const contextualPolicy = intent("现在有优惠活动吗", { known_projects:["超声炮"] });
assert.equal(contextualPolicy.primary_intent, "policy_verification");
assert.deepEqual(contextualPolicy.entities.projects, ["超声炮"]);
assert.ok(contextualPolicy.reason_codes.includes("context_projects_bound_to_entities"));

const appointment = intent("我想周六下午去面诊", { known_projects:["热玛吉"] });
assert.equal(appointment.primary_intent, "appointment_request");
assert.deepEqual(appointment.entities.projects, ["热玛吉"]);

const comparisonReply = invokeAgent("A-01", {
  message:"热玛吉和超声炮有什么区别？",
  context:{}
});
assert.equal(comparisonReply.output.structured_data.intent, "project_comparison");
assert.match(comparisonReply.output.message, /热玛吉/);
assert.match(comparisonReply.output.message, /超声炮/);
assert.ok(comparisonReply.output.citations.length >= 2);

const correctionReply = invokeAgent("A-01", {
  message:"不是热玛吉，是超声炮",
  context:{ known_projects:["热玛吉"], interests:["热玛吉"] }
});
assert.equal(correctionReply.output.structured_data.intent, "project_explanation");
assert.match(correctionReply.output.message, /超声炮/);
assert.doesNotMatch(correctionReply.output.message, /热玛吉/);
assert.doesNotMatch(JSON.stringify(correctionReply.output.citations), /热玛吉/);

const contextualComparisonReply = invokeAgent("A-01", {
  message:"这两个怎么选",
  context:{ known_projects:["热玛吉", "超声炮"], interests:["热玛吉", "超声炮"] }
});
assert.equal(contextualComparisonReply.output.structured_data.intent, "project_comparison");
assert.match(contextualComparisonReply.output.message, /热玛吉/);
assert.match(contextualComparisonReply.output.message, /超声炮/);
assert.doesNotMatch(contextualComparisonReply.output.message, /想了解哪个项目/);

const contextualPolicyReply = invokeAgent("A-01", {
  message:"现在有优惠活动吗",
  context:{ known_projects:["超声炮"], interests:["超声炮"] }
});
assert.equal(contextualPolicyReply.output.structured_data.intent, "policy_verification");
assert.doesNotMatch(contextualPolicyReply.output.message, /最想改善|想了解哪个项目/);

const appointmentReply = invokeAgent("A-01", {
  message:"我想周六下午去面诊",
  context:{ known_projects:["热玛吉"], interests:["热玛吉"] }
});
assert.equal(appointmentReply.output.structured_data.intent, "appointment_request");
assert.match(appointmentReply.output.message, /周六/);
assert.match(appointmentReply.output.message, /下午/);
assert.doesNotMatch(appointmentReply.output.message, /更方便哪一天|哪天到院/);
assert.deepEqual(appointmentReply.output.structured_data.next_questions, []);

console.log("PASS acquisition intent enhancement: aliases, correction, contextual comparison and carry, explicit appointment");
