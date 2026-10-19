import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalGraphRagCacheQuery,
  getGraphRagStatus,
  resetGraphRagClientForTest,
  retrieveGraphRagKnowledge
} from "../server/graphrag-client.mjs";
import { loadHuameiKnowledge } from "../server/huamei-knowledge.mjs";

resetGraphRagClientForTest();
const knowledge = loadHuameiKnowledge();
assert.equal(knowledge.loaded, true);
const canonical = knowledge.publicRecords.find((record) => record.title.includes("李健")) || knowledge.publicRecords[0];
const canonicalFragment = String(canonical.content).trim().slice(0, 120);
const env = {
  HUAMEI_GRAPHRAG_ENABLED:"true",
  HUAMEI_GRAPHRAG_URL:"http://127.0.0.1:4191",
  HUAMEI_GRAPHRAG_TIMEOUT_MS:"500"
};
let calls = 0;
const fetchImpl = async (_url, options) => {
  calls += 1;
  const payload = JSON.parse(options.body);
  assert.equal(payload.tenant_id, "huamei-shanghai");
  assert.equal(payload.release_id, "krel_test_v1");
  assert.equal(payload.index_version, "test-index-v1");
  return new Response(JSON.stringify({
    engine:"official_graphrag_3_1_1",
    tenant_id:"huamei-shanghai",
    index_version:"test-index-v1",
    cache_hit:false,
    timing_ms:2.5,
    query_sha256:createHash("sha256").update(payload.query).digest("hex"),
    graph_entities:["不可信生成实体不得透传"],
    evidence:[{
      record_id:canonical.record_id, record_type:canonical.record_type, title:canonical.title,
      content:canonicalFragment, source_relative_path:canonical.source_relative_path,
      sensitivity:canonical.sensitivity, verification_note:canonical.verification_note,
      score:10, graph_paths:["不可信生成路径"],
      metadata:{ official_context:true, record_content_sha256:canonical.record_content_sha256 }
    }]
  }), { status:200, headers:{ "Content-Type":"application/json" } });
};

const [first, second] = await Promise.all([
  retrieveGraphRagKnowledge("李健院长擅长什么", {
    env, fetchImpl, tenantId:"huamei-shanghai", releaseId:"krel_test_v1", indexVersion:"test-index-v1"
  }),
  retrieveGraphRagKnowledge("李健院长擅长什么", {
    env, fetchImpl, tenantId:"huamei-shanghai", releaseId:"krel_test_v1", indexVersion:"test-index-v1"
  })
]);
assert.equal(calls, 1, "并发相同查询应复用同一个在途请求");
assert.equal(first.used, true);
assert.equal(second.evidence[0].record_id, canonical.record_id);
assert.equal(second.evidence[0].content, canonicalFragment, "citation必须保留已逐字校验的相关text-unit，不能替换为整条记录");
assert.deepEqual(second.evidence[0].graph_paths, [], "Graph生成路径不得作为事实透传");
assert.deepEqual(second.graphEntities, [], "Graph生成实体不得作为事实透传");
assert.equal(getGraphRagStatus(env).successes, 1);

assert.equal(
  canonicalGraphRagCacheQuery("热玛吉 多少钱"),
  canonicalGraphRagCacheQuery("热玛吉 价格"),
  "价格同义表达必须归一到同一缓存键"
);
assert.equal(
  canonicalGraphRagCacheQuery("价格 热玛吉"),
  canonicalGraphRagCacheQuery("热玛吉 价格"),
  "缓存键必须与词序无关"
);
const [price, quote] = await Promise.all([
  retrieveGraphRagKnowledge("热玛吉 价格", {
    env, fetchImpl, tenantId:"huamei-shanghai", releaseId:"krel_test_v1", indexVersion:"test-index-v1"
  }),
  retrieveGraphRagKnowledge("热玛吉 报价", {
    env, fetchImpl, tenantId:"huamei-shanghai", releaseId:"krel_test_v1", indexVersion:"test-index-v1"
  })
]);
assert.equal(calls, 2, "同义价格表达并发时只应发出一次GraphRAG请求");
assert.equal(quote.canonicalCacheShared, true, "第二个调用应标记为规范化缓存复用");
assert.equal(
  quote.querySha256,
  createHash("sha256").update("热玛吉 报价").digest("hex"),
  "缓存复用不得冒用首次查询的摘要"
);
assert.ok(price.latencyMs >= 0);
assert.equal(price.queryModelAttempts, 0);

await Promise.all([
  retrieveGraphRagKnowledge("热玛吉 恢复", {
    env, fetchImpl, tenantId:"huamei-shanghai", releaseId:"krel_test_v1", indexVersion:"test-index-v1",
    filters:{ record_types:["project_record"] }
  }),
  retrieveGraphRagKnowledge("热玛吉 恢复", {
    env, fetchImpl, tenantId:"huamei-shanghai", releaseId:"krel_test_v1", indexVersion:"test-index-v1",
    filters:{ record_types:["policy_record"] }
  })
]);
assert.equal(calls, 4, "不同过滤条件必须使用不同缓存键");

const rejected = async (mutation, expectedReason) => {
  resetGraphRagClientForTest();
  const body = {
    engine:"official_graphrag_3_1_1",
    tenant_id:"huamei-shanghai",
    index_version:"test-index-v1",
    evidence:[{
      record_id:canonical.record_id,
      record_type:canonical.record_type,
      title:canonical.title,
      content:canonical.content,
      source_relative_path:canonical.source_relative_path,
      sensitivity:canonical.sensitivity,
      verification_note:canonical.verification_note,
      score:1,
      metadata:{ official_context:true, record_content_sha256:canonical.record_content_sha256 }
    }]
  };
  mutation(body);
  const result = await retrieveGraphRagKnowledge(`integrity-${expectedReason}`, {
    env,
    tenantId:"huamei-shanghai",
    releaseId:"krel_test_v1",
    indexVersion:"test-index-v1",
    fetchImpl:async (_url, options) => {
      const payload = JSON.parse(options.body);
      if (!body.query_sha256) body.query_sha256 = createHash("sha256").update(payload.query).digest("hex");
      return Response.json(body);
    }
  });
  assert.equal(result.used, false);
  assert.equal(result.reason, expectedReason);
};

await rejected((body) => { body.engine = "bootstrap_graph"; }, "GRAPHRAG_OFFICIAL_ENGINE_REQUIRED");
await rejected((body) => { delete body.evidence[0].metadata.official_context; }, "GRAPHRAG_EVIDENCE_INTEGRITY_REJECTED");
await rejected((body) => { body.evidence[0].content = "被篡改的医疗结论"; }, "GRAPHRAG_EVIDENCE_INTEGRITY_REJECTED");
await rejected((body) => { body.evidence[0].title = "伪造标题"; }, "GRAPHRAG_EVIDENCE_INTEGRITY_REJECTED");
await rejected((body) => { body.query_sha256 = "0".repeat(64); }, "GRAPHRAG_QUERY_HASH_MISMATCH");

const disabled = await retrieveGraphRagKnowledge("测试", { env:{ HUAMEI_GRAPHRAG_ENABLED:"false" }, fetchImpl });
assert.equal(disabled.reason, "disabled");
console.log("✓ GraphRAG客户端在途去重、官方引擎、逐请求证据完整性与降级开关通过");
