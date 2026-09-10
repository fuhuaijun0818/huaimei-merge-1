import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectLocalOfficialGraphRag,
  OFFICIAL_GRAPHRAG_ENGINE,
  OFFICIAL_INDEX_MANIFEST_SCHEMA,
  validateOfficialGraphRagReadiness
} from "../scripts/local-graphrag-admission.mjs";

const digest = "a".repeat(64);
const root = mkdtempSync(join(tmpdir(), "huamei-local-graphrag-admission-"));
const indexRoot = join(root, "indexes");
const projectRoot = join(root, "project");
const outputRoot = join(projectRoot, "output");
mkdirSync(indexRoot, { recursive:true });
mkdirSync(outputRoot, { recursive:true });
writeFileSync(join(projectRoot, "settings.yaml"), "models: {}\n");
writeFileSync(join(indexRoot, "current.json"), JSON.stringify({ version:"official-v1" }));

assert.equal(
  inspectLocalOfficialGraphRag({ indexRoot, officialProjectRoot:projectRoot }).code,
  "GRAPHRAG_OFFICIAL_MANIFEST_MISSING"
);

const artifactFiles = {
  entities:"entities.parquet",
  communities:"communities.parquet",
  community_reports:"community_reports.parquet",
  text_units:"text_units.parquet",
  relationships:"relationships.parquet",
  record_catalog:"record_catalog.jsonl"
};
for (const relativePath of Object.values(artifactFiles)) {
  writeFileSync(join(outputRoot, relativePath), "test fixture");
}
const manifest = {
  schema_version:OFFICIAL_INDEX_MANIFEST_SCHEMA,
  engine:OFFICIAL_GRAPHRAG_ENGINE,
  index_version:"official-v1",
  manifest_sha256:digest,
  release_binding:{ tenant_id:"tenant-a", release_id:"release-a" },
  artifacts:Object.fromEntries(Object.entries(artifactFiles).map(([name, path]) => [name, { path, sha256:digest }]))
};
writeFileSync(join(outputRoot, "manifest.json"), JSON.stringify({ ...manifest, engine:"bootstrap_graph" }));
assert.equal(
  inspectLocalOfficialGraphRag({ indexRoot, officialProjectRoot:projectRoot }).code,
  "GRAPHRAG_OFFICIAL_ENGINE_REQUIRED"
);

writeFileSync(join(outputRoot, "manifest.json"), JSON.stringify({ ...manifest, index_version:"official-v2" }));
assert.equal(
  inspectLocalOfficialGraphRag({ indexRoot, officialProjectRoot:projectRoot }).code,
  "GRAPHRAG_ACTIVE_INDEX_VERSION_MISMATCH"
);

writeFileSync(join(outputRoot, "manifest.json"), JSON.stringify(manifest));
const localAdmission = inspectLocalOfficialGraphRag({ indexRoot, officialProjectRoot:projectRoot });
assert.equal(localAdmission.admitted, true);
assert.equal(localAdmission.expectedVersion, "official-v1");

const readyPayload = {
  ready:true,
  engine:OFFICIAL_GRAPHRAG_ENGINE,
  index_version:"official-v1",
  tenant_id:"tenant-a",
  release_id:"release-a",
  manifest_sha256:digest
};
assert.equal(validateOfficialGraphRagReadiness(readyPayload, { expectedVersion:"official-v1" }).admitted, true);
assert.equal(
  validateOfficialGraphRagReadiness({ ...readyPayload, engine:"bootstrap_graph" }).code,
  "GRAPHRAG_OFFICIAL_ENGINE_REQUIRED"
);
assert.equal(
  validateOfficialGraphRagReadiness({ ...readyPayload, index_version:"official-v2" }, { expectedVersion:"official-v1" }).code,
  "GRAPHRAG_READY_INDEX_VERSION_MISMATCH"
);
assert.equal(
  validateOfficialGraphRagReadiness({ ...readyPayload, release_id:"" }).code,
  "GRAPHRAG_READY_RELEASE_BINDING_MISSING"
);

const realProjectRoot = fileURLToPath(new URL("../", import.meta.url));
const realAdmission = inspectLocalOfficialGraphRag({
  indexRoot:join(realProjectRoot, "graphrag-service", "data", "indexes"),
  officialProjectRoot:join(realProjectRoot, "graphrag-service", "graphrag_project")
});
assert.equal(realAdmission.admitted, false, "只有bootstrap索引时，本地主链路必须失败关闭");
assert.equal(realAdmission.code, "GRAPHRAG_BOOTSTRAP_INDEX_NOT_ADMITTED");

console.log("✓ 本地GraphRAG启动前与在线正式引擎门禁验证通过");
