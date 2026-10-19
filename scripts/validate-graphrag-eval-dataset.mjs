import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = join(root, "knowledge", "huamei-v1", "rag", "huamei-public-safe.jsonl");
const outputRoot = join(root, "artifacts", "graphrag-baseline", "graphrag-baseline-20261019.2");
const catalog = (await readFile(sourcePath, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const datasetText = await readFile(join(outputRoot, "retrieval-cases.jsonl"), "utf8");
const cases = datasetText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const ids = new Set(catalog.map((record) => record.record_id));
const paths = catalog.map((record) => String(record.source_relative_path || ""));
const failures = [];
const fail = (caseId, code, detail = null) => failures.push({ case_id:caseId, code, detail });
const seen = new Set();
const privatePattern = /(?:1[3-9]\d{9}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\d{17}[0-9Xx]|我叫|病史|过敏史|住在)/i;
const categoryCounts = Object.fromEntries([...new Set(cases.map((item) => item.category))].sort().map((category) => [
  category,
  cases.filter((item) => item.category === category).length
]));

if (cases.length < 200) failures.push({ code:"CASE_COUNT_INSUFFICIENT", detail:cases.length });
for (const testCase of cases) {
  if (!testCase.case_id || seen.has(testCase.case_id)) fail(testCase.case_id, "CASE_ID_INVALID_OR_DUPLICATE");
  seen.add(testCase.case_id);
  if (!testCase.query || privatePattern.test(testCase.query)) fail(testCase.case_id, "QUERY_PRIVATE_OR_EMPTY");
  if (testCase.graphrag?.eligible) {
    const terms = String(testCase.graphrag.query || "").trim().split(/\s+/).filter(Boolean);
    if (!terms.length || terms.length > 16) fail(testCase.case_id, "GRAPHRAG_QUERY_TERM_COUNT_INVALID");
    if (/[，。！？；;：:“”"'’]/.test(testCase.graphrag.query || "")) fail(testCase.case_id, "GRAPHRAG_QUERY_PUNCTUATION");
  }
  for (const recordId of testCase.expected?.record_ids || []) {
    if (!ids.has(recordId)) fail(testCase.case_id, "EXPECTED_RECORD_NOT_FOUND", recordId);
  }
  for (const prefix of testCase.expected?.acceptable_paths || []) {
    if (!paths.some((path) => path.startsWith(prefix))) fail(testCase.case_id, "ACCEPTABLE_PATH_NOT_FOUND", prefix);
  }
  if (testCase.category === "no_answer"
    && (testCase.expected?.requires_evidence !== false || (testCase.expected?.record_ids || []).length)) {
    fail(testCase.case_id, "NO_ANSWER_LABEL_INVALID");
  }
  if (testCase.category === "safety"
    && !["handover", "block"].includes(testCase.expected?.safety_action)) {
    fail(testCase.case_id, "SAFETY_ACTION_INVALID");
  }
  if (testCase.category === "multi_turn"
    && (!Array.isArray(testCase.history) || !testCase.history.length || !testCase.resolved_query)) {
    fail(testCase.case_id, "MULTI_TURN_LABEL_INVALID");
  }
}

const report = {
  dataset_id:"graphrag-retrieval-baseline-20261019.2",
  case_count:cases.length,
  category_counts:categoryCounts,
  graphrag_eligible:cases.filter((item) => item.graphrag?.eligible).length,
  dataset_sha256:createHash("sha256").update(datasetText).digest("hex"),
  checks:{
    case_count_at_least_200:cases.length >= 200,
    duplicate_case_ids:none(seen, cases),
    all_expected_records_exist:!failures.some((item) => item.code === "EXPECTED_RECORD_NOT_FOUND"),
    all_acceptable_paths_exist:!failures.some((item) => item.code === "ACCEPTABLE_PATH_NOT_FOUND"),
    no_private_query_text:!failures.some((item) => item.code === "QUERY_PRIVATE_OR_EMPTY"),
    graphrag_queries_bounded:!failures.some((item) => item.code === "GRAPHRAG_QUERY_TERM_COUNT_INVALID"),
    no_answer_labels_valid:!failures.some((item) => item.code === "NO_ANSWER_LABEL_INVALID"),
    safety_labels_valid:!failures.some((item) => item.code === "SAFETY_ACTION_INVALID"),
    multi_turn_labels_valid:!failures.some((item) => item.code === "MULTI_TURN_LABEL_INVALID")
  },
  failures,
  passed:failures.length === 0
};
await writeFile(join(outputRoot, "retrieval-data-integrity-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;

function none(set, values) {
  return set.size === values.length;
}
