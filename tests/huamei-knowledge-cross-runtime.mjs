import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHuameiKnowledge } from "../server/huamei-knowledge.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const graphRoot = join(projectRoot, "graphrag-service");
const catalogPath = join(graphRoot, "graphrag_project", "input", "huamei-public-safe.jsonl");
const knowledgeRoot = join(projectRoot, "knowledge", "huamei-v1");
const localPython = join(projectRoot, ".venv-graphrag", "bin", "python");
const python = existsSync(localPython) ? localPython : (process.env.PYTHON || "python3");

const state = loadHuameiKnowledge({
  force:true,
  root:knowledgeRoot,
  publicSafeCatalog:catalogPath
});
assert.equal(state.loaded, true, state.error || "Node必须加载公共安全目录");

const pythonProgram = String.raw`
import json
import sys
from pathlib import Path
from app.index_manifest import approved_record_list_sha256, load_official_input_records, sha256_path
from scripts.build_bootstrap_index import load_reviewed_catalog

catalog = Path(sys.argv[1]).resolve()
full_records, raw_bytes = load_reviewed_catalog(catalog)
approved_records = load_official_input_records(catalog)
print(json.dumps({
    "record_count": len(full_records),
    "approved_record_count": len(approved_records),
    "package_sha256": sha256_path(catalog),
    "record_list_sha256": approved_record_list_sha256(approved_records),
}))
`;
const completed = spawnSync(python, ["-c", pythonProgram, catalogPath], {
  cwd:projectRoot,
  encoding:"utf8",
  env:{ ...process.env, PYTHONPATH:graphRoot }
});
assert.equal(completed.status, 0, completed.stderr || completed.stdout || "Python校验器执行失败");
const pythonResult = JSON.parse(completed.stdout);

assert.equal(state.publicRecords.length, 925, "正式公共安全目录必须是已审的925条记录");
assert.equal(state.declaredRecordHashCount, 925, "925条记录都必须声明内容SHA");
assert.equal(pythonResult.record_count, 925);
assert.equal(pythonResult.approved_record_count, 925);
assert.equal(state.publicSafeCatalogSha256, pythonResult.package_sha256);
assert.equal(state.packageChecksum, pythonResult.package_sha256);
assert.equal(state.allRecordListChecksum, pythonResult.record_list_sha256);
assert.equal(
  state.packageChecksum,
  "e7fdea5b66fa2c04764319c08ba3d9fb52bc8164c302c9c83ebbc4350e44d78c",
  "公共安全目录内容变更必须经过显式复核"
);
assert.equal(
  state.allRecordListChecksum,
  "c05a3c3469f01b89fd7d684a04d38b0425a49fc396bb7fb9e7f168e30824bc50",
  "批准记录集变更必须经过显式复核"
);

console.log("✓ 925条真实公共安全目录在Node与Python间package/record-list SHA完全一致");
console.log(`  package=${state.packageChecksum}`);
console.log(`  record-list=${state.allRecordListChecksum}`);
