import assert from "node:assert/strict";
import { buildAcquisitionEntityCatalog, getIntentEngineStatus, INTENT_ONTOLOGY, recognizeAcquisitionIntent } from "../server/acquisition-intent.mjs";
import { invokeAgent } from "../server/agent-runtime.mjs";
import { loadHuameiKnowledge } from "../server/huamei-knowledge.mjs";
import { acquisitionIntentCases } from "./fixtures/acquisition-intent-cases.mjs";

const knowledge = loadHuameiKnowledge();
assert.equal(knowledge.loaded, true);
const catalog = buildAcquisitionEntityCatalog(knowledge.records);
const status = getIntentEngineStatus(knowledge.records);
assert.equal(status.version, "3.3.0");
assert.equal(status.intents, 26);
assert.ok(status.doctor_entities >= 30);
assert.ok(status.project_aliases >= 100);

const failures = [];
for (const testCase of acquisitionIntentCases) {
  const result = recognizeAcquisitionIntent(testCase.message, {
    catalog,
    context:testCase.context || {},
    risk:testCase.risk || { decision:"allow", matches:[] }
  });
  if (result.primary_intent !== testCase.expected) failures.push(`${testCase.id}: expected ${testCase.expected}, got ${result.primary_intent}`);
  if (typeof testCase.clarification === "boolean" && result.clarification_required !== testCase.clarification) {
    failures.push(`${testCase.id}: clarification expected ${testCase.clarification}, got ${result.clarification_required}`);
  }
  for (const project of testCase.expectedProjects || []) if (!result.entities.projects.includes(project)) failures.push(`${testCase.id}: missing project ${project}`);
  for (const doctor of testCase.expectedDoctors || []) if (!result.entities.doctors.includes(doctor)) failures.push(`${testCase.id}: missing doctor ${doctor}`);
  for (const concern of testCase.expectedConcerns || []) if (!result.entities.concerns.includes(concern)) failures.push(`${testCase.id}: missing concern ${concern}`);
  assert.equal(result.evidence_plan.route, INTENT_ONTOLOGY[result.primary_intent].evidence_route);
}
assert.deepEqual(failures, [], failures.join("\n"));

const conflictDoctor = invokeAgent("A-01", { message:"李健院长", context:{ macro_stage:"售前", interests:["抗初老", "热玛吉"] } });
assert.equal(conflictDoctor.output.structured_data.intent, "doctor_profile");
assert.match(conflictDoctor.output.message, /李健/);
assert.ok(conflictDoctor.output.citations.every((item) => item.source_relative_path.startsWith("医生介绍/")));

const doctorDiscovery = invokeAgent("A-01", { message:"我想做胸部整形，推荐哪个医生？", context:{ macro_stage:"售前", interests:["抗初老"] } });
assert.equal(doctorDiscovery.output.structured_data.intent, "doctor_discovery_by_project");
assert.ok(doctorDiscovery.output.structured_data.doctor_candidates.length >= 3);
assert.ok(doctorDiscovery.output.citations.every((item) => item.source_relative_path.startsWith("医生介绍/")));

const breastDoctorDiscovery = invokeAgent("A-01", { message:"做丰胸的医生有哪些？", context:{ macro_stage:"售前" } });
assert.equal(breastDoctorDiscovery.output.structured_data.intent, "doctor_discovery_by_project");
assert.match(breastDoctorDiscovery.output.message, /叶丽萍院长|李健院长|谢卫国院长/);
assert.match(breastDoctorDiscovery.output.message, /假体丰胸|自体脂肪丰胸/);

const implantDoctorFollowup = invokeAgent("A-01", {
  message:"假体丰胸",
  context:{
    macro_stage:"售前",
    interests:["胸部整形"],
    known_projects:["胸部整形"],
    last_intent:"doctor_discovery_by_project",
    turn_index:2
  }
});
assert.equal(implantDoctorFollowup.output.structured_data.intent, "doctor_discovery_by_project");
assert.match(implantDoctorFollowup.output.message, /^您确定的是假体丰胸方向。/);
assert.match(implantDoctorFollowup.output.message, /叶丽萍院长|李健院长|谢卫国院长/);
assert.doesNotMatch(implantDoctorFollowup.output.message, /分为假体隆胸和自体脂肪隆胸两种方向/);
assert.deepEqual(implantDoctorFollowup.output.structured_data.next_questions, ["您想先看哪位医生的介绍？"]);

