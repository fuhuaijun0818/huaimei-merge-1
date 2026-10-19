import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE = ":memory:";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((value) => {
  const match = value.match(/^--([^=]+)(?:=(.*))?$/);
  return match ? [match[1], match[2] ?? true] : [value, true];
}));
const casePath = join(
  root,
  "artifacts",
  "graphrag-baseline",
  "graphrag-baseline-20261019.2",
  "retrieval-cases.jsonl"
);
const outputPath = String(args.output || join(
  root,
  "artifacts",
  "graphrag-baseline",
  "graphrag-baseline-20261019.2",
  "cache-prewarm-report.json"
));
const limit = Math.min(500, Math.max(1, Number(args.limit) || 200));
const rounds = Math.min(6, Math.max(1, Number(args.rounds) || 2));
const concurrency = Math.min(8, Math.max(1, Number(args.concurrency) || 4));

const cases = (await readFile(casePath, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const { retrieveGraphRagKnowledge } = await import("../server/graphrag-client.mjs");
const { graphRagParamsForIntent } = await import("../server/agent-runtime.mjs");
const { getKnowledgeAdmissionStatus } = await import("../server/knowledge-release-policy.mjs");
const admission = getKnowledgeAdmissionStatus("huamei-shanghai");
const releaseId = admission.active_release?.id || null;
const indexVersion = admission.active_release?.manifest?.index_version
  || process.env.HUAMEI_GRAPHRAG_INDEX_VERSION
  || null;
if (!releaseId || !indexVersion) {
  throw new Error("缓存预热需要已激活知识release和index version");
}

const entries = [];
const seen = new Set();
for (const testCase of cases) {
  if (!testCase.graphrag?.eligible || !testCase.graphrag?.query) continue;
  const params = graphRagParamsForIntent(testCase.intent || testCase.category || "");
  const key = JSON.stringify([
    testCase.graphrag.query,
    params.topK,
    params.topKEntities ?? null,
    params.topKRelationships ?? null,
    params.maxContextTokens ?? null
  ]);
  if (seen.has(key)) continue;
  seen.add(key);
  entries.push({
    case_id:testCase.case_id,
    intent:testCase.intent || testCase.category,
    query:testCase.graphrag.query,
    params
  });
  if (entries.length >= limit) break;
}

const percentile = (values, ratio) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)].toFixed(2));
};

const runRound = async (round) => {
  const results = new Array(entries.length);
  let cursor = 0;
  await Promise.all(Array.from({ length:Math.min(concurrency, entries.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= entries.length) return;
      const entry = entries[index];
      const startedAt = performance.now();
      const result = await retrieveGraphRagKnowledge(entry.query, {
        tenantId:"huamei-shanghai",
        releaseId,
        indexVersion,
        requestId:`prewarm-${round}-${entry.case_id}`,
        evidenceOnly:true,
        topK:entry.params.topK,
        ...(entry.params.topKEntities ? { topKEntities:entry.params.topKEntities } : {}),
        ...(entry.params.topKRelationships ? { topKRelationships:entry.params.topKRelationships } : {}),
        ...(entry.params.maxContextTokens ? { maxContextTokens:entry.params.maxContextTokens } : {})
      });
      results[index] = {
        case_id:entry.case_id,
        intent:entry.intent,
        used:result.used,
        reason:result.reason || null,
        cache_hit:result.cacheHit === true,
        evidence_count:(result.evidence || []).length,
        client_latency_ms:Number((performance.now() - startedAt).toFixed(2)),
        service_timing_ms:result.timingMs,
        service_search_ms:result.searchMs,
        query_model_attempts:result.queryModelAttempts || 0
      };
    }
  }));
  const evaluated = results.filter(Boolean);
  return {
    round,
    requests:evaluated.length,
    used:evaluated.filter((item) => item.used).length,
    cache_hits:evaluated.filter((item) => item.cache_hit).length,
    errors:evaluated.filter((item) => !item.used).length,
    query_model_attempts:evaluated.reduce((sum, item) => sum + item.query_model_attempts, 0),
    client_latency_ms_p50:percentile(evaluated.map((item) => item.client_latency_ms), 0.5),
    client_latency_ms_p95:percentile(evaluated.map((item) => item.client_latency_ms), 0.95),
    service_search_ms_p50:percentile(evaluated.filter((item) => item.cache_hit === false).map((item) => item.service_search_ms).filter(Number.isFinite), 0.5),
    service_search_ms_p95:percentile(evaluated.filter((item) => item.cache_hit === false).map((item) => item.service_search_ms).filter(Number.isFinite), 0.95),
    results:evaluated
  };
};

const startedAt = performance.now();
const roundResults = [];
for (let round = 1; round <= rounds; round += 1) {
  roundResults.push(await runRound(round));
}

const report = {
  schema_version:"huamei.graphrag.cache-prewarm-report.v1",
  generated_at:new Date().toISOString(),
  dataset_id:"graphrag-retrieval-baseline-20261019.2",
  dataset_sha256:createHash("sha256").update(await readFile(casePath)).digest("hex"),
  release_id:releaseId,
  index_version:indexVersion,
  query_count:entries.length,
  unique_query_count:new Set(entries.map((entry) => entry.query)).size,
  rounds,
  concurrency,
  graphrag_workers:Number(process.env.HUAMEI_GRAPHRAG_WORKERS) || 4,
  cache_scope:"per_uvicorn_worker_in_memory",
  elapsed_ms:Number((performance.now() - startedAt).toFixed(2)),
  round_summaries:roundResults.map(({ results, ...summary }) => summary),
  rounds:roundResults
};
await mkdir(dirname(outputPath), { recursive:true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output:outputPath,
  query_count:report.query_count,
  unique_query_count:report.unique_query_count,
  elapsed_ms:report.elapsed_ms,
  round_summaries:report.round_summaries
}, null, 2));
