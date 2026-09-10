import assert from "node:assert/strict";
import { buildChoicePrompt, deriveChoicePrompt, resolvePendingChoice } from "../server/acquisition-choice-slots.mjs";

const breast = buildChoicePrompt("breast_method");
assert.equal(breast.field, "breast_method");
assert.equal(resolvePendingChoice("自体脂肪方式", breast).selection.value, "autologous_fat");
assert.equal(resolvePendingChoice("第二个", breast).selection.value, "autologous_fat");
assert.equal(resolvePendingChoice("不要假体，选自体脂肪", breast).selection.value, "autologous_fat");
assert.equal(resolvePendingChoice("都不选", breast).status, "cancelled");

const service = buildChoicePrompt("service_entry");
assert.equal(resolvePendingChoice("2", service).selection.value, "consultation_process");

const implantFacet = deriveChoicePrompt({ next_questions:["您更想先了解假体形态，还是恢复安排？"] });
assert.equal(implantFacet.field, "implant_information_facet");
assert.equal(resolvePendingChoice("有哪些形态？", implantFacet).selection.facet, "implant_shape");

const doctor = deriveChoicePrompt({
  next_questions:["您想先看哪位医生的介绍？"],
  doctor_candidates:[{ name:"李健" }, { name:"叶丽萍" }]
});
assert.equal(doctor.field, "doctor_candidate");
assert.equal(resolvePendingChoice("第二位", doctor).selection.doctor, "叶丽萍");

console.log("✓ 通用待选择槽位的口语、编号、否定纠正与动态医生候选解析通过");
