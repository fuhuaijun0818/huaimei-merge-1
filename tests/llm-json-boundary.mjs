import assert from "node:assert/strict";
import { invokeAgentAsync } from "../server/agent-runtime.mjs";
import { completeAgentWithLlm } from "../server/llm-client.mjs";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
Object.assign(process.env, {
  HUAMEI_LLM_ENABLED:"true",
  HUAMEI_LLM_PROVIDER:"mock_openai_compatible",
  HUAMEI_LLM_BASE_URL:"http://127.0.0.1:9999/v1",
  HUAMEI_LLM_API_KEY:"test-secret",
  HUAMEI_LLM_MODEL:"test-model",
  HUAMEI_LLM_MAX_RETRIES:"0",
  HUAMEI_LLM_TIMEOUT_MS:"3000",
  HUAMEI_NATURAL_DIALOGUE_ENABLED:"false",
  HUAMEI_UNIFIED_TURN_PLANNING_ENABLED:"false",
  HUAMEI_SEMANTIC_UNDERSTANDING_ENABLED:"false"
});

const responseWith = (content) => new Response(JSON.stringify({
  model:"test-model",
  choices:[{ finish_reason:"stop", message:{ content } }],
  usage:{ prompt_tokens:10, completion_tokens:8, total_tokens:18 }
}), { status:200, headers:{ "Content-Type":"application/json" } });

try {
  const wrapped = JSON.stringify({
    status:"completed",
    message:"热玛吉属于射频类项目，具体方案需医生面诊确认。",
    used_evidence:[],
    uncertainties:[],
    structured_data:{ intent:"project_explanation" },
    recommended_actions:[],
    handover:{ required:false }
  });
  const recovered = await completeAgentWithLlm({
    agent:{ id:"A-01", name:"测试顾问" },
    input:{ message:"介绍一下热玛吉", mode:"assist" },
    context:{},
    localResult:{
      status:"completed",
      message:"热玛吉属于射频类项目。",
      structured_data:{ intent:"project_explanation" },
      recommended_actions:[],
      handover:{ required:false },
      citations:[]
    },
    fetchImpl:async () => responseWith(`下面是结构化结果：\n\`\`\`json\n${wrapped}\n\`\`\`\n请服务端校验。`)
  });
  assert.equal(recovered.used, true);
  assert.match(recovered.result.message, /射频类/);

  globalThis.fetch = async () => responseWith("模型返回的是普通文本，不是 JSON。");
  const fallback = await invokeAgentAsync("A-01", {
    message:"请介绍热玛吉的一般流程",
    mode:"assist",
    context:{ macro_stage:"售前", interests:["热玛吉"] }
  });
  assert.equal(fallback.guardrails.llm_used, false);
  assert.equal(fallback.guardrails.llm_fallback, true);
  assert.equal(fallback.guardrails.llm_fallback_reason, "INVALID_MODEL_JSON");
  assert.equal(fallback.usage.provider, "local_rule_runtime_fallback");
  assert.ok(fallback.output.message.length > 0);

  console.log("PASS LLM JSON boundary: wrapped JSON recovery and invalid-JSON deterministic fallback");
} finally {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
}
