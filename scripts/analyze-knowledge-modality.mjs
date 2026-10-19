import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHuameiKnowledge } from "../server/huamei-knowledge.mjs";
import { getMultimodalReadiness } from "../server/multimodal-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const casePath = join(
  root,
  "artifacts",
  "graphrag-baseline",
  "graphrag-baseline-20261019.2",
  "retrieval-cases.jsonl"
);
const outputPath = join(
  root,
  "artifacts",
  "graphrag-baseline",
  "graphrag-baseline-20261019.2",
  "language-modality-distribution.json"
);
const knowledge = loadHuameiKnowledge();
if (!knowledge.loaded) throw new Error(`Knowledge package not loaded: ${knowledge.error || "unknown"}`);
const cases = (await readFile(casePath, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const readiness = getMultimodalReadiness({
  records:knowledge.publicRecords || [],
  queries:cases,
  env:process.env
});
const report = {
  schema_version:"huamei.knowledge.language-modality-distribution.v1",
  generated_at:new Date().toISOString(),
  knowledge_version:knowledge.version,
  record_count:(knowledge.publicRecords || []).length,
  query_count:cases.length,
  ...readiness
};
await mkdir(dirname(outputPath), { recursive:true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output:outputPath, ...report }, null, 2));
