import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const OFFICIAL_GRAPHRAG_ENGINE = "official_graphrag_3_1_1";
export const OFFICIAL_INDEX_MANIFEST_SCHEMA = "huamei.graphrag.index-manifest.v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUIRED_OFFICIAL_ARTIFACTS = Object.freeze({
  entities:"entities.parquet",
  communities:"communities.parquet",
  community_reports:"community_reports.parquet",
  text_units:"text_units.parquet",
  relationships:"relationships.parquet",
  record_catalog:"record_catalog.jsonl"
});

const rejected = (code) => Object.freeze({ admitted:false, code });

const readJson = (path, missingCode, invalidCode) => {
  if (!existsSync(path)) return { error:missingCode };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { value }
      : { error:invalidCode };
  } catch {
    return { error:invalidCode };
  }
};

/**
 * Perform the cheap, side-effect-free admission check needed before spawning
 * the local Python service. The Python official engine remains authoritative:
 * it verifies manifest/artifact digests, the three-review release receipt and
 * the model configuration fingerprint before its readiness endpoint exists.
 */
export function inspectLocalOfficialGraphRag({
  indexRoot,
  officialProjectRoot,
  configuredVersion = ""
}) {
  const normalizedIndexRoot = resolve(String(indexRoot || ""));
  const normalizedProjectRoot = resolve(String(officialProjectRoot || ""));
  let expectedVersion = String(configuredVersion || "").trim();

  if (!expectedVersion) {
    const pointer = readJson(
      join(normalizedIndexRoot, "current.json"),
      "GRAPHRAG_ACTIVE_INDEX_POINTER_MISSING",
      "GRAPHRAG_ACTIVE_INDEX_POINTER_INVALID"
    );
    if (pointer.error) return rejected(pointer.error);
    expectedVersion = String(pointer.value.version || "").trim();
  }
  if (!expectedVersion) return rejected("GRAPHRAG_ACTIVE_INDEX_VERSION_MISSING");

  // Legacy/bootstrap indexes live below indexRoot. Detect the common local
  // state explicitly so operators see a deliberate fail-closed decision,
  // rather than mistaking a present bootstrap pointer for an official index.
  const pointedManifestPath = join(normalizedIndexRoot, expectedVersion, "manifest.json");
  if (existsSync(pointedManifestPath)) {
    const pointedManifest = readJson(
      pointedManifestPath,
      "GRAPHRAG_ACTIVE_INDEX_MANIFEST_MISSING",
      "GRAPHRAG_ACTIVE_INDEX_MANIFEST_INVALID"
    );
    if (pointedManifest.error) return rejected(pointedManifest.error);
    if (pointedManifest.value.engine && pointedManifest.value.engine !== OFFICIAL_GRAPHRAG_ENGINE) {
      return rejected("GRAPHRAG_BOOTSTRAP_INDEX_NOT_ADMITTED");
    }
  }

  const settingsPath = join(normalizedProjectRoot, "settings.yaml");
  if (!existsSync(settingsPath)) return rejected("GRAPHRAG_OFFICIAL_SETTINGS_MISSING");
  const outputRoot = join(normalizedProjectRoot, "output");
  const manifest = readJson(
    join(outputRoot, "manifest.json"),
    "GRAPHRAG_OFFICIAL_MANIFEST_MISSING",
    "GRAPHRAG_OFFICIAL_MANIFEST_INVALID"
  );
  if (manifest.error) return rejected(manifest.error);
  if (manifest.value.schema_version !== OFFICIAL_INDEX_MANIFEST_SCHEMA) {
    return rejected("GRAPHRAG_OFFICIAL_MANIFEST_UNREVIEWED");
  }
  if (manifest.value.engine !== OFFICIAL_GRAPHRAG_ENGINE) {
    return rejected("GRAPHRAG_OFFICIAL_ENGINE_REQUIRED");
  }
  if (manifest.value.index_version !== expectedVersion) {
    return rejected("GRAPHRAG_ACTIVE_INDEX_VERSION_MISMATCH");
  }
  if (!SHA256_PATTERN.test(String(manifest.value.manifest_sha256 || ""))) {
    return rejected("GRAPHRAG_OFFICIAL_MANIFEST_SHA256_MISSING");
  }
  const releaseBinding = manifest.value.release_binding;
  if (!releaseBinding || typeof releaseBinding !== "object"
    || !String(releaseBinding.tenant_id || "").trim()
    || !String(releaseBinding.release_id || "").trim()) {
    return rejected("GRAPHRAG_OFFICIAL_RELEASE_BINDING_MISSING");
  }
  const artifacts = manifest.value.artifacts;
  if (!artifacts || typeof artifacts !== "object") {
    return rejected("GRAPHRAG_OFFICIAL_ARTIFACT_MANIFEST_MISSING");
  }
  for (const [artifactName, relativePath] of Object.entries(REQUIRED_OFFICIAL_ARTIFACTS)) {
    const metadata = artifacts[artifactName];
    if (!metadata || metadata.path !== relativePath || !SHA256_PATTERN.test(String(metadata.sha256 || ""))) {
      return rejected(`GRAPHRAG_OFFICIAL_ARTIFACT_METADATA_INVALID:${artifactName}`);
    }
    if (!existsSync(join(outputRoot, relativePath))) {
      return rejected(`GRAPHRAG_OFFICIAL_ARTIFACT_MISSING:${artifactName}`);
    }
  }
  return Object.freeze({
    admitted:true,
    code:"GRAPHRAG_OFFICIAL_INDEX_CANDIDATE_PRESENT",
    expectedVersion
  });
}

/** Validate the live service identity before exposing it to acquisition. */
export function validateOfficialGraphRagReadiness(payload, { expectedVersion = "" } = {}) {
  if (!payload || typeof payload !== "object" || payload.ready !== true) {
    return rejected("GRAPHRAG_SERVICE_NOT_READY");
  }
  if (payload.engine !== OFFICIAL_GRAPHRAG_ENGINE) {
    return rejected("GRAPHRAG_OFFICIAL_ENGINE_REQUIRED");
  }
  const indexVersion = String(payload.index_version || "").trim();
  if (!indexVersion) return rejected("GRAPHRAG_READY_INDEX_VERSION_MISSING");
  if (expectedVersion && indexVersion !== expectedVersion) {
    return rejected("GRAPHRAG_READY_INDEX_VERSION_MISMATCH");
  }
  if (!String(payload.tenant_id || "").trim() || !String(payload.release_id || "").trim()) {
    return rejected("GRAPHRAG_READY_RELEASE_BINDING_MISSING");
  }
  if (!SHA256_PATTERN.test(String(payload.manifest_sha256 || ""))) {
    return rejected("GRAPHRAG_READY_MANIFEST_SHA256_MISSING");
  }
  return Object.freeze({
    admitted:true,
    code:"GRAPHRAG_OFFICIAL_SERVICE_READY",
    expectedVersion:indexVersion
  });
}