const implantProjectDetail = invokeAgent("A-01", {
  message:"假体丰胸",
  context:{ macro_stage:"售前", interests:["胸部整形"], known_projects:["胸部整形"], last_intent:"project_explanation", turn_index:2 }
});
assert.match(implantProjectDetail.output.message, /^假体丰胸是通过植入医用假体/);
assert.doesNotMatch(implantProjectDetail.output.message, /分为假体隆胸和自体脂肪隆胸两种方向/);

const implantShapeFollowup = invokeAgent("A-01", {
  message:"有哪些形态？",
  context:{
    macro_stage:"售前",
    interests:["胸部整形"],
    known_projects:["胸部整形"],
    known_slots:{ breast_method:"implant" },
    last_intent:"project_explanation",
    recent_turns:[{ role:"assistant", content:"您更想先了解假体形态，还是恢复安排？" }],
    turn_index:3
  }
});
assert.equal(implantShapeFollowup.output.structured_data.intent, "conversation_followup");
assert.match(implantShapeFollowup.output.message, /圆形和水滴形两类/);
assert.doesNotMatch(implantShapeFollowup.output.message, /主要关注哪个部位|最想改善什么问题/);
assert.equal(implantShapeFollowup.output.structured_data.facet, "implant_shape");

const fatMethodFollowup = invokeAgent("A-01", {
  message:"自体脂肪方式",
  context:{
    macro_stage:"售前",
    interests:["胸部整形"],
    known_projects:["胸部整形"],
    last_intent:"project_explanation",
    recent_turns:[
      { role:"user", content:"我想咨询一下丰胸项目" },
      { role:"assistant", content:"丰胸可以先分为假体隆胸和自体脂肪隆胸两种方向。您想先了解假体隆胸，还是自体脂肪隆胸？" }
    ],
    turn_index:2
  }
});
assert.equal(fatMethodFollowup.output.structured_data.intent, "project_explanation");
assert.match(fatMethodFollowup.output.message, /^您选的是自体脂肪丰胸：将自身其他部位脂肪处理后移植到胸部。/);
assert.doesNotMatch(fatMethodFollowup.output.message, /具体采用方式和填充安排，需要医生面诊确认/);
assert.doesNotMatch(fatMethodFollowup.output.message, /丰胸可以先分为假体隆胸和自体脂肪隆胸两种方向/);
assert.deepEqual(fatMethodFollowup.output.structured_data.next_questions, ["您更想先了解一般原理，还是恢复安排？"]);
assert.equal(fatMethodFollowup.output.structured_data.intent_analysis.context_used, true);
assert.equal(fatMethodFollowup.output.structured_data.intent_analysis.current_turn_overrides_context, false);

const fatPrincipleFollowup = invokeAgent("A-01", {
  message:"这是什么原理？",
  context:{
    macro_stage:"售前",
    interests:["胸部整形"],
    known_projects:["胸部整形"],
    known_slots:{ breast_method:"autologous_fat" },
    pending_choice:{
      field:"project_information_facet",
      label:"项目了解重点",
      options:[
        { value:"general_principle", label:"一般原理", aliases:["一般原理", "原理", "第一个", "1"], intent:"project_explanation", facet:"general_principle" },
        { value:"recovery", label:"恢复安排", aliases:["恢复安排", "恢复", "恢复期", "第二个", "2"], intent:"conversation_followup", facet:"recovery" }
      ]
    },
    last_intent:"project_explanation",
    recent_turns:[
      { role:"user", content:"自体脂肪隆胸" },
      { role:"assistant", content:"您选的是自体脂肪丰胸：将自身其他部位脂肪处理后移植到胸部。您更想先了解一般原理，还是恢复安排？" }
    ],
    turn_index:3
  }
});
assert.equal(fatPrincipleFollowup.output.structured_data.intent, "project_explanation");
assert.equal(fatPrincipleFollowup.output.structured_data.project, "自体脂肪隆胸");
assert.equal(fatPrincipleFollowup.output.structured_data.facet, "general_principle");
assert.deepEqual(fatPrincipleFollowup.output.structured_data.intent_analysis.entities.projects, ["自体脂肪隆胸"]);
assert.match(fatPrincipleFollowup.output.message, /自身其他部位的脂肪/);
assert.match(fatPrincipleFollowup.output.message, /移植到胸部/);
assert.doesNotMatch(fatPrincipleFollowup.output.message, /热玛吉|面部提升|当前改善问题/);
assert.deepEqual(fatPrincipleFollowup.output.citations.map((item) => item.source_record_id), ["KB-P-005"]);

