import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRequestContext,
  getObservability,
  parseTraceparent,
  resetObservabilityForTest,
  runWithRequestContext
} from "../server/observability/index.mjs";

const originalEnvironment = Object.fromEntries(Object.entries(process.env));
const runtimeRoot = await mkdtemp(join(tmpdir(), "huamei-observability-core-"));
const serviceName = `huamei-core-${randomUUID().slice(0, 8)}`;
const metricsToken = "core-metrics-token-with-at-least-32-characters";
const rawPhone = "13900139000";
const capturedLogs = [];

Object.assign(process.env, {
  HUAMEI_SERVICE_NAME:serviceName,
  HUAMEI_RUNTIME_ENV:"development",
  HUAMEI_PERSISTENCE_BACKEND:"json",
  HUAMEI_CACHE_BACKEND:"memory",
  HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:join(runtimeRoot, "operations.json"),
  HUAMEI_LLM_ENABLED:"true",
  HUAMEI_LLM_PROVIDER:"openai_compatible",
  HUAMEI_LLM_BASE_URL:"https://model.example.invalid/v1",
  HUAMEI_LLM_API_KEY:"sk-core-observability-secret-123456789",
  HUAMEI_LLM_MODEL:"huamei-core-test-model"
});
resetObservabilityForTest();
const observability = getObservability({
  service:serviceName,
  environment:"production",
  write:(line) => capturedLogs.push(line)
});

