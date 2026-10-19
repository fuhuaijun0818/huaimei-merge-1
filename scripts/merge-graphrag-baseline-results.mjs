import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = join(root, "artifacts", "graphrag-baseline", "graphrag-baseline-20261019.2");
const readLines = async (name) => (await readFile(join(outputRoot, name), "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const cases = await readLines("retrieval-cases.jsonl");
const local = await readLines("retrieval-raw-local.jsonl");
const graphrag = await readLines("retrieval-raw-graphrag.jsonl");
const datasetSummary = JSON.parse(await readFile(join(outputRoot, "retrieval-dataset-summary.json"), "utf8"));
const dataIntegrity = JSON.parse(await readFile(join(outputRoot, "retrieval-data-integrity-report.json"), "utf8"));

const p95 = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};
const summarize = (rows, { evaluatedOnly = false } = {}) => {
  const evaluated = evaluatedOnly ? rows.filter((row) => row.passed !== null) : rows;
  const knowledge = evaluated.filter((row) => row.category !== "no_answer" && row.category !== "safety");
  const noAnswer = evaluated.filter((row) => row.category === "no_answer");
  const safety = evaluated.filter((row) => row.category === "safety");
  const values = evaluated.map((row) => row.latency_ms).filter(Number.isFinite);
  return {
    total:rows.length,
    evaluated:evaluated.length,
    skipped:rows.length - evaluated.length,
    passed:evaluated.filter((row) => row.passed === true).length,
    pass_rate:evaluated.length ? Number((evaluated.filter((row) => row.passed).length / evaluated.length).toFixed(4)) : 0,
    knowledge_cases:knowledge.length,
    knowledge_hit_rate:knowledge.length ? Number((knowledge.filter((row) => row.passed).length / knowledge.length).toFixed(4)) : 0,
    recall_at_k:knowledge.length ? Number((knowledge.reduce((sum, row) => sum + (row.matched?.recall || 0), 0) / knowledge.length).toFixed(4)) : 0,
    precision_at_k:knowledge.length ? Number((knowledge.reduce((sum, row) => sum + (row.matched?.precision || 0), 0) / knowledge.length).toFixed(4)) : 0,
    mrr:knowledge.length ? Number((knowledge.reduce((sum, row) => sum + (row.matched?.mrr || 0), 0) / knowledge.length).toFixed(4)) : 0,
    no_answer_correct:noAnswer.filter((row) => row.passed).length,
    no_answer_cases:noAnswer.length,
    safety_correct:safety.filter((row) => row.passed).length,
    safety_cases:safety.length,
    errors:evaluated.filter((row) => row.error).length,
    cache_hits:evaluated.filter((row) => row.cache_hit).length,
    latency_ms_p50:values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.5)] : null,
    latency_ms_p95:p95(values)
  };
};
const byCategory = (rows, options) => Object.fromEntries([...new Set(rows.map((row) => row.category))].sort().map((category) => [
  category,
  summarize(rows.filter((row) => row.category === category), options)
]));

const eligibleIds = new Set(graphrag.filter((row) => row.passed !== null).map((row) => row.case_id));
const localComparable = local.filter((row) => eligibleIds.has(row.case_id));
const graphComparable = graphrag.filter((row) => eligibleIds.has(row.case_id));
const localSummary = summarize(local, { evaluatedOnly:false });
const graphSummary = summarize(graphrag, { evaluatedOnly:true });
const localComparableSummary = summarize(localComparable, { evaluatedOnly:false });
const graphComparableSummary = summarize(graphComparable, { evaluatedOnly:true });
const failures = {
  local_no_answer:[...local.filter((row) => row.category === "no_answer" && !row.passed)],
  local_safety:[...local.filter((row) => row.category === "safety" && !row.passed)],
  graphrag_timeouts:[...graphrag.filter((row) => row.category !== "no_answer" && row.category !== "safety" && row.error)],
  graphrag_misses:[...graphrag.filter((row) => row.passed === false && !row.error)]
};

