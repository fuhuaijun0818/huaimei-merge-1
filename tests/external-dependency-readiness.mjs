import assert from "node:assert/strict";
import {
  buildGraphRagReadinessQuery,
  probeProductionExternalDependencies,
  resetExternalDependencyReadinessForTest
} from "../server/platform/external-dependency-readiness.mjs";
import { evaluateAcquisitionDataPlaneReadiness } from "../server/acquisition-service-server.mjs";

const env = {
  HUAMEI_GRAPHRAG_ENABLED:"true",
  HUAMEI_GRAPHRAG_URL:"http://127.0.0.1:4191",
  HUAMEI_LLM_ENABLED:"true",
  HUAMEI_LLM_BASE_URL:"https://model.example.test/v1",
  HUAMEI_LLM_API_KEY:"readiness-test-key",
  HUAMEI_LLM_MODEL:"approved-model",
  HUAMEI_EXTERNAL_DEPENDENCY_READINESS_MAX_AGE_MS:"120000"
};
const domain = {
  knowledge_admission:{
    tenant_id:"huamei-shanghai",
    active_release:{ id:"krel_prod_v1", index_version:"graph-index-v1", approved_record_ids:["kb-readiness-probe"] }
  }
};
const probeRecord = {
  record_id:"kb-readiness-probe",
  record_type:"approved_knowledge_record",
  title:"上海华美医疗美容医院一般介绍",
  source_relative_path:"项目介绍/医院介绍.md",
  record_content_sha256:"a".repeat(64)
};
const groundedEvidence = [{
  record_id:probeRecord.record_id,
  title:probeRecord.title,
  source_relative_path:probeRecord.source_relative_path,
  content:"经三审的就绪探测记录。",
  metadata:{ official_context:true, record_content_sha256:probeRecord.record_content_sha256 }
}];

resetExternalDependencyReadinessForTest();
let graphCalls = 0;
let llmCalls = 0;
const dependencies = {
  probeRecord,
  graphRetriever:async (query, options) => {
    graphCalls += 1;
    assert.equal(query, "项目介绍");
    assert.equal(options.readinessProbe, true, "就绪探针必须以结构化标志绕过缓存，不能向模型查询拼nonce");
    assert.doesNotMatch(query, /\d{6,}|就绪探测编号|[。！？]/);
    assert.equal(options.releaseId, "krel_prod_v1");
    assert.equal(options.indexVersion, "graph-index-v1");
    return {
      used:true,
      engine:"official_graphrag_3_1_1",
      indexVersion:"graph-index-v1",
      evidence:groundedEvidence
    };
  },
  llmCompleter:async ({ localResult }) => {
    llmCalls += 1;
    assert.equal(localResult.message, "服务就绪探测通过。");
    return { used:true, usage:{ provider:"approved", model:"approved-model" } };
  }
};
assert.equal(buildGraphRagReadinessQuery(probeRecord), "项目介绍");
assert.throws(
  () => buildGraphRagReadinessQuery({ source_relative_path:"private-record.md" }),
  (error) => error?.code === "GRAPHRAG_READINESS_QUERY_UNSAFE"
);
const first = await probeProductionExternalDependencies({ env, domain, ...dependencies });
assert.equal(first.ok, true);
const cached = await probeProductionExternalDependencies({ env, domain, ...dependencies });
assert.equal(cached.ok, true);
assert.equal(cached.cached, true);
assert.equal(graphCalls, 1, "成功探测必须在有限窗口内复用，避免健康检查放大外部调用");
assert.equal(llmCalls, 1);

resetExternalDependencyReadinessForTest();
const graphDown = await probeProductionExternalDependencies({
  env,
  domain,
  graphRetriever:async () => ({ used:false, reason:"GRAPHRAG_HTTP_ERROR" }),
  probeRecord,
  llmCompleter:dependencies.llmCompleter
});
assert.equal(graphDown.ok, false);
assert.equal(graphDown.checks.graphrag.error_code, "GRAPHRAG_HTTP_ERROR");

resetExternalDependencyReadinessForTest();
const llmDown = await probeProductionExternalDependencies({
  env,
  domain,
  graphRetriever:dependencies.graphRetriever,
  probeRecord,
  llmCompleter:async () => { const error = new Error("unavailable"); error.code = "MODEL_TIMEOUT"; throw error; }
});
assert.equal(llmDown.ok, false);
assert.equal(llmDown.checks.llm.error_code, "MODEL_TIMEOUT");

for (const [result, expectedCode] of [
  [{ used:true, engine:"official_graphrag_3_1_1", indexVersion:"graph-index-v1", evidence:[] }, "GRAPHRAG_GROUNDED_PROBE_FAILED"],
  [{ used:true, engine:"bootstrap_graph", indexVersion:"graph-index-v1", evidence:groundedEvidence }, "GRAPHRAG_OFFICIAL_ENGINE_REQUIRED"],
  [{ used:true, engine:"official_graphrag_3_1_1", indexVersion:"wrong-index", evidence:groundedEvidence }, "GRAPHRAG_INDEX_BINDING_MISMATCH"],
  [{ used:true, engine:"official_graphrag_3_1_1", indexVersion:"graph-index-v1", evidence:[{ ...groundedEvidence[0], record_id:"kb-not-approved" }] }, "GRAPHRAG_UNAPPROVED_EVIDENCE"]
]) {
  resetExternalDependencyReadinessForTest();
  const failed = await probeProductionExternalDependencies({
    env,
    domain,
    probeRecord,
    graphRetriever:async () => result,
    llmCompleter:dependencies.llmCompleter
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.checks.graphrag.error_code, expectedCode);
}

resetExternalDependencyReadinessForTest();
const unbound = await probeProductionExternalDependencies({ env, domain:{ knowledge_admission:{} }, ...dependencies });
assert.equal(unbound.ok, false);
assert.equal(unbound.checks.knowledge_binding.error_code, "ACTIVE_KNOWLEDGE_BINDING_REQUIRED");
assert.equal(unbound.checks.graphrag.error_code, "GRAPHRAG_READINESS_PROBE_FAILED");

assert.equal(evaluateAcquisitionDataPlaneReadiness({
  production:true,
  domain:{ status:"degraded" },
  externalDependencies:{ ok:false, status:"not_ready" }
}).ok, false, "控制面可以启动时，未激活知识的数据面对客流量仍必须关闭");
assert.equal(evaluateAcquisitionDataPlaneReadiness({
  production:true,
  domain:{ status:"ok" },
  externalDependencies:{ ok:true, status:"ready" }
}).ok, true);

console.log("✓ 生产就绪门禁主动探测GraphRAG与LLM，并缓存成功结果、故障时fail closed");
