import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { requestLangGraphTurn } from "../server/langgraph-orchestrator-client.mjs";

const python = fileURLToPath(new URL("../agent-orchestrator/.venv/bin/python", import.meta.url));
const port = 4192;
const secret = "orchestrator_live_contract_secret_7wP6yQ5rT4uE3iO2aS1dF0gH";
const service = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
  cwd:fileURLToPath(new URL("../agent-orchestrator/", import.meta.url)),
  env:{
    ...process.env,
    HUAMEI_LANGGRAPH_SERVICE_AUTH_SECRET:secret,
    HUAMEI_LANGGRAPH_RUNTIME_ENV:"development"
  },
  stdio:["ignore", "pipe", "pipe"]
});

let stderr = "";
service.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

const stop = async () => {
  if (service.exitCode !== null || service.signalCode) return;
  service.kill("SIGTERM");
  await Promise.race([once(service, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (service.exitCode === null && !service.signalCode) service.kill("SIGKILL");
};

try {
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (service.exitCode !== null) throw new Error(`LangGraph test service exited: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) { healthy = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(healthy, true, `LangGraph service did not become healthy: ${stderr}`);
  const result = await requestLangGraphTurn({
    tenantId:"huamei-shanghai",
    channel:"web",
    conversationId:"contract_conversation_1",
    messageId:"contract_message_1",
    message:"你好",
    turnSequence:1,
    expectedStateVersion:0,
    fencingToken:1,
    authorizationContext:"authorized-local-gateway-context",
    traceId:"req_live_contract_1"
  }, {
    env:{
      HUAMEI_AGENT_ENGINE:"shadow",
      HUAMEI_LANGGRAPH_ORCHESTRATOR_URL:`http://127.0.0.1:${port}`,
      HUAMEI_LANGGRAPH_SERVICE_AUTH_SECRET:secret,
      HUAMEI_LANGGRAPH_THREAD_SECRET:"orchestrator_live_thread_secret_7wP6yQ5rT4uE3iO2aS1dF0gH",
      HUAMEI_LANGGRAPH_SHADOW_ADMITTED:"true"
    }
  });
  assert.equal(result.used, true);
  assert.equal(result.decision.status, "prepared");
  assert.equal(result.decision.policy.decision, "allow");
  assert.match(result.threadId, /^lgth_/);
  console.log("✓ Node 与真实 LangGraph 服务的服务令牌、契约和安全决策闭环通过");
} finally {
  await stop();
}
