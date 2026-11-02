import assert from "node:assert/strict";
import { checkEvidenceSimilarity } from "../server/evidence-similarity.mjs";

const env = {
  HUAMEI_EVIDENCE_SIMILARITY_ENABLED:"true",
  HUAMEI_EVIDENCE_SIMILARITY_URL:"http://127.0.0.1:4191",
  HUAMEI_EVIDENCE_SIMILARITY_TIMEOUT_MS:"2000",
  HUAMEI_EVIDENCE_SIMILARITY_MIN_CLAUSE_SCORE:"0.6",
  HUAMEI_EVIDENCE_SIMILARITY_BLOCKING:"true",
  HUAMEI_GRAPHRAG_SERVICE_KEY:"test-service-key"
};
const answer = "热玛吉通过射频能量作用于皮肤。具体方案需要面诊确认。";
const documents = [{ label:"Doc1", content:"热玛吉通过射频能量刺激胶原并提升紧致。" }];
const response = (clauses, options = {}) => async (_url, init) => {
  assert.equal(init.method, "POST");
  const body = JSON.parse(init.body);
  assert.equal(body.answer, answer);
  assert.deepEqual(body.documents, [{ id:"Doc1", text:documents[0].content }]);
  return new Response(JSON.stringify({
    model:"qwen3.7-text-embedding-flash",
    dimensions:1024,
    answer_similarity:0.82,
    min_clause_similarity:0.3,
    mean_clause_similarity:0.55,
    clauses,
    cache_hit:options.cacheHit === true
  }), { status:200, headers:{ "Content-Type":"application/json" } });
};

const passed = await checkEvidenceSimilarity({
  answer,
  documents,
  env,
  fetchImpl:response([
    { clause:"热玛吉通过射频能量作用于皮肤", max_score:0.86, best_document_id:"Doc1" },
    { clause:"具体方案需要面诊确认", max_score:0.34, best_document_id:"Doc1" }
  ], { cacheHit:true })
});
assert.equal(passed.used, true);
assert.equal(passed.passed, true);
assert.equal(passed.checked_clause_count, 1);
assert.equal(passed.low_clauses.length, 0);
assert.equal(passed.cache_hit, true);

const failed = await checkEvidenceSimilarity({
  answer,
  documents,
  env,
  fetchImpl:response([
    { clause:"热玛吉通过射频永久提升", max_score:0.28, best_document_id:"Doc1" }
  ])
});
assert.equal(failed.passed, false);
assert.equal(failed.low_clauses.length, 1);

const disabled = await checkEvidenceSimilarity({
  answer,
  documents,
  env:{ ...env, HUAMEI_EVIDENCE_SIMILARITY_ENABLED:"false" },
  fetchImpl:async () => { throw new Error("disabled similarity must not call service"); }
});
assert.equal(disabled.used, false);
assert.equal(disabled.reason, "disabled");

const unavailable = await checkEvidenceSimilarity({
  answer,
  documents,
  env,
  fetchImpl:async () => new Response(JSON.stringify({ error:"down" }), { status:503 })
});
assert.equal(unavailable.used, false);
assert.equal(unavailable.passed, true, "an unavailable auxiliary signal must fail open");

console.log("PASS embedding similarity: factual clause threshold, disclaimer exclusion, cache and fail-open");