const doctorComparison = invokeAgent("A-01", { message:"李健院长和叶丽萍医生怎么选？", context:{ macro_stage:"售前" } });
assert.equal(doctorComparison.output.structured_data.intent, "doctor_comparison");
assert.match(doctorComparison.output.message, /李健/);
assert.match(doctorComparison.output.message, /叶丽萍/);

const price = invokeAgent("A-01", { message:"双眼皮多少钱？", context:{ macro_stage:"售前", interests:["胸部整形"] } });
assert.equal(price.output.structured_data.intent, "price_verification");
assert.ok(price.output.citations.every((item) => item.source_relative_path.startsWith("项目价格/")));
assert.doesNotMatch(price.output.message, /(?:当前价是|现在只要|保证最低)\s*\d/);

const productAttribute = invokeAgent("A-01", { message:"丰胸：璀璨是水滴形吗？", context:{ macro_stage:"售前" } });
assert.equal(productAttribute.output.structured_data.intent, "product_attribute_verification");
assert.match(productAttribute.output.message, /璀璨/);
assert.match(productAttribute.output.message, /水滴形|解剖型/);
assert.equal(productAttribute.output.structured_data.next_questions.length, 0);
assert.ok(productAttribute.output.citations.length >= 1);
assert.ok(productAttribute.output.citations.every((item) => /璀璨/.test(item.excerpt || "")));
assert.ok(productAttribute.output.citations.every((item) => /水滴形|水滴型|解剖型/.test(item.excerpt || "")));

const naturalDoctorProfile = invokeAgent("A-01", { message:"你好，我想了解一下李健院长的项目", context:{ macro_stage:"售前" } });
assert.equal(naturalDoctorProfile.output.structured_data.intent, "doctor_profile");
assert.match(naturalDoctorProfile.output.message, /^李健院长的公开介绍/);
assert.doesNotMatch(naturalDoctorProfile.output.message, /一下李健/);
assert.match(naturalDoctorProfile.output.message, /鼻部整形/);
assert.match(naturalDoctorProfile.output.message, /面部年轻化与提升/);
assert.deepEqual(naturalDoctorProfile.output.structured_data.next_questions, ["您想先了解鼻部整形，还是面部年轻化与提升？"]);

const breastProject = invokeAgent("A-01", { message:"我想了解丰胸项目", context:{ macro_stage:"售前" } });
assert.equal(breastProject.output.structured_data.intent, "project_explanation");
assert.match(breastProject.output.message, /假体隆胸和自体脂肪隆胸/);
assert.doesNotMatch(breastProject.output.message, /乳头形状|胸部修复/);
assert.deepEqual(breastProject.output.structured_data.next_questions, ["您想先了解假体隆胸，还是自体脂肪隆胸？"]);

const genericWaterdrop = invokeAgent("A-01", { message:"水滴形项目有吗？", context:{ macro_stage:"售前" } });
assert.equal(genericWaterdrop.output.structured_data.intent, "product_attribute_verification");
assert.match(genericWaterdrop.output.message, /^有。水滴形是丰胸假体的一种形态，不是独立项目。/);
assert.match(genericWaterdrop.output.message, /曼托尊贵版/);

const starProductCatalog = invokeAgent("A-01", { message:"咱们华美的明星产品有哪些？", context:{ macro_stage:"售前", tenant_id:"huamei-shanghai" } });
assert.equal(starProductCatalog.output.structured_data.intent, "directory_discovery");
assert.match(starProductCatalog.output.message, /瑞可丽中胚产品/);
assert.match(starProductCatalog.output.message, /瑞可丽居家产品/);
assert.doesNotMatch(starProductCatalog.output.message, /主要关注哪个部位|最想改善什么问题/);
assert.deepEqual(starProductCatalog.output.structured_data.next_questions, ["您想先看哪一类？"]);

