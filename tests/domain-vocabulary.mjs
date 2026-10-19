import assert from "node:assert/strict";
import { buildDomainVocabulary, rewriteDomainQuery } from "../server/domain-vocabulary.mjs";
import { buildGraphRagQueryPlan, fuseHybridEvidence } from "../server/agent-runtime.mjs";
import { getKnowledgeAdmissionStatus } from "../server/knowledge-release-policy.mjs";
import { loadHuameiKnowledge } from "../server/huamei-knowledge.mjs";

const knowledge = loadHuameiKnowledge();
assert.equal(knowledge.loaded, true);
const admission = getKnowledgeAdmissionStatus("huamei-shanghai");
const releaseId = admission.active_release?.id || null;
const indexVersion = admission.active_release?.manifest?.index_version || null;
const vocabulary = buildDomainVocabulary(knowledge, { releaseId, indexVersion });

assert.match(vocabulary.version, /^domain-vocab-v1-[a-f0-9]{12}$/);
assert.equal(vocabulary.knowledge_version, knowledge.version);
assert.equal(vocabulary.release_id, releaseId);
assert.equal(vocabulary.index_version, indexVersion);
assert.ok(vocabulary.term_count >= 100, "领域词表应覆盖项目、医生、科室、部位和政策");
assert.ok((vocabulary.counts.project || 0) >= 10);
assert.ok((vocabulary.counts.doctor || 0) >= 10);
assert.ok((vocabulary.counts.department || 0) >= 2);
assert.ok((vocabulary.counts.policy || 0) >= 2);
assert.ok(vocabulary.allowed.has("热玛吉"));
assert.ok(vocabulary.allowed.has("价格"));
assert.ok(!vocabulary.allowed.has("image"), "原始素材标签不能进入出站词表");

const breast = rewriteDomainQuery("做胸一般怎么了解", { vocabulary });
assert.ok(breast.tokens.includes("胸部整形"));
assert.ok(breast.tokens.includes("隆胸"));
assert.ok(!breast.query.includes("做胸"), "改写后不得把原始口语直接作为GraphRAG查询");

const price = rewriteDomainQuery("热玛吉多少钱", { vocabulary });
assert.ok(price.tokens.includes("热玛吉"));
assert.ok(price.tokens.includes("价格"));
assert.ok(price.tokens.includes("费用"));

const doctor = rewriteDomainQuery("那个医生擅长什么", {
  vocabulary,
  context:{ known_doctors:["张群"] }
});
assert.ok(doctor.tokens.includes("张群院长"));
assert.ok(doctor.resolved.some((item) => item.entity === "doctor" && item.value === "张群院长"));

const followup = rewriteDomainQuery("这个项目恢复多久", {
  vocabulary,
  context:{ known_projects:["热玛吉"] }
});
assert.ok(followup.tokens.includes("热玛吉"));
assert.ok(followup.tokens.includes("恢复"));
assert.ok(followup.resolved.some((item) => item.entity === "project" && item.value === "热玛吉"));
for (const token of [...breast.tokens, ...price.tokens, ...doctor.tokens, ...followup.tokens]) {
  assert.ok(vocabulary.allowed.has(token), `出站token必须来自版本化词表：${token}`);
}

const localResponse = {
  output:{
    structured_data:{
      intent:"policy_verification",
      intent_analysis:{ entities:{ projects:[], doctors:[], concerns:[], quoted_terms:[], body_parts:[] } }
    },
    citations:[{ source_relative_path:"6月份政策/皮肤套餐" }]
  }
};
const plan = buildGraphRagQueryPlan("6月份皮肤套餐政策", localResponse, {
  tenant_id:"huamei-shanghai"
});
assert.equal(plan.vocabulary.version, vocabulary.version);
assert.match(plan.query, /6月份政策/);
assert.match(plan.query, /皮肤套餐/);
assert.ok(plan.rewrite.tokens.includes("政策"));

const fused = fuseHybridEvidence(
  [
    { knowledge_id:"kb_a", title:"local a", general_information:"A" },
    { knowledge_id:"kb_b", title:"local b", general_information:"B" }
  ],
  [
    { knowledge_id:"kb_b", title:"graph b", general_information:"B graph" },
    { knowledge_id:"kb_c", title:"graph c", general_information:"C" }
  ]
);
assert.deepEqual(fused.map((item) => item.knowledge_id).sort(), ["kb_a", "kb_b", "kb_c"]);
const b = fused.find((item) => item.knowledge_id === "kb_b");
assert.deepEqual(b.retrieval_sources.sort(), ["graph", "local"], "同一record_id必须融合而不是重复");
assert.ok(b.hybrid_rrf_score > 0);

console.log("✓ 领域词表版本、Query改写、多轮实体解析与RRF混合融合通过");
