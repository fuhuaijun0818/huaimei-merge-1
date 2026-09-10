import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FORMAL_LOAD_TAXONOMY_ALGORITHM,
  FORMAL_LOAD_TAXONOMY_MANIFEST_SCHEMA,
  getFormalLoadTaxonomyCatalog,
  isValidatedFormalLoadTaxonomyEntry,
  queryForFormalLoadTaxonomyEntry,
  resetFormalLoadTaxonomyForTest,
  resolveFormalLoadTaxonomyEntry,
  signFormalLoadTaxonomyManifest
} from "../server/platform/formal-load-taxonomy.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const catalog = getFormalLoadTaxonomyCatalog();
const now = Date.parse("2026-08-26T08:00:00.000Z");
const manifestBase = {
  schema_version:FORMAL_LOAD_TAXONOMY_MANIFEST_SCHEMA,
  manifest_id:"formal-load-taxonomy-2026-08-26-a",
  tenant_id:"huamei-shanghai",
  environment:"preproduction",
  release_id:"release-2026-08-26-r1",
  knowledge_release_id:"krel-formal-2026-08-26",
  index_version:"huamei-index-2026-08-26-v1",
  knowledge_manifest_sha256:"a".repeat(64),
  catalog_sha256:catalog.sha256,
  algorithm_version:FORMAL_LOAD_TAXONOMY_ALGORITHM,
  allowed_profile_ids:catalog.profiles.map((profile) => profile.id),
  max_ordinal_per_profile:300_000,
  maximum_requests:1_000_000,
  not_before:"2026-08-26T07:00:00.000Z",
  not_after:"2026-08-26T10:00:00.000Z",
  approval:{
    status:"approved",
    approval_id:"formal-load-approval-2026-08-26-a",
    approved_by:"capacity-review-board-001",
    approved_at:"2026-08-26T07:30:00.000Z",
    checklist:{
      privacy_boundary_reviewed:true,
      taxonomy_catalog_reviewed:true,
      cache_resistance_plan_reviewed:true,
      model_cost_and_quota_approved:true,
      load_window_approved:true,
      rollback_owner_confirmed:true
    }
  }
};
const signed = signFormalLoadTaxonomyManifest(manifestBase, {
  signerId:"taxonomy-approver-001",
  privateKey,
  signedAt:"2026-08-26T07:40:00.000Z"
});
const directory = await mkdtemp(join(tmpdir(), "huamei-taxonomy-"));
const manifestPath = join(directory, "manifest.json");
const manifestBytes = Buffer.from(`${JSON.stringify(signed, null, 2)}\n`);
await writeFile(manifestPath, manifestBytes, { mode:0o600 });
const trustedSigners = {
  "taxonomy-approver-001":{
    authority_role:"formal_load_taxonomy_approver",
    allowed_schemas:[FORMAL_LOAD_TAXONOMY_MANIFEST_SCHEMA],
    tenant_ids:["huamei-shanghai"],
    public_key_spki_der_base64:publicKey.export({ format:"der", type:"spki" }).toString("base64")
  }
};
const env = {
  HUAMEI_FORMAL_LOAD_TAXONOMY_ENABLED:"true",
  HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_PATH:manifestPath,
  HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256:sha(manifestBytes),
  HUAMEI_FORMAL_LOAD_TAXONOMY_TRUSTED_SIGNERS_B64:Buffer.from(JSON.stringify(trustedSigners)).toString("base64"),
  HUAMEI_RELEASE_TENANT_ID:"huamei-shanghai",
  HUAMEI_EVIDENCE_ENVIRONMENT:"preproduction",
  HUAMEI_RELEASE_ID:"release-2026-08-26-r1",
  HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID:"krel-formal-2026-08-26",
  HUAMEI_GRAPHRAG_INDEX_VERSION:"huamei-index-2026-08-26-v1",
  HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256:"a".repeat(64)
};

resetFormalLoadTaxonomyForTest();
const first = await resolveFormalLoadTaxonomyEntry("eye.0", { env, now });
const second = await resolveFormalLoadTaxonomyEntry("eye.1", { env, now });
assert.equal(isValidatedFormalLoadTaxonomyEntry(first), true);
assert.equal(first.manifestSha256, env.HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256);
assert.equal(first.signerId, "taxonomy-approver-001");
assert.notEqual(first.query, second.query);
assert.equal(first.querySha256, sha(Buffer.from(first.query)));
assert.doesNotMatch(first.query, /检索变体|nonce|会话校验码|\d{6,}/i);

// A cached, already verified manifest must not survive a runtime binding
// change. This models a long-lived replica rolling to another release/index.
await assert.rejects(
  resolveFormalLoadTaxonomyEntry("eye.2", { env:{ ...env, HUAMEI_RELEASE_ID:"another-release" }, now }),
  (error) => error.code === "FORMAL_LOAD_TAXONOMY_MANIFEST_BINDING_MISMATCH"
);

const eye = catalog.profiles.find((profile) => profile.id === "eye");
const generated = new Set();
for (let ordinal = 0; ordinal < 20_000; ordinal += 1) {
  generated.add(queryForFormalLoadTaxonomyEntry(eye, ordinal));
}
assert.equal(generated.size, 20_000, "正式30分钟容量空间不得在2500次后复用query");
assert.ok(eye.capacity >= 300_000, "每个业务profile必须覆盖长时20用户容量窗口");

