import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = join(root, "artifacts", "graphrag-baseline", "graphrag-baseline-20261019.2");
const cases = (await readFile(join(outputRoot, "retrieval-cases.jsonl"), "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const { retrieveGraphRagKnowledge } = await import("../server/graphrag-client.mjs");
const { getKnowledgeAdmissionStatus } = await import("../server/knowledge-release-policy.mjs");
const admission = getKnowledgeAdmissionStatus("huamei-shanghai");
const releaseId = admission.active_release?.id;
const indexVersion = admission.active_release?.manifest?.index_version || process.env.HUAMEI_GRAPHRAG_INDEX_VERSION;
if (!releaseId || !indexVersion) throw new Error("Active release/index required");

const sampleByIntent = (limit = 3) => {
  const groups = new Map();
  for (const item of cases.filter((testCase) => testCase.graphrag?.eligible)) {
    const group = groups.get(item.intent) || [];
    if (group.length < limit) group.push(item);
    groups.set(item.intent, group);
  }
  return [...groups.values()].flat();
};
const sample = sampleByIntent(3);
const p95 = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};
const matchEvidence = (testCase, evidence = []) => {
  const expectedIds = new Set(testCase.expected?.record_ids || []);
  const expectedPaths = testCase.expected?.acceptable_paths || [];
  const hits = evidence.map((item) => ({
    record_id:item.record_id || null,
    source_relative_path:item.source_relative_path || ""
  })).filter((item) => item.record_id);
  const relevant = hits.filter((item) =>
    expectedIds.has(item.record_id)
    || expectedPaths.some((prefix) => item.source_relative_path.startsWith(prefix))
  );
  return {
    hit:relevant.length > 0,
    relevant,
    recall:Number(Math.min(1, relevant.length / Math.max(expectedIds.size, expectedPaths.length, 1)).toFixed(4)),
    precision:Number((hits.length ? relevant.length / hits.length : 0).toFixed(4)),
    mrr:relevant.length ? Number((1 / (hits.findIndex((item) => relevant.includes(item)) + 1)).toFixed(4)) : 0,
    citation_correct:hits.every((item) => Boolean(item.record_id && item.source_relative_path))
  };
};
const summarize = (rows) => {
  const byIntent = {};
  for (const intent of [...new Set(rows.map((row) => row.intent))].sort()) {
    const group = rows.filter((row) => row.intent === intent);
    const latencies = group.map((row) => row.latency_ms).filter(Number.isFinite);
    byIntent[intent] = {
      cases:group.length,
      hit_rate:Number((group.filter((row) => row.matched.hit).length / group.length).toFixed(4)),
      recall_at_k:Number((group.reduce((sum, row) => sum + row.matched.recall, 0) / group.length).toFixed(4)),
      precision_at_k:Number((group.reduce((sum, row) => sum + row.matched.precision, 0) / group.length).toFixed(4)),
      mrr:Number((group.reduce((sum, row) => sum + row.matched.mrr, 0) / group.length).toFixed(4)),
      citation_correct_rate:Number((group.filter((row) => row.matched.citation_correct).length / group.length).toFixed(4)),
      avg_context_tokens:Number((group.reduce((sum, row) => sum + (row.context_tokens || 0), 0) / group.length).toFixed(2)),
      avg_latency_ms:Number((latencies.reduce((sum, value) => sum + value, 0) / Math.max(latencies.length, 1)).toFixed(2)),
      p95_latency_ms:p95(latencies)
    };
  }
  return byIntent;
};
const choose = (candidates) => {
  const meetingRecall = candidates.filter((candidate) => candidate.metrics.recall_at_k >= 0.95);
  const pool = meetingRecall.length ? meetingRecall : candidates;
  return [...pool].sort((left, right) =>
    right.metrics.recall_at_k - left.metrics.recall_at_k
    || right.metrics.precision_at_k - left.metrics.precision_at_k
    || left.metrics.avg_context_tokens - right.metrics.avg_context_tokens
    || left.metrics.p95_latency_ms - right.metrics.p95_latency_ms
  )[0];
};
const call = async (testCase, { topK, entities, relationships }) => {
  const started = performance.now();
  const result = await retrieveGraphRagKnowledge(testCase.graphrag.query, {
    tenantId:"huamei-shanghai",
    releaseId,
    indexVersion,
    topK,
    topKEntities:entities,
    topKRelationships:relationships,
    evidenceOnly:true,
    requestId:`topk-tune-${testCase.case_id}-${topK}-${entities}-${relationships}`
  });
  return {
    evidence:result.evidence || [],
    context_tokens:result.contextTokens || 0,
    latency_ms:Number((performance.now() - started).toFixed(2)),
    used:result.used === true,
    reason:result.reason || null
  };
};

const raw = [];
const topKSweep = [];
const topKValues = [3, 5, 6, 8, 10];
for (const [index, testCase] of sample.entries()) {
  const result = await call(testCase, { topK:10, entities:10, relationships:10 });
  for (const topK of topKValues) {
    const matched = matchEvidence(testCase, result.evidence.slice(0, topK));
    topKSweep.push({
      phase:"top_k",
      case_id:testCase.case_id,
      intent:testCase.intent,
      top_k:topK,
      top_k_entities:10,
      top_k_relationships:10,
      context_tokens:result.context_tokens,
      latency_ms:result.latency_ms,
      matched
    });
  }
  raw.push({ case_id:testCase.case_id, phase:"top_k_base", ...result, evidence_ids:result.evidence.map((item) => item.record_id) });
  if ((index + 1) % 5 === 0) console.error(`top_k progress ${index + 1}/${sample.length}`);
}
const topKByIntent = summarize(topKSweep);
const selectedTopK = {};
for (const intent of Object.keys(topKByIntent)) {
  const candidates = topKValues.map((topK) => ({
    topK,
    metrics:topKByIntent[intent] && summarize(topKSweep.filter((row) => row.intent === intent && row.top_k === topK))[intent]
  })).filter((candidate) => candidate.metrics);
  selectedTopK[intent] = choose(candidates).topK;
}

const entityValues = [5, 10, 15];
const entitySweep = [];
for (const [index, testCase] of sample.entries()) {
  const topK = selectedTopK[testCase.intent] || 6;
  for (const entities of entityValues) {
    const result = await call(testCase, { topK, entities, relationships:10 });
    entitySweep.push({
      phase:"top_k_entities",
      case_id:testCase.case_id,
      intent:testCase.intent,
      top_k:topK,
      top_k_entities:entities,
      top_k_relationships:10,
      context_tokens:result.context_tokens,
      latency_ms:result.latency_ms,
      matched:matchEvidence(testCase, result.evidence)
    });
  }
  if ((index + 1) % 5 === 0) console.error(`entities progress ${index + 1}/${sample.length}`);
}
const entityByIntent = summarize(entitySweep);
const selectedEntities = {};
for (const intent of Object.keys(entityByIntent)) {
  const candidates = entityValues.map((entities) => ({
    entities,
    metrics:summarize(entitySweep.filter((row) => row.intent === intent && row.top_k_entities === entities))[intent]
  })).filter((candidate) => candidate.metrics);
  selectedEntities[intent] = choose(candidates).entities;
}

const relationshipValues = [5, 10, 15];
const relationshipSweep = [];
for (const [index, testCase] of sample.entries()) {
  const topK = selectedTopK[testCase.intent] || 6;
  const entities = selectedEntities[testCase.intent] || 10;
  for (const relationships of relationshipValues) {
    const result = await call(testCase, { topK, entities, relationships });
    relationshipSweep.push({
      phase:"top_k_relationships",
      case_id:testCase.case_id,
      intent:testCase.intent,
      top_k:topK,
      top_k_entities:entities,
      top_k_relationships:relationships,
      context_tokens:result.context_tokens,
      latency_ms:result.latency_ms,
      matched:matchEvidence(testCase, result.evidence)
    });
  }
  if ((index + 1) % 5 === 0) console.error(`relationships progress ${index + 1}/${sample.length}`);
}
const relationshipByIntent = summarize(relationshipSweep);
const selectedRelationships = {};
for (const intent of Object.keys(relationshipByIntent)) {
  const candidates = relationshipValues.map((relationships) => ({
    relationships,
    metrics:summarize(relationshipSweep.filter((row) => row.intent === intent && row.top_k_relationships === relationships))[intent]
  })).filter((candidate) => candidate.metrics);
  selectedRelationships[intent] = choose(candidates).relationships;
}

const tuning = {};
for (const intent of [...new Set(sample.map((item) => item.intent))].sort()) {
  tuning[intent] = {
    top_k:selectedTopK[intent] || 6,
    top_k_entities:selectedEntities[intent] || 10,
    top_k_relationships:selectedRelationships[intent] || 10
  };
}
const report = {
  schema_version:"huamei.graphrag.topk-tuning.v1",
  generated_at:new Date().toISOString(),
  dataset_id:"graphrag-retrieval-baseline-20261019.2",
  release_id:releaseId,
  index_version:indexVersion,
  evidence_only:true,
  sample_cases:sample.length,
  sample_by_intent:Object.fromEntries([...new Set(sample.map((item) => item.intent))].sort().map((intent) => [intent, sample.filter((item) => item.intent === intent).length])),
  search_space:{
    top_k:topKValues,
    top_k_entities:entityValues,
    top_k_relationships:relationshipValues
  },
  selected:tuning,
  selected_json:{ default:{ top_k:6, top_k_entities:10, top_k_relationships:10 }, ...tuning },
  by_phase:{
    top_k:topKByIntent,
    top_k_entities:entityByIntent,
    top_k_relationships:relationshipByIntent
  }
};
await writeFile(join(outputRoot, "topk-tuning-raw.jsonl"), `${raw.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
await writeFile(join(outputRoot, "topk-tuning-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
