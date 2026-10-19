import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE = ":memory:";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = join(root, "artifacts", "graphrag-baseline", "graphrag-baseline-20261019.2");
const casePath = join(outputRoot, "retrieval-cases.jsonl");
const cases = (await readFile(casePath, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const args = Object.fromEntries(process.argv.slice(2).map((value) => {
  const match = value.match(/^--([^=]+)(?:=(.*))?$/);
  return match ? [match[1], match[2] ?? true] : [value, true];
}));
const reportRoot = args["output-dir"] ? join(root, String(args["output-dir"])) : outputRoot;
const mode = ["local", "graphrag", "all"].includes(args.mode) ? args.mode : "all";
const evidenceOnly = args["evidence-only"] === true;
const concurrency = Math.min(8, Math.max(1, Number(args.concurrency) || 1));
const limit = Math.max(0, Number(args.limit) || 0);
const selectedCases = limit ? cases.slice(0, limit) : cases;

const { retrieveHuameiKnowledge } = await import("../server/huamei-knowledge.mjs");
const { invokeAgentAsync } = await import("../server/agent-runtime.mjs");
const { retrieveGraphRagKnowledge } = await import("../server/graphrag-client.mjs");
const { getKnowledgeAdmissionStatus } = await import("../server/knowledge-release-policy.mjs");
const admission = getKnowledgeAdmissionStatus("huamei-shanghai");
const releaseId = admission.active_release?.id || null;
const indexVersion = admission.active_release?.manifest?.index_version || process.env.HUAMEI_GRAPHRAG_INDEX_VERSION || null;
if (mode !== "local" && (!releaseId || !indexVersion)) {
  throw new Error("GraphRAG baseline requires an active knowledge release and index version");
}

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hitRecords = (items = []) => items.map((item) => ({
  record_id:item.record_id || item.item?.record_id || null,
  source_relative_path:item.source_relative_path || item.item?.source_relative_path || "",
  title:item.title || item.item?.title || ""
}));
const matches = (testCase, items = []) => {
  const expectedIds = new Set(testCase.expected?.record_ids || []);
  const expectedPaths = testCase.expected?.acceptable_paths || [];
  const expectedCount = Math.max(expectedIds.size, expectedPaths.length, 1);
  const hits = hitRecords(items);
  const relevant = hits.filter((item) =>
    (item.record_id && expectedIds.has(item.record_id))
    || (item.source_relative_path && expectedPaths.some((prefix) => item.source_relative_path.startsWith(prefix)))
  );
  return {
    hits,
    relevant,
    matched_count:relevant.length,
    expected_count:expectedCount,
    hit:relevant.length > 0,
    recall:Number(Math.min(1, relevant.length / expectedCount).toFixed(4)),
    precision:Number((hits.length ? relevant.length / hits.length : 0).toFixed(4)),
    mrr:relevant.length ? Number((1 / (hits.findIndex((item) => relevant.includes(item)) + 1)).toFixed(4)) : 0
  };
};
const latency = (startedAt) => Number((performance.now() - startedAt).toFixed(2));
const p95 = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};

async function evaluateLocal(testCase) {
  const startedAt = performance.now();
  if (testCase.category === "safety") {
    const response = await invokeAgentAsync("A-01", {
      message:testCase.query,
      mode:"reply",
      context:{ tenant_id:"huamei-shanghai", service_consent:true }
    }, { requestId:`baseline-safety-${testCase.case_id}` });
    const passed = testCase.expected.safety_action === "handover"
      ? ["handover_required", "handover_pending"].includes(response.status)
      : response.status === "blocked";
    return {
      mode:"local",
      ...testCase,
      actual:{ status:response.status, evidence:[], safety_passed:passed, safety_action:response.status },
      matched:null,
      passed,
      latency_ms:latency(startedAt),
      cache_hit:false,
      error:null
    };
  }
  const hits = retrieveHuameiKnowledge(testCase.resolved_query, {
    audience:"public",
    limit:6,
    tenantId:"huamei-shanghai"
  });
  const matched = matches(testCase, hits);
  const passed = testCase.category === "no_answer"
    ? hits.length === 0
    : Boolean(testCase.expected.requires_evidence && matched.hit);
  return {
    mode:"local",
    ...testCase,
    actual:{ status:null, evidence:hitRecords(hits), safety_passed:null, safety_action:null },
    matched,
    passed,
    latency_ms:latency(startedAt),
    cache_hit:false,
    error:null
  };
}

async function evaluateGraphRag(testCase) {
  if (!testCase.graphrag?.eligible) {
    return {
      mode:"graphrag",
      ...testCase,
      actual:{ status:null, evidence:[], safety_passed:null, safety_action:null },
      matched:null,
      passed:null,
      latency_ms:0,
      cache_hit:false,
      error:null,
      skipped:"not_graphrag_eligible"
    };
  }
  const startedAt = performance.now();
  const result = await retrieveGraphRagKnowledge(testCase.graphrag.query, {
    tenantId:"huamei-shanghai",
    releaseId,
    indexVersion,
    evidenceOnly,
    topK:6,
    requestId:`baseline-graphrag-${testCase.case_id}`
  });
  const matched = matches(testCase, result.evidence || []);
  return {
    mode:"graphrag",
    ...testCase,
    actual:{
      status:null,
      evidence:hitRecords(result.evidence || []),
      safety_passed:null,
      safety_action:null,
      used:result.used,
      reason:result.reason,
      engine:result.engine,
      index_version:result.indexVersion,
      evidence_count:(result.evidence || []).length,
      fallback_reason:result.used ? null : result.reason
    },
    matched,
    passed:Boolean(result.used && matched.hit),
    latency_ms:latency(startedAt),
    service_timing_ms:result.timingMs || null,
    cache_hit:result.cacheHit === true,
    error:result.used ? null : result.reason || "GRAPHRAG_UNAVAILABLE"
  };
}

async function runPool(items, worker, poolSize) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length:poolSize }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = {
          mode:worker.mode,
          ...items[index],
          actual:null,
          matched:null,
          passed:false,
          latency_ms:0,
          cache_hit:false,
          error:error.code || error.name || "EVALUATION_ERROR"
        };
      }
    }
  }));
  return results;
}

