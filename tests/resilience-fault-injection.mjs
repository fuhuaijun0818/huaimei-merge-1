import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

Object.assign(process.env, {
  NODE_ENV:"test",
  HUAMEI_RUNTIME_ENV:"development",
  HUAMEI_PERSISTENCE_BACKEND:"memory",
  HUAMEI_CACHE_BACKEND:"memory",
  HUAMEI_ACQUISITION_SESSION_STORE_FILE:":memory:",
  HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:":memory:",
  HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE:":memory:",
  HUAMEI_LLM_ENABLED:"true",
  HUAMEI_LLM_PROVIDER:"fault_injection",
  HUAMEI_LLM_BASE_URL:"http://127.0.0.1:9999/v1",
  HUAMEI_LLM_API_KEY:"fault-injection-key-not-for-production",
  HUAMEI_LLM_MODEL:"fault-injection-model",
  HUAMEI_LLM_TIMEOUT_MS:"2000",
  HUAMEI_LLM_MAX_RETRIES:"0",
  HUAMEI_GRAPHRAG_ENABLED:"false"
});

const originalFetch = globalThis.fetch;
const results = [];
const passed = (id, evidence) => results.push({ id, status:"passed", evidence });
const faultError = (name, message) => Object.assign(new Error(message), { name });

const matrix = JSON.parse(await readFile(
  new URL("../docs/operations/resilience-fault-matrix.json", import.meta.url),
  "utf8"
));
assert.equal(matrix.schema_version, "huamei.resilience-fault-matrix.v1");
const matrixIds = new Set(matrix.scenarios.map((item) => item.id));

const { invokeAgentAsync, resetRunsForTest } = await import("../server/agent-runtime.mjs");
const llmFaults = [
  {
    id:"llm_timeout",
    expected:"MODEL_TIMEOUT",
    fetchImpl:async () => { throw faultError("TimeoutError", "simulated timeout"); }
  },
  {
    id:"llm_rate_limited",
    expected:"MODEL_HTTP_ERROR",
    fetchImpl:async () => new Response(JSON.stringify({ error:{ code:"rate_limited" } }), {
      status:429,
      headers:{ "Content-Type":"application/json" }
    })
  },
  {
    id:"llm_invalid_json",
    expected:"INVALID_PROVIDER_JSON",
    fetchImpl:async () => new Response("not-json", {
      status:200,
      headers:{ "Content-Type":"application/json" }
    })
  },
  {
    id:"llm_network_disconnected",
    expected:"MODEL_NETWORK_ERROR",
    fetchImpl:async () => { throw faultError("Error", "simulated network unavailable"); }
  }
];