await assert.rejects(
  resolveFormalLoadTaxonomyEntry("eye.300000", { env, now }),
  (error) => error.code === "FORMAL_LOAD_TAXONOMY_ENTRY_NOT_APPROVED"
);
await assert.rejects(
  resolveFormalLoadTaxonomyEntry("eye.0 nonce", { env, now }),
  (error) => error.code === "FORMAL_LOAD_TAXONOMY_ENTRY_ID_INVALID"
);
resetFormalLoadTaxonomyForTest();
await assert.rejects(
  resolveFormalLoadTaxonomyEntry("eye.0", { env:{ ...env, HUAMEI_FORMAL_LOAD_TAXONOMY_ENABLED:"false" }, now }),
  (error) => error.code === "FORMAL_LOAD_TAXONOMY_DISABLED"
);
resetFormalLoadTaxonomyForTest();
await assert.rejects(
  resolveFormalLoadTaxonomyEntry("eye.0", { env:{ ...env, HUAMEI_RELEASE_ID:"another-release" }, now }),
  (error) => error.code === "FORMAL_LOAD_TAXONOMY_MANIFEST_BINDING_MISMATCH"
);
resetFormalLoadTaxonomyForTest();
await assert.rejects(
  resolveFormalLoadTaxonomyEntry("eye.0", { env, now:Date.parse("2026-08-26T10:00:01.000Z") }),
  (error) => error.code === "FORMAL_LOAD_TAXONOMY_APPROVAL_WINDOW_INVALID"
);

const tampered = Buffer.from((await readFile(manifestPath, "utf8")).replace("1_000_000", "999999"));
// The JSON renders numeric separators without underscores, so force a real byte
// mutation that remains valid JSON and is blocked by the externally supplied SHA.
const altered = Buffer.from(tampered.toString("utf8").replace('"maximum_requests": 1000000', '"maximum_requests": 999999'));
await writeFile(manifestPath, altered, { mode:0o600 });
resetFormalLoadTaxonomyForTest();
await assert.rejects(
  resolveFormalLoadTaxonomyEntry("eye.0", { env, now }),
  (error) => error.code === "FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256_MISMATCH"
);
resetFormalLoadTaxonomyForTest();
await assert.rejects(
  resolveFormalLoadTaxonomyEntry("eye.0", {
    env:{ ...env, HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256:sha(altered) },
    now
  }),
  (error) => error.code === "FORMAL_LOAD_TAXONOMY_SIGNED_PAYLOAD_SHA256_MISMATCH"
);
await writeFile(manifestPath, manifestBytes, { mode:0o600 });
resetFormalLoadTaxonomyForTest();
await assert.rejects(
  resolveFormalLoadTaxonomyEntry("eye.0", {
    env:{
      ...env,
      HUAMEI_FORMAL_LOAD_TAXONOMY_TRUSTED_SIGNERS_B64:Buffer.from(JSON.stringify({})).toString("base64")
    },
    now
  }),
  (error) => error.code === "FORMAL_LOAD_TAXONOMY_CONFIGURATION_INVALID"
);

const [serviceSource, openApiSource, privacySource, directLoadSource, formalRunnerSource, composeSource, formalComposeSource] = await Promise.all([
  readFile(new URL("../server/acquisition-service-server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../server/acquisition-service-openapi.mjs", import.meta.url), "utf8"),
  readFile(new URL("../graphrag-service/app/query_privacy.py", import.meta.url), "utf8"),
  readFile(new URL("../graphrag-service/loadtest/load_500.py", import.meta.url), "utf8"),
  readFile(new URL("../graphrag-service/loadtest/soak_multiturn.py", import.meta.url), "utf8"),
  readFile(new URL("../deploy/docker-compose.example.yml", import.meta.url), "utf8"),
  readFile(new URL("../deploy/docker-compose.formal-capacity.example.yml", import.meta.url), "utf8")
]);
assert.match(serviceSource, /permit\(FORMAL_LOAD_TAXONOMY_PERMISSION\)/, "entry ID必须要求专用caller权限");
assert.match(serviceSource, /FORMAL_LOAD_TAXONOMY_UNSUPPORTED_INPUT/, "query、nonce等未批准输入必须失败关闭");
assert.match(openApiSource, /X-Huamei-Formal-Load-Entry-Id/, "OpenAPI必须只暴露受控entry ID");
assert.doesNotMatch(privacySource, /_SYNTHETIC_LOAD_VARIANT|检索变体/, "GraphRAG通用隐私边界不得保留synthetic variant旁路");
assert.doesNotMatch(directLoadSource, /检索变体|_SYNTHETIC_LOAD_VARIANT/, "Graph直连负载不得伪造多样性");
assert.match(formalRunnerSource, /X-Huamei-Formal-Load-Entry-Id/, "正式runner必须仅传entry ID");
assert.match(formalRunnerSource, /ordinal = turn \* args\.users \+ user_index/, "正式runner必须为每个请求分配唯一ordinal");
assert.match(composeSource, /HUAMEI_FORMAL_LOAD_TAXONOMY_ENABLED:\s*"false"/, "普通部署必须默认关闭正式taxonomy通道");
assert.match(formalComposeSource, /taxonomy-manifest\.json:ro/, "正式压测manifest必须只读挂载");
assert.match(formalComposeSource, /HUAMEI_FORMAL_LOAD_TAXONOMY_TRUSTED_SIGNERS_B64/, "正式压测必须注入外置Ed25519信任注册表");

console.log("✓ 正式容量taxonomy：默认关闭、专用entry、签名/SHA/版本/时窗绑定与长时不复用通过");