const localResults = mode === "local" || mode === "all"
  ? await runPool(selectedCases, Object.assign(evaluateLocal, { mode:"local" }), Math.min(concurrency, 8))
  : [];
const graphragResults = mode === "graphrag" || mode === "all"
  ? await runPool(selectedCases, Object.assign(evaluateGraphRag, { mode:"graphrag" }), concurrency)
  : [];

const summarize = (rows) => {
  const evaluated = rows.filter((row) => row.passed !== null);
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
    no_answer_cases:noAnswer.length,
    no_answer_correct:noAnswer.filter((row) => row.passed).length,
    safety_cases:safety.length,
    safety_correct:safety.filter((row) => row.passed).length,
    errors:evaluated.filter((row) => row.error).length,
    cache_hits:evaluated.filter((row) => row.cache_hit).length,
    latency_ms_p50:values.length ? values.sort((a, b) => a - b)[Math.floor(values.length * 0.5)] : null,
    latency_ms_p95:p95(values)
  };
};
const byCategory = (rows) => Object.fromEntries([...new Set(rows.map((row) => row.category))].sort().map((category) => [
  category,
  summarize(rows.filter((row) => row.category === category))
]));
const report = {
  schema_version:"huamei.graphrag.retrieval-baseline-report.v1",
  generated_at:new Date().toISOString(),
  mode,
  evidence_only:evidenceOnly,
  concurrency,
  release_id:releaseId,
  index_version:indexVersion,
  dataset_id:"graphrag-retrieval-baseline-20261019.2",
  dataset_sha256:sha256(await readFile(casePath)),
  selection:{
    cases:selectedCases.length,
    graphrag_eligible:selectedCases.filter((item) => item.graphrag?.eligible).length
  },
  local:localResults.length ? summarize(localResults) : null,
  graphrag:graphragResults.length ? summarize(graphragResults) : null,
  by_category:{
    local:localResults.length ? byCategory(localResults) : null,
    graphrag:graphragResults.length ? byCategory(graphragResults) : null
  }
};
await mkdir(reportRoot, { recursive:true });
if (localResults.length) {
  await writeFile(join(reportRoot, "retrieval-raw-local.jsonl"), `${localResults.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}
if (graphragResults.length) {
  await writeFile(join(reportRoot, "retrieval-raw-graphrag.jsonl"), `${graphragResults.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}
await writeFile(join(reportRoot, "retrieval-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.local?.errors || report.graphrag?.errors) process.exitCode = 1;
