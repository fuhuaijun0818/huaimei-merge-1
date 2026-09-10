import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  FORMAL_LOAD_TAXONOMY_ALGORITHM,
  FORMAL_LOAD_TAXONOMY_MANIFEST_SCHEMA,
  getFormalLoadTaxonomyCatalog,
  signFormalLoadTaxonomyManifest
} from "../server/platform/formal-load-taxonomy.mjs";
import {
  evidenceError,
  mainModule,
  parseCliOptions,
  readJsonWithSha,
  writeJsonAtomic
} from "./formal-evidence-common.mjs";

const boolChecklist = (value = false) => ({
  privacy_boundary_reviewed:value,
  taxonomy_catalog_reviewed:value,
  cache_resistance_plan_reviewed:value,
  model_cost_and_quota_approved:value,
  load_window_approved:value,
  rollback_owner_confirmed:value
});

const environmentName = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "prod") return "production";
  if (normalized === "preprod") return "preproduction";
  return normalized;
};

export function createFormalLoadTaxonomyManifestDraft(options = {}, env = process.env) {
  const catalog = getFormalLoadTaxonomyCatalog();
  const notBefore = String(options["not-before"] || "");
  const notAfter = String(options["not-after"] || "");
  if (!Number.isFinite(Date.parse(notBefore)) || !Number.isFinite(Date.parse(notAfter))
    || Date.parse(notAfter) <= Date.parse(notBefore)) {
    throw evidenceError("FORMAL_LOAD_TAXONOMY_APPROVAL_WINDOW_REQUIRED");
  }
  return {
    schema_version:FORMAL_LOAD_TAXONOMY_MANIFEST_SCHEMA,
    manifest_id:String(options["manifest-id"] || "formal-load-taxonomy-pending"),
    tenant_id:String(options["tenant-id"] || env.HUAMEI_RELEASE_TENANT_ID || env.HUAMEI_PUBLIC_TENANT_ID || "").trim().toLowerCase(),
    environment:environmentName(options.environment || env.HUAMEI_EVIDENCE_ENVIRONMENT || env.HUAMEI_RUNTIME_ENV),
    release_id:String(options["release-id"] || env.HUAMEI_RELEASE_ID || "").trim(),
    knowledge_release_id:String(options["knowledge-release-id"] || env.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID || "").trim(),
    index_version:String(options["index-version"] || env.HUAMEI_GRAPHRAG_INDEX_VERSION || "").trim(),
    knowledge_manifest_sha256:String(options["knowledge-manifest-sha256"] || env.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256 || "").trim().toLowerCase(),
    catalog_sha256:catalog.sha256,
    algorithm_version:FORMAL_LOAD_TAXONOMY_ALGORITHM,
    allowed_profile_ids:catalog.profiles.map((profile) => profile.id),
    max_ordinal_per_profile:Number(options["max-ordinal-per-profile"] || 300_000),
    maximum_requests:Number(options["maximum-requests"] || 1_000_000),
    not_before:notBefore,
    not_after:notAfter,
    approval:{
      status:"draft",
      approval_id:String(options["approval-id"] || "formal-load-approval-pending"),
      approved_by:String(options["approved-by"] || "formal-load-approver-pending"),
      approved_at:String(options["approved-at"] || notBefore),
      checklist:boolChecklist(false)
    }
  };
}

const assertReadyForSignature = (manifest) => {
  const checklist = manifest?.approval?.checklist || {};
  if (manifest?.approval?.status !== "approved" || Object.values(boolChecklist()).some((_, index) => {
    const key = Object.keys(boolChecklist())[index];
    return checklist[key] !== true;
  })) throw evidenceError("FORMAL_LOAD_TAXONOMY_APPROVAL_CHECKLIST_INCOMPLETE");
};

export async function runFormalLoadTaxonomyManifestCli(options = {}, env = process.env) {
  const mode = String(options.mode || "draft");
  const output = String(options.output || "");
  if (!isAbsolute(output)) throw evidenceError("FORMAL_LOAD_TAXONOMY_OUTPUT_ABSOLUTE_PATH_REQUIRED");
  if (mode === "draft") {
    return writeJsonAtomic(output, createFormalLoadTaxonomyManifestDraft(options, env));
  }
  if (mode !== "sign") throw evidenceError("FORMAL_LOAD_TAXONOMY_MODE_INVALID");
  const input = String(options.input || "");
  const inputSha256 = String(options["input-sha256"] || "");
  const source = await readJsonWithSha({
    path:input,
    expectedSha:inputSha256,
    label:"FORMAL_LOAD_TAXONOMY_UNSIGNED_MANIFEST",
    maximumBytes:512 * 1024
  });
  assertReadyForSignature(source.document);
  const signerId = String(env.HUAMEI_FORMAL_LOAD_TAXONOMY_APPROVER_SIGNER_ID || "").trim();
  const keyPath = String(env.HUAMEI_FORMAL_LOAD_TAXONOMY_APPROVER_SIGNING_KEY_PATH || "").trim();
  if (!isAbsolute(keyPath)) throw evidenceError("FORMAL_LOAD_TAXONOMY_APPROVER_SIGNING_KEY_PATH_REQUIRED");
  const keyBytes = await readFile(keyPath);
  if (!keyBytes.length || keyBytes.length > 32 * 1024) throw evidenceError("FORMAL_LOAD_TAXONOMY_APPROVER_SIGNING_KEY_INVALID");
  const signed = signFormalLoadTaxonomyManifest(source.document, {
    signerId,
    privateKey:keyBytes,
    signedAt:options["signed-at"] || new Date().toISOString()
  });
  return writeJsonAtomic(output, signed);
}

if (mainModule(import.meta.url)) {
  try {
    const result = await runFormalLoadTaxonomyManifestCli(parseCliOptions());
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status:"blocked", code:error.code || "FORMAL_LOAD_TAXONOMY_MANIFEST_FAILED" }));
    process.exitCode = 1;
  }
}
