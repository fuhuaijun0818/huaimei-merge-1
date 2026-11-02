import assert from "node:assert/strict";
import { rerankEvidenceWithLlm } from "../server/llm-client.mjs";

const baseEnv = {
  HUAMEI_LLM_BASE_URL:"https://model.example.test/v1",
  HUAMEI_LLM_API_KEY:"test-rerank-key",
  HUAMEI_EVIDENCE_RERANK_ENABLED:"true",
  HUAMEI_EVIDENCE_RERANK_PROVIDER:"llm_listwise",
  HUAMEI_EVIDENCE_RERANK_MODEL:"rerank-test-model",
  HUAMEI_EVIDENCE_RERANK_TIMEOUT_MS:"2000",
  HUAMEI_EVIDENCE_RERANK_MIN_SCORE:"25",
  HUAMEI_EVIDENCE_RERANK_TOP_K:"2",
  HUAMEI_EVIDENCE_RERANK_MAX_CANDIDATES:"5"
};
const candidates = [
  { knowledge_id:"price", title:"双眼皮价格", general_information:"价格需按方案核验。" },
  { knowledge_id:"principle", title:"热玛吉原理", general_information:"热玛吉通过射频能量作用于皮肤。" },
  { knowledge_id:"policy", title:"6月套餐政策", general_information:"活动规则需要核验。" }
];

const fakeResponse = (scores) => async () => new Response(JSON.stringify({
  model:"rerank-test-model",
  choices:[{ message:{ content:JSON.stringify({ scores }) } }],
  usage:{ prompt_tokens:30, completion_tokens:20, total_tokens:50 }
}), { status:200, headers:{ "Content-Type":"application/json" } });

const ranked = await rerankEvidenceWithLlm({
  query:"热玛吉是什么原理",
  candidates,
  env:baseEnv,
  fetchImpl:fakeResponse([
    { id:"1", score:5 },
    { id:"2", score:95 },
    { id:"3", score:15 }
  ])
});
assert.equal(ranked.used, true);
assert.deepEqual(ranked.items.map((item) => item.knowledge_id), ["principle"]);
assert.equal(ranked.items[0].rerank_score, 95);

const incomplete = await rerankEvidenceWithLlm({
  query:"热玛吉是什么原理",
  candidates,
  env:baseEnv,
  fetchImpl:fakeResponse([{ id:"2", score:95 }])
});
assert.equal(incomplete.used, false);
assert.equal(incomplete.reason, "incomplete_scores");
assert.deepEqual(incomplete.items, candidates);

const disabled = await rerankEvidenceWithLlm({
  query:"热玛吉是什么原理",
  candidates,
  env:{ ...baseEnv, HUAMEI_EVIDENCE_RERANK_ENABLED:"false" },
  fetchImpl:async () => { throw new Error("disabled reranker must not call provider"); }
});
assert.equal(disabled.used, false);
assert.equal(disabled.reason, "disabled");
assert.deepEqual(disabled.items, candidates);

console.log("PASS evidence reranking: independent score ordering, cutoff, fallback and disabled path");
