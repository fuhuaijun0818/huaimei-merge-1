import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraphRagReadinessQuery } from "../server/platform/external-dependency-readiness.mjs";
import { loadHuameiKnowledge } from "../server/huamei-knowledge.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const graphRoot = join(projectRoot, "graphrag-service");
const localPython = join(projectRoot, ".venv-graphrag", "bin", "python");
const python = existsSync(localPython) ? localPython : (process.env.PYTHON || "python3");
const state = loadHuameiKnowledge({ force:true });
const record = state.publicRecords.find((item) => item.record_id === "kb_dir_ff0158b496b5977d");
assert.ok(record, "跨runtime探针固定记录必须存在于Node不可变目录");
const query = buildGraphRagReadinessQuery(record);
assert.equal(query, "医生介绍 整形外科 李健");

const pythonProgram = String.raw`
import json
import sys
from pathlib import Path
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

service_root = Path(sys.argv[1]).resolve()
query = sys.argv[2]
record_id = sys.argv[3]
current = json.loads((service_root / "data" / "indexes" / "current.json").read_text(encoding="utf-8"))["version"]
settings = Settings(
    service_name="huamei-graphrag-readiness-contract",
    host="127.0.0.1",
    port=4191,
    service_key="",
    metrics_token="",
    index_root=service_root / "data" / "indexes",
    active_version=current,
    engine="bootstrap",
    max_concurrency=8,
    queue_timeout_seconds=1,
    request_timeout_seconds=6,
    cache_ttl_seconds=300,
    cache_max_entries=100,
    max_top_k=12,
    official_project_root=service_root / "graphrag_project",
)
with TestClient(create_app(settings)) as client:
    payload = {"tenant_id":"huamei-shanghai", "query":query, "top_k":1, "readiness_probe":True}
    first = client.post("/v1/retrieve", json=payload)
    second = client.post("/v1/retrieve", json=payload)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["cache_hit"] is False
    assert second.json()["cache_hit"] is False
    assert first.json()["evidence"][0]["record_id"] == record_id, first.text
print("ok")
`;

const completed = spawnSync(python, ["-c", pythonProgram, graphRoot, query, record.record_id], {
  cwd:projectRoot,
  encoding:"utf8",
  env:{ ...process.env, PYTHONPATH:graphRoot }
});
assert.equal(completed.status, 0, completed.stderr || completed.stdout || "Python GraphRAG端点验证失败");
assert.equal(completed.stdout.trim(), "ok");

console.log("✓ Node固定安全探针经真实Python隐私边界、检索端点及缓存旁路验证通过");