const report = {
  schema_version:"huamei.graphrag.step0-baseline.v1",
  baseline_id:"graphrag-baseline-20261019.2",
  dataset:datasetSummary,
  data_integrity:{ passed:dataIntegrity.passed, case_count:dataIntegrity.case_count },
  local:localSummary,
  graphrag:graphSummary,
  comparable_subset:{
    case_count:eligibleIds.size,
    local:localComparableSummary,
    graphrag:graphComparableSummary,
    knowledge_hit_delta:Number((graphComparableSummary.knowledge_hit_rate - localComparableSummary.knowledge_hit_rate).toFixed(4)),
    precision_delta:Number((graphComparableSummary.precision_at_k - localComparableSummary.precision_at_k).toFixed(4)),
    mrr_delta:Number((graphComparableSummary.mrr - localComparableSummary.mrr).toFixed(4)),
    latency_p95_delta_ms:Number((graphComparableSummary.latency_ms_p95 - localComparableSummary.latency_ms_p95).toFixed(2))
  },
  by_category:{
    local:byCategory(local, { evaluatedOnly:false }),
    graphrag:byCategory(graphrag, { evaluatedOnly:true })
  },
  failures:{
    local_no_answer_count:failures.local_no_answer.length,
    local_safety_count:failures.local_safety.length,
    graphrag_timeout_count:failures.graphrag_timeouts.length,
    graphrag_miss_count:failures.graphrag_misses.length,
    local_no_answer:failures.local_no_answer.map((row) => ({ case_id:row.case_id, query:row.query, returned_hits:row.actual?.evidence?.length || 0 })),
    local_safety:failures.local_safety.map((row) => ({ case_id:row.case_id, query:row.query, expected:row.expected?.safety_action, actual:row.actual?.status })),
    graphrag_timeouts:failures.graphrag_timeouts.map((row) => ({ case_id:row.case_id, category:row.category, graph_query:row.graphrag?.query, error:row.error })),
    graphrag_misses:failures.graphrag_misses.map((row) => ({ case_id:row.case_id, category:row.category, query:row.query, matched:row.matched }))
  },
  generated_at:new Date().toISOString()
};
await writeFile(join(outputRoot, "retrieval-baseline-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
const markdown = [
  `# GraphRAG 第0步基线报告`,
  "",
  `数据集：${datasetSummary.case_count} 条，GraphRAG 可评估 ${datasetSummary.graphrag_eligible} 条。`,
  "",
  `| 指标 | 本地 RAG | GraphRAG |`,
  `|---|---:|---:|`,
  `| 知识命中率 | ${(localSummary.knowledge_hit_rate * 100).toFixed(2)}% | ${(graphSummary.knowledge_hit_rate * 100).toFixed(2)}% |`,
  `| Recall@K | ${localSummary.recall_at_k.toFixed(4)} | ${graphSummary.recall_at_k.toFixed(4)} |`,
  `| Precision@K | ${localSummary.precision_at_k.toFixed(4)} | ${graphSummary.precision_at_k.toFixed(4)} |`,
  `| MRR | ${localSummary.mrr.toFixed(4)} | ${graphSummary.mrr.toFixed(4)} |`,
  `| P50 延迟 | ${localSummary.latency_ms_p50} ms | ${graphSummary.latency_ms_p50} ms |`,
  `| P95 延迟 | ${localSummary.latency_ms_p95} ms | ${graphSummary.latency_ms_p95} ms |`,
  "",
  `- 本地无答案正确：${localSummary.no_answer_correct}/${localSummary.no_answer_cases}`,
  `- 本地安全处理正确：${localSummary.safety_correct}/${localSummary.safety_cases}`,
  `- GraphRAG 超时/失败：${graphSummary.errors}`,
  `- GraphRAG 缓存命中：${graphSummary.cache_hits}`,
  "",
  `同一 132 条可评估子集上：本地命中率 ${(localComparableSummary.knowledge_hit_rate * 100).toFixed(2)}%，GraphRAG ${(graphComparableSummary.knowledge_hit_rate * 100).toFixed(2)}%；GraphRAG P95 延迟高出 ${report.comparable_subset.latency_p95_delta_ms} ms。`,
  "",
  `本报告是开发基线，不代表正式三审发布或生产验收。`
].join("\n");
await writeFile(join(outputRoot, "retrieval-baseline-summary.md"), `${markdown}\n`, "utf8");
console.log(JSON.stringify({
  report:join(outputRoot, "retrieval-baseline-report.json"),
  summary:join(outputRoot, "retrieval-baseline-summary.md"),
  local:localSummary,
  graphrag:graphSummary,
  comparable_subset:report.comparable_subset,
  failures:report.failures
}, null, 2));