const faceMaskCatalogItem = invokeAgent("A-01", { message:"面膜", context:{ macro_stage:"售前", tenant_id:"huamei-shanghai" } });
assert.equal(faceMaskCatalogItem.output.structured_data.intent, "product_catalog_detail");
assert.equal(faceMaskCatalogItem.output.structured_data.analysis_intent, "need_clarification");
assert.match(faceMaskCatalogItem.output.message, /瑞可丽面膜/);
assert.doesNotMatch(faceMaskCatalogItem.output.message, /主要关注哪个部位|最想改善什么问题/);
assert.deepEqual(faceMaskCatalogItem.output.structured_data.next_questions, ["您想先看使用方式，还是规格信息？"]);
assert.ok(faceMaskCatalogItem.output.citations.some((item) => /明星产品.*面膜/.test(item.source_relative_path)));

const greeting = invokeAgent("A-01", { message:"你好", context:{ macro_stage:"售前", tenant_id:"tenant-huamei" } });
assert.equal(greeting.output.structured_data.intent, "conversation_greeting");
assert.equal(greeting.output.structured_data.dialogue_stage, "need_discovery");
assert.match(greeting.output.message, /华美AI获客顾问小美/);
assert.match(greeting.output.message, /您想先了解哪个项目/);
assert.doesNotMatch(greeting.output.message, /安安|网约车|会员权益|手机号|预算/);
assert.deepEqual(greeting.output.structured_data.next_questions, ["咨询医美项目", "了解面诊流程"]);

const restrictedCase = invokeAgent("A-01", { message:"发几个李健院长的案例照片", context:{ macro_stage:"售前" } });
assert.equal(restrictedCase.output.structured_data.intent, "case_request_restricted");
assert.equal(restrictedCase.output.citations.length, 0);
assert.match(restrictedCase.output.message, /核验授权|不能用别人的效果/);

const restrictedComparisonImage = invokeAgent("A-01", { message:"给我看看假体隆胸前后对比图", context:{ macro_stage:"售前" } });
assert.equal(restrictedComparisonImage.output.structured_data.intent, "case_request_restricted");
assert.equal(restrictedComparisonImage.status, "completed");

const thirdPartyPrivacy = invokeAgent("A-01", { message:"查一下我朋友在你们医院做过什么项目", context:{ macro_stage:"售前" } });
assert.equal(thirdPartyPrivacy.output.structured_data.intent, "privacy_or_complaint");
assert.equal(thirdPartyPrivacy.status, "blocked");

const appearanceSuitability = invokeAgent("A-01", { message:"我很自卑，想做双眼皮，你觉得我需要做吗？", context:{ macro_stage:"售前" } });
assert.equal(appearanceSuitability.output.structured_data.intent, "medical_suitability");
assert.equal(appearanceSuitability.status, "handover_required");

const namedDoctorPronoun = invokeAgent("A-01", {
  message:"发一下他做丰胸的宣传海报",
  context:{ macro_stage:"售前", known_doctors:["李健"], last_intent:"doctor_profile", turn_index:2 }
});
assert.equal(namedDoctorPronoun.output.structured_data.intent, "doctor_profile");
assert.ok(namedDoctorPronoun.output.citations.every((item) => item.source_relative_path.startsWith("医生介绍/")));

const birthmarkDiscovery = invokeAgent("A-01", { message:"我想去胎记，脸上有一块很大的胎记", context:{ macro_stage:"售前", tenant_id:"tenant-huamei" } });
assert.equal(birthmarkDiscovery.output.structured_data.intent, "project_discovery_by_concern");
assert.ok(birthmarkDiscovery.output.structured_data.intent_analysis.entities.concerns.includes("胎记"));
assert.ok(birthmarkDiscovery.output.structured_data.intent_analysis.entities.body_parts.includes("面部"));
assert.match(birthmarkDiscovery.output.message, /脸上.*胎记/);
assert.doesNotMatch(birthmarkDiscovery.output.message, /关注哪个部位|改善什么问题/);
assert.ok(birthmarkDiscovery.output.citations.length >= 1);
assert.ok(birthmarkDiscovery.output.citations.every((item) => item.source_relative_path.startsWith("项目价格/皮肤美容科/病症系列/")));

