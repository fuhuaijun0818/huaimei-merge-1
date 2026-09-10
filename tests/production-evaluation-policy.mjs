import assert from "node:assert/strict";

import {
  PRODUCTION_EVALUATION_POLICY_VERSION,
  PRODUCTION_METRIC_DEFINITIONS,
  REQUIRED_EVALUATION_FAMILIES,
  validateProductionEvaluationSubmission
} from "../scripts/production-evaluation-policy.mjs";

const families = Object.fromEntries(Object.keys(REQUIRED_EVALUATION_FAMILIES).map((name) => [name, {
  dataset_id:`${name}-dataset-001`,
  evidence_ref:`${name}-evidence-001`,
  sample_count:20,
  ...(name === "online_real_questions" ? { deidentified:true } : {}),
  ...(name === "manual_blind_review" ? { blind:true } : {})
}]));
const metrics = Object.fromEntries(Object.entries(PRODUCTION_METRIC_DEFINITIONS).map(([name, definition]) => [name, {
  value:definition.operator === "gte" ? definition.target + (definition.target < 1 ? 0.01 : 0.1) : definition.target,
  evidence_ref:`${name}-evidence-001`
}]));
const baseline = {
  policy_version:PRODUCTION_EVALUATION_POLICY_VERSION,
  evaluation_families:families,
  production_metrics:metrics
};

const accepted = validateProductionEvaluationSubmission(baseline);
assert.equal(accepted.ok, true, JSON.stringify(accepted.failures));
assert.equal(Object.keys(accepted.gates).length, 20);
assert.equal(Object.keys(accepted.families).length, 6);

const lowIntent = structuredClone(baseline);
lowIntent.production_metrics.core_intent_top1_accuracy.value = 0.949;
const rejectedIntent = validateProductionEvaluationSubmission(lowIntent);
assert.equal(rejectedIntent.ok, false);
assert.equal(rejectedIntent.gates.core_intent_top1_accuracy.passed, false);

const missingFamily = structuredClone(baseline);
delete missingFamily.evaluation_families.manual_blind_review;
const rejectedFamily = validateProductionEvaluationSubmission(missingFamily);
assert.equal(rejectedFamily.ok, false);
assert.ok(rejectedFamily.failures.includes("EVALUATION_FAMILY_SAMPLE_COUNT_INVALID:manual_blind_review"));

const missingEvidence = structuredClone(baseline);
missingEvidence.production_metrics.system_availability.evidence_ref = "";
const rejectedEvidence = validateProductionEvaluationSubmission(missingEvidence);
assert.equal(rejectedEvidence.ok, false);
assert.ok(rejectedEvidence.failures.includes("PRODUCTION_METRIC_EVIDENCE_REF_INVALID:system_availability"));

console.log("✓ 生产评测门槛、六类评测集与缺失证据失败关闭通过");
