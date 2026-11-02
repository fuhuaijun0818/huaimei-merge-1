import assert from "node:assert/strict";
import { completeAgentWithLlm, LlmRuntimeError } from "../server/llm-client.mjs";

const env = {
  HUAMEI_LLM_ENABLED:"true",
  HUAMEI_LLM_PROVIDER:"openai_compatible",
  HUAMEI_LLM_BASE_URL:"https://model.example.test/v1",
  HUAMEI_LLM_API_KEY:"test-context-key",
  HUAMEI_LLM_MODEL:"context-test-model",
  HUAMEI_LLM_TIMEOUT_MS:"5000",
  HUAMEI_LLM_MAX_RETRIES:"0",
  HUAMEI_LLM_CONTEXT_TOKEN_BUDGET:"4000",
  HUAMEI_LLM_CONTEXT_SAFETY_TOKENS:"100",
  HUAMEI_LLM_EVIDENCE_DOCUMENT_MAX_TOKENS:"250",
  HUAMEI_NATURAL_DIALOGUE_ENABLED:"true",
  HUAMEI_RISK_TIERED_REVIEW:"false",
  HUAMEI_EVIDENCE_RERANK_ENABLED:"false"
};

const agent = { id:"A-01", name:"AI获客顾问·小美", role:"项目科普与需求识别" };
const input = { message:"热玛吉是什么原理", mode:"reply" };
const context = {
  tenant_id:"huamei-shanghai",
  macro_stage:"售前",
  service_consent:true,
  recent_turns:[]
};
const localResult = {
  status:"completed",
  message:"热玛吉通过射频能量作用于皮肤，具体方案需医生面诊确认。",
  structured_data:{
    intent:"project_explanation",
    dialogue_stage:"knowledge_explanation",
    answer_routing:{ model_generation_mode:"natural_grounded_dialogue" },
    knowledge_hits:[
      {
        knowledge_id:"KB-P-001",
        title:"热玛吉原理",
        source_relative_path:"项目介绍/热玛吉",
        general_information:"热玛吉通过射频能量作用于皮肤，用于紧致和提升。".repeat(120),
        rerank_score:96
      },
      {
        knowledge_id:"KB-P-002",
        title:"热玛吉护理",
        source_relative_path:"项目介绍/热玛吉/护理",
        general_information:"恢复安排需结合个体情况由医生面诊确认。".repeat(120),
        rerank_score:72
      }
    ]
  },
  recommended_actions:[],
  handover:{ required:false },
  citations:[
    {
      knowledge_id:"CIT-001",
      source_record_id:"KB-P-001",
      title:"热玛吉原理",
      source_relative_path:"项目介绍/热玛吉",
      excerpt:"热玛吉通过射频能量作用于皮肤，用于紧致和提升。"
    },
    {
      knowledge_id:"CIT-002",
      source_record_id:"KB-P-002",
      title:"热玛吉护理",
      source_relative_path:"项目介绍/热玛吉/护理",
      excerpt:"恢复安排需结合个体情况由医生面诊确认。"
    }
  ],
  evidence_rerank:{ enabled:true, used:true, selected:2 }
};

const makeFetch = (usedEvidence) => async (_url, options) => {
  const request = JSON.parse(options.body);
  const review = request.messages[0].content.includes("独立答复审核器");
  const content = review
    ? { grounded:true, responsive:true, safe:true }
    : {
        status:"completed",
        message:"热玛吉主要通过射频能量作用于皮肤，具体方案由医生面诊确认。",
        used_evidence:usedEvidence,
        uncertainties:["具体方案需医生面诊确认"],
        structured_data:{ intent:"project_explanation" },
        recommended_actions:[],
        handover:{ required:false }
      };
  return new Response(JSON.stringify({
    model:"context-test-model",
    choices:[{ message:{ content:JSON.stringify(content) } }],
    usage:{ prompt_tokens:100, completion_tokens:30, total_tokens:130 }
  }), { status:200, headers:{ "Content-Type":"application/json" } });
};

let generationPayload = null;
const captureFetch = async (url, options) => {
  const request = JSON.parse(options.body);
  if (!request.messages[0].content.includes("独立答复审核器")) generationPayload = request;
  return makeFetch(["Doc1"])(url, options);
};
const completed = await completeAgentWithLlm({
  agent,
  input,
  context,
  localResult,
  env,
  fetchImpl:captureFetch
});
assert.equal(completed.used, true);
assert.equal(completed.evidenceValidation.valid, true);
assert.deepEqual(completed.evidenceValidation.used_labels, ["Doc1"]);
assert.deepEqual(completed.evidenceValidation.used_ids, ["CIT-001"]);
assert.ok(completed.contextUsage.documents_included >= 1);
assert.ok(completed.contextUsage.document_tokens <= completed.contextUsage.document_budget_tokens);

const generationUser = JSON.parse(generationPayload.messages[1].content);
assert.ok(Array.isArray(generationUser.documents));
assert.equal(generationUser.documents[0].label, "Doc1");
assert.equal(generationUser.documents[0].knowledge_id, "CIT-001");
assert.equal(generationUser.documents[0].source_record_id, "KB-P-001");
assert.equal(generationUser.approved_facts, undefined);
assert.ok(generationUser.documents[0].content.length < localResult.structured_data.knowledge_hits[0].general_information.length);

await assert.rejects(
  completeAgentWithLlm({
    agent,
    input,
    context,
    localResult,
    env,
    fetchImpl:makeFetch(["Doc99"])
  }),
  (error) => error instanceof LlmRuntimeError
    && error.code === "INVALID_EVIDENCE_REFERENCE"
);

const similarityFetch = async (url, options) => {
  if (String(url).endsWith("/v1/semantic-similarity")) {
    return new Response(JSON.stringify({
      model:"qwen3.7-text-embedding-flash",
      dimensions:1024,
      answer_similarity:0.2,
      min_clause_similarity:0.2,
      mean_clause_similarity:0.2,
      clauses:[{
        clause:"热玛吉通过射频能量作用于皮肤",
        max_score:0.2,
        best_document_id:"Doc1"
      }],
      cache_hit:false
    }), { status:200, headers:{ "Content-Type":"application/json" } });
  }
  return makeFetch(["Doc1"])(url, options);
};
await assert.rejects(
  completeAgentWithLlm({
    agent,
    input,
    context,
    localResult,
    env:{
      ...env,
      HUAMEI_EVIDENCE_SIMILARITY_ENABLED:"true",
      HUAMEI_EVIDENCE_SIMILARITY_URL:"http://127.0.0.1:4191",
      HUAMEI_EVIDENCE_SIMILARITY_MIN_CLAUSE_SCORE:"0.6",
      HUAMEI_EVIDENCE_SIMILARITY_BLOCKING:"true"
    },
    fetchImpl:similarityFetch
  }),
  (error) => error instanceof LlmRuntimeError
    && error.code === "EVIDENCE_SIMILARITY_BELOW_THRESHOLD"
);

console.log("PASS context engineering: DocN packing, token budget, evidence references and uncertainty schema");