const birthmarkSubtype = invokeAgent("A-01", { message:"脸上的太田痣想了解一下", context:{ macro_stage:"售前", tenant_id:"tenant-huamei" } });
assert.equal(birthmarkSubtype.output.structured_data.intent, "project_discovery_by_concern");
assert.match(birthmarkSubtype.output.message, /脸上的太田痣/);
assert.doesNotMatch(birthmarkSubtype.output.message, /面积比较大|什么颜色|青褐色/);

const moleDiscovery = invokeAgent("A-01", { message:"我想去脸上的痣，有一块很大的", context:{ macro_stage:"售前", tenant_id:"tenant-huamei" } });
assert.equal(moleDiscovery.output.structured_data.intent, "project_discovery_by_concern");
assert.ok(moleDiscovery.output.structured_data.intent_analysis.entities.concerns.includes("痣"));
assert.ok(moleDiscovery.output.structured_data.intent_analysis.entities.body_parts.includes("面部"));
assert.match(moleDiscovery.output.message, /脸上.*面积比较大的痣/);
assert.doesNotMatch(moleDiscovery.output.message, /关注哪个部位|改善什么问题/);
assert.ok(moleDiscovery.output.citations.length >= 1);
assert.ok(moleDiscovery.output.citations.every((item) => item.source_relative_path.startsWith("项目介绍/皮肤美容科/点痣/")));

const acknowledgement = recognizeAcquisitionIntent("嗯嗯", { catalog, context:{ interests:["胸部整形"] }, risk:{ decision:"allow", matches:[] } });
assert.equal(acknowledgement.primary_intent, "conversation_acknowledgement");
assert.equal(acknowledgement.clarification_required, false);

const preferenceFollowup = invokeAgent("A-01", {
  message:"我想要自然一点，有垂感的",
  context:{ interests:["胸部整形"], known_projects:["胸部整形"], known_slots:{ style_preference:"自然、垂感" }, turn_index:2 }
});
assert.equal(preferenceFollowup.output.structured_data.intent, "conversation_followup");
assert.match(preferenceFollowup.output.message, /自然感和轻微垂感/);
assert.doesNotMatch(preferenceFollowup.output.message, /胸部.*基础条件|建议考虑|适合/);

const recoveryFollowup = invokeAgent("A-01", {
  message:"恢复大概要多久？",
  context:{
    interests:["胸部整形"], known_projects:["胸部整形"],
    last_intent:"project_explanation", turn_index:2
  }
});
assert.equal(recoveryFollowup.output.structured_data.intent, "conversation_followup");
assert.match(recoveryFollowup.output.message, /胸部|隆胸/);
assert.match(recoveryFollowup.output.message, /恢复/);
assert.doesNotMatch(recoveryFollowup.output.message, /关注哪个部位|改善什么问题/);

const confirmedPrice = invokeAgent("A-01", {
  message:"是的，帮我核验",
  context:{
    interests:["眼部整形"], known_projects:["眼部整形"],
    last_intent:"price_verification", turn_index:2
  }
});
assert.equal(confirmedPrice.output.structured_data.intent, "price_verification");
assert.match(confirmedPrice.output.message, /价格|报价|核验/);
assert.doesNotMatch(confirmedPrice.output.message, /关注哪个部位|改善什么问题/);

const contextualAppointment = invokeAgent("A-01", {
  message:"周末可以吗？",
  context:{
    interests:["眼部整形"], known_projects:["眼部整形"],
    last_intent:"price_verification", turn_index:3
  }
});
assert.equal(contextualAppointment.output.structured_data.intent, "appointment_query");
assert.match(contextualAppointment.output.message, /周末|到院时间|人工顾问实时确认/);
assert.ok(contextualAppointment.output.structured_data.projects.includes("眼部整形"));
assert.doesNotMatch(contextualAppointment.output.message, /关注哪个部位|改善什么问题/);

console.log(`✓ 售前意图体系v2通过${acquisitionIntentCases.length}个分类、实体链接与路由案例`);
console.log("✓ 历史上下文冲突、项目类型承接、恢复/核验/时间承接、医生发现/对比、价格证据路由和受限案例边界通过");