try {
  const { completeAgentWithLlm } = await import("../server/llm-client.mjs");
  const { resetGraphRagClientForTest, retrieveGraphRagKnowledge } = await import("../server/graphrag-client.mjs");
  const {
    claimHandover,
    completeHandover,
    ensureHandoverTask,
    resetOperationsStoreForTest
  } = await import("../server/acquisition-operations-store.mjs");
  const { createPostgresOutboxWorker } = await import("../server/workers/postgres-outbox-worker.mjs");

  resetGraphRagClientForTest();
  resetOperationsStoreForTest();
  const inboundTrace = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const context = createRequestContext({
    service:serviceName,
    requestId:"core-observability-request-1",
    traceparent:inboundTrace
  });

  await runWithRequestContext(context, async () => {
    const modelResult = await completeAgentWithLlm({
      agent:{ id:"A-01", name:"小美", role:"售前顾问" },
      input:{ message:`我的手机号是${rawPhone}，想了解项目`, mode:"assist" },
      context:{},
      localResult:{
        status:"completed",
        message:"可以先了解项目信息。",
        structured_data:{},
        recommended_actions:[],
        handover:{ required:false },
        citations:[]
      },
      fetchImpl:async (_url, options) => {
        assert.equal(options.headers["X-Request-Id"], context.requestId);
        assert.equal(parseTraceparent(options.headers.traceparent).traceId, context.traceId);
        const payload = JSON.parse(options.body);
        return new Response(JSON.stringify({
          model:"huamei-core-test-model",
          choices:[{ message:{ content:JSON.stringify({
            status:"completed",
            message:"可以先了解项目的一般信息。",
            structured_data:{},
            recommended_actions:[],
            handover:{ required:false }
          }) } }],
          usage:{ prompt_tokens:60, completion_tokens:20, total_tokens:80 }
        }), { status:200, headers:{ "Content-Type":"application/json" } });
      }
    });
    assert.equal(modelResult.used, true);

    const graphResult = await retrieveGraphRagKnowledge("查询不应进指标标签", {
      env:{ HUAMEI_GRAPHRAG_ENABLED:"true", HUAMEI_GRAPHRAG_URL:"http://127.0.0.1:4191" },
      tenantId:"tenant-observe",
      releaseId:"release-observe",
      indexVersion:"index-observe",
      fetchImpl:async (_url, options) => {
        assert.equal(options.headers["X-Request-Id"], context.requestId);
        assert.equal(parseTraceparent(options.headers.traceparent).traceId, context.traceId);
        const payload = JSON.parse(options.body);
        return new Response(JSON.stringify({
          engine:"official_graphrag_3_1_1",
          tenant_id:"tenant-observe",
          index_version:"index-observe",
          cache_hit:false,
          timing_ms:3,
          query_sha256:createHash("sha256").update(payload.query).digest("hex"),
          graph_entities:[],
          evidence:[]
        }), { status:200, headers:{ "Content-Type":"application/json" } });
      }
    });
    assert.equal(graphResult.used, true);
  });

  const envelope = {
    tenant_id:"tenant-observe",
    channel:"web",
    conversation_id:"conversation-observe",
    actor:{},
    message:{ id:"message-observe", text:"需要人工顾问" }
  };
  const handover = await ensureHandoverTask({
    envelope,
    result:{ status:"handover_required", handover:{ required:true, reason:"medical_safety", to_team:"人工咨询" } },
    session_snapshot:{},
    contact_initiation:"customer_inbound"
  });
  const claimed = await claimHandover(handover.id, { tenant_id:"tenant-observe", assignee:"观测顾问" });
  await completeHandover(handover.id, { tenant_id:"tenant-observe", actor:claimed.assignee, resolution:"已处理" });

  let claimedOutbox = false;
  const leaseToken = randomUUID();
  const fakeStore = {
    claimBatch:async () => {
      if (claimedOutbox) return [];
      claimedOutbox = true;
      return [{
        tenantId:"tenant-observe",
        eventId:`evt-${randomUUID()}`,
        eventType:"integration.observability",
        aggregateType:"integration",
        aggregateId:"aggregate-observe",
        payload:{},
        headers:{},
        attempt:1,
        leaseToken,
        createdAt:new Date().toISOString(),
        recoveredLease:false
      }];
    },
    renewLease:async () => ({}),
    markPublished:async () => ({ status:"published" }),
    markFailed:async () => ({ status:"retry" }),
    metrics:async () => ({
      tenantId:"tenant-observe", pending:0, retry:0, processing:0, published:1,
      deadLetter:0, ready:0, expiredLeases:0, backlog:0, oldestBacklogSeconds:0
    })
  };
  const worker = createPostgresOutboxWorker({
    store:fakeStore,
    tenantIds:["tenant-observe"],
    workerId:"worker-observe",
    observability,
    publish:async (_event, outboundContext) => {
      assert.ok(outboundContext.idempotencyKey);
      return { sink:"observability-test" };
    }
  });
  assert.equal(await worker.runOnce(), 1);
  for (let attempt = 0; attempt < 50 && worker.inFlight > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(worker.inFlight, 0);
  await worker.metrics();

  const { createAcquisitionServiceServer } = await import("../server/acquisition-service-server.mjs");
  const server = createAcquisitionServiceServer({
    host:"127.0.0.1",
    metricsToken,
    observability
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${baseUrl}/health`, {
      headers:{ "X-Request-Id":context.requestId, traceparent:inboundTrace }
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-request-id"), context.requestId);
    assert.equal(parseTraceparent(health.headers.get("traceparent")).traceId, context.traceId);

    const denied = await fetch(`${baseUrl}/metrics`);
    assert.equal(denied.status, 401);
    const metrics = await fetch(`${baseUrl}/metrics`, { headers:{ Authorization:`Bearer ${metricsToken}` } });
    assert.equal(metrics.status, 200);
    const body = await metrics.text();
    assert.match(body, /huamei_http_requests_total\{/);
    assert.match(body, /huamei_model_requests_total\{[^\n]*outcome="success"[^\n]*\} 1/);
    assert.match(body, /huamei_graphrag_queries_total\{[^\n]*outcome="success"[^\n]*\} 1/);
    assert.match(body, /huamei_handovers_total\{[^\n]*event="requested"[^\n]*\} 1/);
    assert.match(body, /huamei_handovers_total\{[^\n]*event="claimed"[^\n]*\} 1/);
    assert.match(body, /huamei_handovers_total\{[^\n]*event="completed"[^\n]*\} 1/);
    assert.match(body, /huamei_outbox_deliveries_total\{[^\n]*outcome="claimed"[^\n]*\} 1/);
    assert.match(body, /huamei_outbox_deliveries_total\{[^\n]*outcome="published"[^\n]*\} 1/);
    assert.equal(body.includes(rawPhone), false);
    assert.equal(body.includes("查询不应进指标标签"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const serializedLogs = capturedLogs.join("\n");
  assert.equal(serializedLogs.includes(rawPhone), false);
  assert.equal(serializedLogs.includes("sk-core-observability-secret"), false);
  assert.ok(capturedLogs.some((line) => JSON.parse(line).event === "model.call.completed"));
  assert.ok(capturedLogs.some((line) => JSON.parse(line).event === "graphrag.query.completed"));
  assert.ok(capturedLogs.some((line) => JSON.parse(line).event === "http.request.completed"));

  console.log("✓ acquisition HTTP、LLM、GraphRAG、转人工与Outbox真实接入产生非零指标");
  console.log("✓ request_id/traceparent出入站一致，手机号、query与凭据未进入指标或日志");
} finally {
  await rm(runtimeRoot, { recursive:true, force:true });
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
}
