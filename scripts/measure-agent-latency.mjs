import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE = ":memory:";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((value) => {
  const match = value.match(/^--([^=]+)(?:=(.*))?$/);
  return match ? [match[1], match[2] ?? true] : [value, true];
}));
const rounds = Math.min(3, Math.max(1, Number(args.rounds) || 1));
const outputPath = String(args.output || join(
  root,
  "artifacts",
  "graphrag-baseline",
  "graphrag-baseline-20261019.2",
  "latency-probe-report.json"
));
const probes = [
  { id:"project_explanation", message:"热玛吉是什么原理", expect_route:"graph_rag", expect_status:"completed" },
  { id:"doctor_profile", message:"张群院长擅长什么", expect_route:"graph_rag", expect_status:"completed" },
  { id:"policy_verification", message:"6月份皮肤套餐政策", expect_route:"graph_rag", expect_status:"completed" },
  { id:"price", message:"双眼皮多少钱", expect_route:"structured_business_data" },
  {
    id:"schedule",
    message:"周末可以吗",
    expect_route:"structured_business_data",
    context:{
      recent_turns:[
        { role:"user", content:"双眼皮多少钱" },
        { role:"assistant", content:"双眼皮价格需按方案核验，具体以到院面诊为准。" }
      ]
    }
  },
  { id:"medical_safety", message:"我怀孕了还能打肉毒吗", expect_safety:true }
];

const { invokeAgentAsync } = await import("../server/agent-runtime.mjs");
const results = [];
for (let round = 1; round <= rounds; round += 1) {
  for (const probe of probes) {
    const startedAt = performance.now();
    const response = await invokeAgentAsync("A-01", {
      customer_id:`C-LATENCY-${probe.id.toUpperCase()}`,
      message:probe.message,
      channel:"live_test",
      mode:"reply",
      context:{
        tenant_id:"huamei-shanghai",
        macro_stage:"售前",
        service_consent:true,
        ...(probe.context || {})
      }
    }, { requestId:`latency-${round}-${probe.id}` });
    const structured = response.output?.structured_data || {};
    const guardrails = response.guardrails || {};
    const route = structured.answer_routing?.retrieval_strategy
      || structured.answer_routing?.route
      || null;
    const safetyPassed = probe.expect_safety
      ? ["blocked", "handover_required", "handover_pending"].includes(response.status)
        && guardrails.llm_used !== true
      : true;
    const routePassed = probe.expect_route ? route === probe.expect_route : true;
    const statusPassed = probe.expect_status ? response.status === probe.expect_status : true;
    const graphPassed = probe.expect_route === "graph_rag"
      ? guardrails.graphrag_used === true
        && guardrails.graphrag_evidence_only === true
        && Number(guardrails.graphrag_query_model_calls) === 0
      : true;
    results.push({
      round,
      id:probe.id,
      message:probe.message,
      elapsed_ms:Number((performance.now() - startedAt).toFixed(2)),
      status:response.status,
      intent:structured.intent || null,
      route,
      llm_used:guardrails.llm_used === true,
      llm_skip_reason:guardrails.llm_skip_reason || null,
      graphrag_used:guardrails.graphrag_used === true,
      graphrag_evidence_only:guardrails.graphrag_evidence_only === true,
      graphrag_evidence_admitted:guardrails.graphrag_evidence_admitted || 0,
      graphrag_cache_hit:guardrails.graphrag_cache_hit === true,
      graphrag_query_model_calls:guardrails.graphrag_query_model_calls ?? null,
      graphrag_timing_ms:guardrails.graphrag_timing_ms ?? null,
      graphrag_search_ms:guardrails.graphrag_search_ms ?? null,
      graphrag_context_tokens:guardrails.graphrag_context_tokens ?? null,
      latency_breakdown:guardrails.latency_breakdown || null,
      usage:{
        provider:response.usage?.provider || null,
        model:response.usage?.model || null,
        total_tokens:response.usage?.total_tokens ?? null,
        generation_latency_ms:response.usage?.generation_latency_ms ?? null,
        review_latency_ms:response.usage?.review_latency_ms ?? null
      },
      passed:safetyPassed && routePassed && statusPassed && graphPassed
    });
  }
}

const report = {
  schema_version:"huamei.graphrag.latency-probe-report.v1",
  generated_at:new Date().toISOString(),
  rounds,
  llm_model:process.env.HUAMEI_LLM_MODEL || null,
  graphrag_index_version:process.env.HUAMEI_GRAPHRAG_INDEX_VERSION || null,
  graphrag_evidence_only_default:process.env.HUAMEI_GRAPHRAG_EVIDENCE_ONLY || "true",
  passed:results.filter((item) => item.passed).length,
  total:results.length,
  results
};
await mkdir(dirname(outputPath), { recursive:true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output:outputPath,
  passed:`${report.passed}/${report.total}`,
  results:results.map((item) => ({
    id:item.id,
    passed:item.passed,
    elapsed_ms:item.elapsed_ms,
    route:item.route,
    graphrag_used:item.graphrag_used,
    graphrag_timing_ms:item.graphrag_timing_ms,
    graphrag_query_model_calls:item.graphrag_query_model_calls,
    generation_ms:item.usage.generation_latency_ms,
    review_ms:item.usage.review_latency_ms,
    breakdown:item.latency_breakdown
  }))
}, null, 2));
if (report.passed !== report.total) process.exitCode = 1;
