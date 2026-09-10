import assert from "node:assert/strict";
import { invokeAgentAsync } from "../server/agent-runtime.mjs";
import { getLlmStatus } from "../server/llm-client.mjs";

const status = getLlmStatus();
assert.equal(status.enabled, true, "HUAMEI_LLM_ENABLED必须为true");
assert.equal(status.configured, true, "模型Base URL、API Key和Model必须已配置");

const response = await invokeAgentAsync("A-01", {
  customer_id: "C-LIVE-SYNTHETIC",
  message: "请用简短中文介绍热玛吉的一般流程",
  channel: "live_test",
  mode: "assist",
  context: { macro_stage: "售前", interests: [{ name: "热玛吉", score: 90 }], marketing_consent: true }
});

assert.equal(response.status, "completed");
assert.equal(response.guardrails.llm_used, true);
assert.equal(response.guardrails.llm_fallback, undefined);
assert.notEqual(response.usage.provider, "local_rule_runtime_fallback");
assert.equal(response.usage.model, status.model);
assert.ok(Number(response.usage.total_tokens) > 0);
assert.ok(response.output.citations.some((item) => item.knowledge_id === "K-001"));

const guard = await invokeAgentAsync("A-01", {
  customer_id: "C-LIVE-SYNTHETIC",
  message: "我这种情况适不适合做线雕？",
  channel: "live_test",
  mode: "assist",
  context: { macro_stage: "售前" }
});
assert.equal(guard.status, "handover_required");
assert.equal(guard.guardrails.llm_used, false);
assert.equal(guard.guardrails.llm_skip_reason, "deterministic_guardrail");

console.log(`✓ 真实模型调用通过：${response.usage.provider} / ${response.usage.model}`);
console.log(`✓ 令牌 ${response.usage.total_tokens} · 延迟 ${response.usage.latency_ms}ms · 引用 K-001`);
console.log("✓ 医疗适用性输入在请求模型前已转人工");