try {
  resetRunsForTest();
  for (const fault of llmFaults) {
    assert.ok(matrixIds.has(fault.id), `故障矩阵缺少 ${fault.id}`);
    globalThis.fetch = fault.fetchImpl;
    const response = await invokeAgentAsync("A-02", {
      message:"周三可以预约吗？",
      mode:"assist",
      context:{ available_slots:["周三 12:20"] }
    });
    assert.equal(response.guardrails.llm_fallback, true, `${fault.id} 必须安全回退`);
    assert.equal(response.guardrails.llm_fallback_reason, fault.expected);
    assert.equal(response.usage.provider, "local_rule_runtime_fallback");
    assert.match(response.output.message, /周三 12:20/);
    assert.doesNotMatch(response.output.message, /MODEL_|HTTP 429|network unavailable|not-json/i);
    passed(fault.id, "local deterministic answer returned; provider content discarded");
  }
  globalThis.fetch = originalFetch;

  const {
    resetGraphRagClientForTest,
    retrieveGraphRagKnowledge
  } = await import("../server/graphrag-client.mjs");
  const graphEnv = {
    HUAMEI_GRAPHRAG_ENABLED:"true",
    HUAMEI_GRAPHRAG_URL:"http://127.0.0.1:4191",
    HUAMEI_GRAPHRAG_TIMEOUT_MS:"200"
  };
  const graphOptions = {
    env:graphEnv,
    tenantId:"huamei-shanghai",
    releaseId:"krel_resilience_v1",
    indexVersion:"resilience-index-v1"
  };
  const dirtyEvidence = [{
    record_id:"unreviewed-record",
    title:"未审核证据",
    content:"不应进入对客回答"
  }];
  const graphFaults = [
    {
      id:"graphrag_timeout",
      reason:"timeout",
      fetchImpl:async () => { throw faultError("TimeoutError", "simulated retrieval timeout"); }
    },
    {
      id:"graphrag_5xx",
      reason:"GRAPHRAG_HTTP_ERROR",
      fetchImpl:async () => new Response(JSON.stringify({ evidence:dirtyEvidence }), {
        status:503,
        headers:{ "Content-Type":"application/json" }
      })
    },
    {
      id:"graphrag_binding_mismatch",
      reason:"GRAPHRAG_BINDING_REJECTED",
      fetchImpl:async (_url, options) => {
        const request = JSON.parse(options.body);
        assert.equal(request.release_id, "krel_resilience_v1");
        assert.equal(request.index_version, "resilience-index-v1");
        return new Response(JSON.stringify({
          request_id:"wrong-binding",
          tenant_id:"another-tenant",
          index_version:"unreviewed-index",
          engine:"official_graphrag_3_1_1",
          retrieval_mode:"local",
          evidence:dirtyEvidence,
          graph_entities:[],
          cache_hit:false,
          timing_ms:1
        }), { status:200, headers:{ "Content-Type":"application/json" } });
      }
    }
  ];
  for (const fault of graphFaults) {
    assert.ok(matrixIds.has(fault.id), `故障矩阵缺少 ${fault.id}`);
    resetGraphRagClientForTest();
    const response = await retrieveGraphRagKnowledge("李健院长擅长什么", {
      ...graphOptions,
      fetchImpl:fault.fetchImpl
    });
    assert.equal(response.used, false);
    assert.equal(response.reason, fault.reason);
    assert.deepEqual(response.evidence, [], `${fault.id} 不得使用下游证据`);
    passed(fault.id, "retrieval evidence discarded and local knowledge path retained");
  }

  const metricsToken = "resilience_metrics_token_2026_32_chars_minimum";
  let readiness = {
    ok:false,
    checks:{
      postgres:{ ok:false, status:"unavailable" },
      redis:{ ok:true, status:"ready" }
    }
  };
  const { createAcquisitionServiceServer } = await import("../server/acquisition-service-server.mjs");
  const server = createAcquisitionServiceServer({
    host:"127.0.0.1",
    metricsToken,
    readiness:async () => readiness
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200, "liveness 不应伪装成 readiness");
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 401, "readiness 必须受保护");
    const postgresDown = await fetch(`${baseUrl}/readyz`, {
      headers:{ Authorization:`Bearer ${metricsToken}` }
    });
    assert.equal(postgresDown.status, 503);
    assert.equal((await postgresDown.json()).checks.postgres.ok, false);
    passed("acquisition_postgres_unavailable", "healthz=200, authenticated readyz=503");

    readiness = {
      ok:false,
      checks:{
        postgres:{ ok:true, status:"ready" },
        redis:{ ok:false, status:"unavailable" }
      }
    };
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    const redisDown = await fetch(`${baseUrl}/readyz`, {
      headers:{ "X-Metrics-Token":metricsToken }
    });
    assert.equal(redisDown.status, 503);
    assert.equal((await redisDown.json()).checks.redis.ok, false);
    passed("acquisition_redis_unavailable", "healthz=200, authenticated readyz=503");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const {
    getAcquisitionSession,
    prepareAcquisitionSessionContext,
    recordAcquisitionSessionTurn,
    resetAcquisitionSessionsForTest
  } = await import("../server/acquisition-session.mjs");
  resetAcquisitionSessionsForTest();
  const tenantId = "resilience-tenant";
  const channel = "api";
  const conversationId = "recover-same-message";
  const sessionId = `${tenantId}:${channel}:${conversationId}`;
  const message = "我想了解光子嫩肤";
  const metadata = {
    tenantId,
    channel,
    externalConversationId:conversationId,
    inboundMessageId:"recover-message-1"
  };
  prepareAcquisitionSessionContext(sessionId, message, [], metadata);
  // Simulate process interruption after receipt registration and before the
  // assistant result commit, then replay the exact channel message id.
  prepareAcquisitionSessionContext(sessionId, message, [], metadata);
  const result = {
    status:"completed",
    output:{
      message:"先说您最关心的皮肤问题，我按这个方向给您介绍。",
      citations:[],
      structured_data:{ intent:"project_explanation", intent_analysis:{ entities:{ projects:["光子嫩肤"] } } }
    }
  };
  const firstCommit = recordAcquisitionSessionTurn(sessionId, {
    message_id:metadata.inboundMessageId,
    message,
    result,
    projects:["光子嫩肤"]
  }, metadata);
  const replayCommit = recordAcquisitionSessionTurn(sessionId, {
    message_id:metadata.inboundMessageId,
    message,
    result,
    projects:["光子嫩肤"]
  }, metadata);
  assert.equal(firstCommit.turn_count, 1);
  assert.deepEqual(replayCommit, firstCommit);
  assert.equal(getAcquisitionSession(sessionId).turn_count, 1);
  passed("conversation_same_message_recovery", "same message_id resumed with exactly one committed turn");

  const {
    claimHandover,
    ensureHandoverTask,
    getOperationsStoreStatus,
    resetOperationsStoreForTest
  } = await import("../server/acquisition-operations-store.mjs");
  const { processAcquisitionEnvelope } = await import("../server/acquisition-domain-service.mjs");
  resetOperationsStoreForTest();
  const handoverEnvelope = {
    tenant_id:tenantId,
    channel,
    conversation_id:"human-active-conversation",
    actor:{ external_user_id:"anonymous-resilience-user" },
    message:{ id:"handover-trigger", text:"我要转人工" },
    context:{},
    interests:[]
  };
  const handover = await ensureHandoverTask({
    envelope:handoverEnvelope,
    result:{ status:"handover_required", handover:{ required:true, reason:"human_requested", to_team:"人工咨询" } },
    session_snapshot:{ conversation_summary:"客户主动要求人工" },
    contact_initiation:"customer_inbound"
  });
  await claimHandover(handover.id, { tenant_id:tenantId, assignee:"故障演练顾问" });
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls += 1;
    throw new Error("人工接管后不应调用任何模型");
  };
  const duringHandover = await processAcquisitionEnvelope({
    ...handoverEnvelope,
    message:{ id:"handover-inbound-1", text:"还有人在吗？" }
  }, { requestId:"resilience-handover" });
  assert.equal(duringHandover.status, "human_active");
  assert.equal(duringHandover.delivery.suppress_ai, true);
  assert.equal(duringHandover.reply.text, "");
  assert.deepEqual(duringHandover.reply.segments, []);
  assert.equal(duringHandover.guardrails.llm_used, false);
  assert.equal(modelCalls, 0);
  const eventCount = (await getOperationsStoreStatus(tenantId)).events;
  const replayDuringHandover = await processAcquisitionEnvelope({
    ...handoverEnvelope,
    message:{ id:"handover-inbound-1", text:"还有人在吗？" }
  }, { requestId:"resilience-handover-replay" });
  assert.equal(replayDuringHandover.delivery.suppress_ai, true);
  assert.equal((await getOperationsStoreStatus(tenantId)).events, eventCount);
  passed("handover_ai_silent", "AI output empty, model calls=0, replay did not duplicate inbound event");

  for (const id of [
    "acquisition_postgres_unavailable",
    "acquisition_redis_unavailable",
    "conversation_same_message_recovery",
    "handover_ai_silent",
    "outbox_retry",
    "outbox_dead_letter",
    "outbox_lease_recovery"
  ]) assert.ok(matrixIds.has(id), `故障矩阵缺少 ${id}`);

  const automatedIds = new Set(matrix.scenarios.filter((item) => item.automation === "automated").map((item) => item.id));
  for (const result of results) assert.ok(automatedIds.has(result.id), `${result.id} 未在矩阵标记为自动化`);
  console.log(JSON.stringify({
    schema_version:"huamei.resilience-test-summary.v1",
    status:"passed",
    passed:results.length,
    scenarios:results
  }));
} finally {
  globalThis.fetch = originalFetch;
}
