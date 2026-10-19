import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = join(root, "artifacts", "graphrag-baseline", "graphrag-baseline-20261019.2");
const cases = (await readFile(join(outputRoot, "retrieval-cases.jsonl"), "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((item) => item.graphrag?.eligible);
const tuning = JSON.parse(process.env.HUAMEI_GRAPHRAG_TUNING_JSON || "{}");
const { retrieveGraphRagKnowledge } = await import("../server/graphrag-client.mjs");
const { getKnowledgeAdmissionStatus } = await import("../server/knowledge-release-policy.mjs");
const admission = getKnowledgeAdmissionStatus("huamei-shanghai");
const releaseId = admission.active_release?.id;
const indexVersion = admission.active_release?.manifest?.index_version || process.env.HUAMEI_GRAPHRAG_INDEX_VERSION;
if (!releaseId || !indexVersion) throw new Error("Active release/index required");

const paramsFor = (intent) => {
  const key = intent === "doctor_project_verification" ? "doctor_profile" : intent;
  return { ...(tuning.default || {}), ...(tuning[key] || {}) };
};
const match = (testCase, evidence = []) => {
  const ids = new Set(testCase.expected?.record_ids || []);
  const paths = testCase.expected?.acceptable_paths || [];
  const hits = evidence.filter((item) => item.record_id);
  const relevant = hits.filter((item) => ids.has(item.record_id)
    || paths.some((prefix) => String(item.source_relative_path || "").startsWith(prefix)));
  return {
    hit:relevant.length > 0,
    recall:Number(Math.min(1, relevant.length / Math.max(ids.size, paths.length, 1)).toFixed(4)),
    precision:Number((hits.length ? relevant.length / hits.length : 0).toFixed(4)),
    mrr:relevant.length ? Number((1 / (hits.findIndex((item) => relevant.includes(item)) + 1)).toFixed(4)) : 0,
    citation_correct:hits.every((item) => Boolean(item.record_id && item.source_relative_path))
  };
};
const rows = [];
for (const [index, testCase] of cases.entries()) {
  const params = paramsFor(testCase.intent);
  const started = performance.now();
  const result = await retrieveGraphRagKnowledge(testCase.graphrag.query, {
    tenantId:"huamei-shanghai",
    releaseId,
    indexVersion,
    topK:Number(params.top_k || 6),
    topKEntities:Number(params.top_k_entities || 10),
    topKRelationships:Number(params.top_k_relationships || 10),
    evidenceOnly:true,
    requestId:`tuning-validation-${testCase.case_id}`
  });
  rows.push({
    case_id:testCase.case_id,
    intent:testCase.intent,
    params,
    matched:match(testCase, result.evidence || []),
    context_tokens:result.contextTokens || 0,
    latency_ms:Number((performance.now() - started).toFixed(2)),
    used:result.used === true,
    reason:result.reason || null
  });
  if ((index + 1) % 20 === 0) console.error(`validation progress ${index + 1}/${cases.length}`);
}
const summary = {};
for (const intent of [...new Set(rows.map((row) => row.intent))].sort()) {
  const group = rows.filter((row) => row.intent === intent);
  summary[intent] = {
    cases:group.length,
    hit_rate:Number((group.filter((row) => row.matched.hit).length / group.length).toFixed(4)),
    recall_at_k:Number((group.reduce((sum, row) => sum + row.matched.recall, 0) / group.length).toFixed(4)),
    precision_at_k:Number((group.reduce((sum, row) => sum + row.matched.precision, 0) / group.length).toFixed(4)),
    mrr:Number((group.reduce((sum, row) => sum + row.matched.mrr, 0) / group.length).toFixed(4)),
    citation_correct_rate:Number((group.filter((row) => row.matched.citation_correct).length / group.length).toFixed(4)),
    avg_context_tokens:Number((group.reduce((sum, row) => sum + row.context_tokens, 0) / group.length).toFixed(2)),
    avg_latency_ms:Number((group.reduce((sum, row) => sum + row.latency_ms, 0) / group.length).toFixed(2)),
    params:paramsFor(intent)
  };
}
const report = {
  schema_version:"huamei.graphrag.topk-tuning-validation.v1",
  generated_at:new Date().toISOString(),
  dataset_id:"graphrag-retrieval-baseline-20261019.2",
  evidence_only:true,
  cases:cases.length,
  selected:summary,
  failed_cases:rows.filter((row) => !row.matched.hit).map((row) => ({
    case_id:row.case_id,
    intent:row.intent,
    params:row.params,
    reason:row.reason
  }))
};
await writeFile(join(outputRoot, "topk-tuning-validation.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
