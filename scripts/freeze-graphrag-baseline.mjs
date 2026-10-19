import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadHuameiKnowledge } from "../server/huamei-knowledge.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselineId = String(process.argv[2] || "graphrag-baseline-20261019.2").trim();
const outputRoot = join(root, "artifacts", "graphrag-baseline", baselineId);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha256Text = (value) => sha256(Buffer.from(String(value), "utf8"));
const nowShanghai = () => {
  const formatted = new Date().toLocaleString("sv-SE", { timeZone:"Asia/Shanghai" }).replace(" ", "T");
  return `${formatted}+08:00`;
};
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const sha256File = async (path) => sha256(await readFile(path));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const parseEnv = (text) => Object.fromEntries(
  text.split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim().replace(/^"(.*)"$/, "$1")])
);
const run = (command, args = [], options = {}) => {
  try {
    return execFileSync(command, args, {
      cwd:root,
      encoding:"utf8",
      stdio:["ignore", "pipe", "pipe"],
      ...options
    }).trim();
  } catch {
    return null;
  }
};
const copyIfExists = async (from, to) => {
  try {
    await stat(from);
    await cp(from, to);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const walkFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes:true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};
const directoryMaterial = async (directory) => {
  const files = await walkFiles(directory);
  return (await Promise.all(files.map(async (path) => {
    const relativePath = relative(root, path).replaceAll("\\", "/");
    return `${relativePath}:${await sha256File(path)}`;
  }))).join("\n") + "\n";
};

const envLocal = parseEnv(await readFile(join(root, ".env.local"), "utf8"));
const graphragEnv = parseEnv(await readFile(join(root, "graphrag-service", "graphrag_project", ".env"), "utf8"));
const settingsPath = join(root, "graphrag-service", "graphrag_project", "settings.yaml");
const promptsRoot = join(root, "graphrag-service", "graphrag_project", "prompts");
const publicCatalogPath = join(root, "knowledge", "huamei-v1", "rag", "huamei-public-safe.jsonl");
const knowledgeManifestPath = join(root, "knowledge", "huamei-v1", "manifest.json");
const knowledgeUnitsPath = join(root, "knowledge", "huamei-v1", "rag", "knowledge_units.jsonl");
const pocOutputRoot = join(root, ".team-dev", "graphrag-poc", "project", "output");
const pocManifestPath = join(pocOutputRoot, "manifest.json");
const pocReleaseRoot = join(root, ".team-dev", "graphrag-poc", "release");
const pocReleaseStorePath = join(root, ".team-dev", "graphrag-poc", "knowledge-releases.json");
const fullOutputRoot = join(root, ".team-dev", "graphrag-baseline-924", "project", "output");
const fullManifestPath = join(fullOutputRoot, "manifest.json");
const fullReleaseRoot = join(root, ".team-dev", "graphrag-baseline-924", "release");
const fullReleaseStorePath = join(root, ".team-dev", "graphrag-baseline-924", "knowledge-releases.json");
const evaluationSummaryPath = join(outputRoot, "retrieval-dataset-summary.json");
const evaluationIntegrityPath = join(outputRoot, "retrieval-data-integrity-report.json");
const evaluationReportPath = join(outputRoot, "retrieval-baseline-report.json");
const evaluationNotesPath = join(outputRoot, "retrieval-baseline-summary.md");

await mkdir(outputRoot, { recursive:true });

const gitBranch = run("git", ["branch", "--show-current"]) || "";
const gitCommit = run("git", ["rev-parse", "HEAD"]) || "";
const gitStatusText = run("git", ["status", "--short"]) || "";
const worktreeClean = gitStatusText.length === 0;
const promptsMaterial = await directoryMaterial(promptsRoot);
const promptsSha256 = sha256Text(promptsMaterial);
const apiBase = String(graphragEnv.GRAPHRAG_API_BASE || "").trim().replace(/\/+$/, "");
let apiBaseHost = null;
try { apiBaseHost = apiBase ? new URL(apiBase).host : null; } catch {}

const knowledge = loadHuameiKnowledge();
if (!knowledge.loaded) throw new Error(`Knowledge package not loaded: ${knowledge.error || "unknown"}`);
const knowledgeStatus = {
  package_name:knowledge.manifest?.package_name || null,
  package_version:knowledge.version,
  record_count:knowledge.records.length,
  public_candidate_records:knowledge.publicRecords.length,
  package_checksum:knowledge.packageChecksum,
  all_record_list_checksum:knowledge.allRecordListChecksum,
  public_safe_catalog_sha256:knowledge.publicSafeCatalogSha256,
  knowledge_units_sha256:knowledge.knowledgeUnitsSha256,
  manifest_sha256:knowledge.manifestSha256
};

let selectedIndex = { status:"not_found" };
let selectedManifest = null;
let selectedManifestPath = null;
let selectedReleaseRoot = null;
let selectedReleaseStorePath = null;
try {
  selectedManifestPath = fullManifestPath;
  selectedManifest = await readJson(selectedManifestPath);
  selectedReleaseRoot = fullReleaseRoot;
  selectedReleaseStorePath = fullReleaseStorePath;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!selectedManifest) {
  try {
    selectedManifestPath = pocManifestPath;
    selectedManifest = await readJson(selectedManifestPath);
    selectedReleaseRoot = pocReleaseRoot;
    selectedReleaseStorePath = pocReleaseStorePath;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
if (selectedManifest) {
  const unsigned = { ...selectedManifest };
  delete unsigned.manifest_sha256;
  const recomputedManifestSha256 = sha256Text(canonical(unsigned));
  selectedIndex = {
    status:selectedManifestPath === fullManifestPath ? "baseline_index" : "poc_only",
    source_path:relative(root, selectedManifestPath).replaceAll("\\", "/"),
    engine:selectedManifest.engine || null,
    index_version:selectedManifest.index_version || null,
    built_at:selectedManifest.built_at || null,
    build_method:selectedManifest.build?.method || null,
    input_record_count:selectedManifest.input?.record_count || null,
    input_sha256:selectedManifest.input?.sha256 || null,
    release_id:selectedManifest.release_binding?.release_id || null,
    tenant_id:selectedManifest.release_binding?.tenant_id || null,
    manifest_sha256:selectedManifest.manifest_sha256 || null,
    manifest_sha256_verified:recomputedManifestSha256 === selectedManifest.manifest_sha256,
    model_fingerprint_sha256:selectedManifest.model_fingerprint?.fingerprint_sha256 || null,
    artifacts:Object.fromEntries(Object.entries(selectedManifest.artifacts || {}).map(([name, artifact]) => [name, artifact.sha256 || null])),
    index_content_sha256:selectedManifest.index_content_sha256 || null
  };
}

const runtime = {
  node:process.version,
  npm:run("npm", ["--version"]),
  host_python:run("py", ["-3.12", "--version"]),
  container_python:run("docker", ["run", "--rm", "--entrypoint", "python", "huamei-graphrag:local", "--version"]),
  docker:run("docker", ["--version"]),
  graphrag:run("docker", ["run", "--rm", "--entrypoint", "python", "huamei-graphrag:local", "-c", "from importlib.metadata import version; print(version('graphrag'))"]),
  litellm:run("docker", ["run", "--rm", "--entrypoint", "python", "huamei-graphrag:local", "-c", "from importlib.metadata import version; print(version('litellm'))"]),
  graphrag_image_id:run("docker", ["image", "inspect", "huamei-graphrag:local", "--format", "{{.Id}}"])
};

const models = {
  llm_provider:envLocal.HUAMEI_LLM_PROVIDER || null,
  llm_model:envLocal.HUAMEI_LLM_MODEL || null,
  llm_base_host:(() => { try { return envLocal.HUAMEI_LLM_BASE_URL ? new URL(envLocal.HUAMEI_LLM_BASE_URL).host : null; } catch { return null; } })(),
  graphrag_provider:graphragEnv.GRAPHRAG_MODEL_PROVIDER || null,
  graphrag_completion_model:graphragEnv.GRAPHRAG_COMPLETION_MODEL || null,
  graphrag_embedding_model:graphragEnv.GRAPHRAG_EMBEDDING_MODEL || null,
  graphrag_api_base_host:apiBaseHost,
  graphrag_api_base_sha256:apiBase ? sha256Text(apiBase) : null
};

const runtimeFlags = {
  llm_enabled:String(envLocal.HUAMEI_LLM_ENABLED || "").toLowerCase() === "true",
  graphrag_enabled:String(envLocal.HUAMEI_GRAPHRAG_ENABLED || "").toLowerCase() === "true",
  graphrag_engine:envLocal.HUAMEI_GRAPHRAG_ENGINE || null,
  graphrag_index_version:envLocal.HUAMEI_GRAPHRAG_INDEX_VERSION || null,
  graphrag_timeout_ms:Number(envLocal.HUAMEI_GRAPHRAG_TIMEOUT_MS || 0) || null,
  graphrag_top_k:Number(envLocal.HUAMEI_GRAPHRAG_TOP_K || 0) || null,
  graphrag_managed_externally:String(envLocal.HUAMEI_GRAPHRAG_MANAGED_EXTERNALLY || "").toLowerCase() === "true",
  knowledge_approval_mode:envLocal.HUAMEI_KNOWLEDGE_APPROVAL_MODE || null,
  persistence_backend:envLocal.HUAMEI_PERSISTENCE_BACKEND || null
};

let evaluation = null;
try {
  const datasetSummary = await readJson(evaluationSummaryPath);
  const dataIntegrity = await readJson(evaluationIntegrityPath);
  const results = await readJson(evaluationReportPath);
  evaluation = {
    status:dataIntegrity.passed ? "complete" : "invalid",
    dataset_id:datasetSummary.dataset_id,
    case_count:datasetSummary.case_count,
    graphrag_eligible:datasetSummary.graphrag_eligible,
    dataset_sha256:datasetSummary.dataset_sha256,
    data_integrity_passed:dataIntegrity.passed,
    dataset_summary_sha256:await sha256File(evaluationSummaryPath),
    data_integrity_report_sha256:await sha256File(evaluationIntegrityPath),
    baseline_report_sha256:await sha256File(evaluationReportPath),
    baseline_summary_sha256:await sha256File(evaluationNotesPath),
    local:results.local || null,
    graphrag:results.graphrag || null,
    comparable_subset:results.comparable_subset || null,
    failure_counts:results.failures ? {
      local_no_answer:results.failures.local_no_answer_count,
      local_safety:results.failures.local_safety_count,
      graphrag_timeout:results.failures.graphrag_timeout_count,
      graphrag_miss:results.failures.graphrag_miss_count
    } : null
  };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const indexComplete = selectedIndex.status === "baseline_index";
const evaluationComplete = evaluation?.status === "complete";
const baselineStatus = indexComplete && evaluationComplete
  ? "step0_complete"
  : indexComplete ? "environment_and_index_frozen" : "environment_frozen_index_pending";

const baseline = {
  schema_version:"huamei.graphrag.baseline.v1",
  baseline_id:baselineId,
  baseline_status:baselineStatus,
  evidence_class:"development",
  created_at:nowShanghai(),
  git:{
    branch:gitBranch,
    commit:gitCommit,
    worktree_clean:worktreeClean,
    status:gitStatusText || null
  },
  runtime,
  models,
  knowledge:knowledgeStatus,
  configuration:{
    settings_path:"graphrag-service/graphrag_project/settings.yaml",
    settings_sha256:await sha256File(settingsPath),
    prompts_path:"graphrag-service/graphrag_project/prompts",
    prompts_sha256:promptsSha256
  },
  index:{
    status:selectedIndex.status === "baseline_index" ? "complete" : "pending_step_0.2",
    expected_engine:"official_graphrag_3_1_1",
    expected_record_count:knowledgeStatus.record_count,
    selected:selectedIndex
  },
  release:{
    status:"dev_fixture_only",
    production_eligible:false,
    release_store_path:selectedReleaseStorePath
      ? relative(root, selectedReleaseStorePath).replaceAll("\\", "/")
      : null
  },
  runtime_flags:runtimeFlags,
  dataset:{
    status:evaluationComplete ? "complete" : "pending_step_0.3",
    dataset_id:evaluation?.dataset_id || null,
    case_count:evaluation?.case_count || 0,
    graphrag_eligible:evaluation?.graphrag_eligible || 0,
    dataset_sha256:evaluation?.dataset_sha256 || null
  },
  evaluation,
  acceptance:{
    development_step0_complete:indexComplete && evaluationComplete && evaluation?.data_integrity_passed === true,
    production_eligible:false,
    production_blocker:"Formal three-review release and production approval are external and are not fabricated by this development baseline."
  },
  blockers:[
    ...(selectedIndex.status === "baseline_index" ? [] : ["Full 924-record official GraphRAG index is built in step 0.2."]),
    "Current release store is a development fixture and is not production eligible.",
    ...(evaluationComplete ? [] : ["Retrieval evaluation dataset is built in step 0.3."])
  ]
};

await writeFile(join(outputRoot, "baseline-manifest.json"), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
await writeFile(join(outputRoot, "git.txt"), `branch=${gitBranch}\ncommit=${gitCommit}\nworktree_clean=${worktreeClean}\nstatus=${gitStatusText || ""}\n`, "utf8");
await writeFile(join(outputRoot, "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
await writeFile(join(outputRoot, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8");
await writeFile(join(outputRoot, "runtime-flags.json"), `${JSON.stringify(runtimeFlags, null, 2)}\n`, "utf8");
await writeFile(join(outputRoot, "prompts-files.sha256"), promptsMaterial, "utf8");
await cp(settingsPath, join(outputRoot, "settings.yaml"));
await cp(knowledgeManifestPath, join(outputRoot, "knowledge-package-manifest.json"));
await copyIfExists(publicCatalogPath, join(outputRoot, "huamei-public-safe.jsonl"));
if (selectedManifestPath) await copyIfExists(selectedManifestPath, join(outputRoot, "index-manifest.json"));
if (selectedReleaseRoot) {
  await copyIfExists(join(selectedReleaseRoot, "release-binding.json"), join(outputRoot, "release-binding.json"));
  await copyIfExists(join(selectedReleaseRoot, "approved-records.json"), join(outputRoot, "approved-records.json"));
}
if (selectedReleaseStorePath) await copyIfExists(selectedReleaseStorePath, join(outputRoot, "knowledge-releases.json"));

const files = (await walkFiles(outputRoot)).sort();
const checksumLines = [];
for (const path of files) {
  const relativePath = relative(outputRoot, path).replaceAll("\\", "/");
  if (relativePath === "checksums.sha256" || relativePath === "baseline-receipt.json") continue;
  checksumLines.push(`${await sha256File(path)}  ${relativePath}`);
}
await writeFile(join(outputRoot, "checksums.sha256"), `${checksumLines.join("\n")}\n`, "utf8");

const receipt = {
  baseline_id:baselineId,
  baseline_manifest_sha256:await sha256File(join(outputRoot, "baseline-manifest.json")),
  checksums_sha256:await sha256File(join(outputRoot, "checksums.sha256")),
  created_at:baseline.created_at
};
await writeFile(join(outputRoot, "baseline-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  output:outputRoot,
  baseline_id:baselineId,
  baseline_status:baseline.baseline_status,
  git:baseline.git,
  knowledge:baseline.knowledge,
  index:baseline.index.selected,
  receipt
}, null, 2));
