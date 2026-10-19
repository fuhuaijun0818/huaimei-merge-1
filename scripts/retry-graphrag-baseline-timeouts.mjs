import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = join(root, "artifacts", "graphrag-baseline", "graphrag-baseline-20261019.2");
const rawPath = join(outputRoot, "retrieval-raw-graphrag.jsonl");
const readLines = async (path) => (await readFile(path, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const rows = await readLines(rawPath);
const { retrieveGraphRagKnowledge } = await import("../server/graphrag-client.mjs");
const { getKnowledgeAdmissionStatus } = await import("../server/knowledge-release-policy.mjs");
const admission = getKnowledgeAdmissionStatus("huamei-shanghai");
const releaseId = admission.active_release?.id;
const indexVersion = admission.active_release?.manifest?.index_version || process.env.HUAMEI_GRAPHRAG_INDEX_VERSION;
if (!releaseId || !indexVersion) throw new Error("Active release/index required");

const hitRecords = (items = []) => items.map((item) => ({
  record_id:item.record_id || null,
  source_relative_path:item.source_relative_path || "",
  title:item.title || ""
}));
const matches = (testCase, items = []) => {
  const expectedIds = new Set(testCase.expected?.record_ids || []);
  const expectedPaths = testCase.expected?.acceptable_paths || [];
  const hits = hitRecords(items);
  const relevant = hits.filter((item) =>
    (item.record_id && expectedIds.has(item.record_id))
    || (item.source_relative_path && expectedPaths.some((prefix) => item.source_relative_path.startsWith(prefix)))
  );
  const expectedCount = Math.max(expectedIds.size, expectedPaths.length, 1);
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

const targets = rows.filter((row) => row.error);
for (const row of targets) {
  const startedAt = performance.now();
  const result = await retrieveGraphRagKnowledge(row.graphrag.query, {
    tenantId:"huamei-shanghai",
    releaseId,
    indexVersion,
    topK:6,
    requestId:`baseline-retry-${row.case_id}`
  });
  const matched = matches(row, result.evidence || []);
  row.actual = {
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
  };
  row.matched = matched;
  row.passed = Boolean(result.used && matched.hit);
  row.latency_ms = Number((performance.now() - startedAt).toFixed(2));
  row.service_timing_ms = result.timingMs || null;
  row.cache_hit = result.cacheHit === true;
  row.error = result.used ? null : result.reason || "GRAPHRAG_UNAVAILABLE";
  row.retried = true;
}

await writeFile(rawPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({
  retried:targets.length,
  remaining_errors:rows.filter((row) => row.error).length,
  passed:rows.filter((row) => row.passed === true).length,
  evaluated:rows.filter((row) => row.passed !== null).length
}, null, 2));
