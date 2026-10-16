// Generates cryptographically signed, clearly marked local-only evidence for
// C013 AC1. It neither activates nor mutates publication packages.
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { listKnowledgePublications } from "../server/knowledge-publication.mjs";
import {
  signEvidenceDocument,
  verifyEvidenceDocumentAttestation,
  writeJsonAtomic
} from "../scripts/formal-evidence-common.mjs";
import {
  PRODUCTION_EVALUATION_POLICY_VERSION,
  PRODUCTION_METRIC_DEFINITIONS,
  REQUIRED_EVALUATION_FAMILIES,
  validateProductionEvaluationSubmission
} from "../scripts/production-evaluation-policy.mjs";

const option = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || "";
};
const packageAId = option("package-a");
const packageBId = option("package-b");
const tenantId = option("tenant") || "team_alpha";

if (!packageAId || !packageBId || packageAId === packageBId) {
  throw new Error("Usage: node devkit/generate-c013-ac1-evaluations.mjs --package-a=kpub_... --package-b=kpub_... [--tenant=team_alpha]");
}
if (process.env.HUAMEI_PERSISTENCE_BACKEND !== "postgres") {
  throw new Error("C013 local evidence generation requires HUAMEI_PERSISTENCE_BACKEND=postgres");
}

const outputDirectory = resolve(".local-data", "c013-ac1");
const privateKeyPath = resolve(outputDirectory, "local-evaluation-issuer.private.pem");
const signerId = "local-c013-evaluation-issuer";

const privateKey = async () => {
  if (existsSync(privateKeyPath)) return createPrivateKey(await readFile(privateKeyPath));
  const generated = generateKeyPairSync("ed25519");
  await mkdir(outputDirectory, { recursive:true, mode:0o700 });
  await writeFile(privateKeyPath, generated.privateKey.export({ format:"pem", type:"pkcs8" }), { encoding:"utf8", mode:0o600 });
  return generated.privateKey;
};

const issuer = await privateKey();
const publicKey = issuer.asymmetricKeyType === "ed25519" ? issuer : null;
if (!publicKey) throw new Error("Local evaluation issuer must be an Ed25519 key");
// Node derives a public key from the private key without retaining a second private key.
const { createPublicKey } = await import("node:crypto");
const registry = {
  [signerId]:{
    authority_role:"formal_evidence_issuer",
    allowed_kinds:["evaluation_report"],
    public_key_spki_der_base64:createPublicKey(issuer).export({ format:"der", type:"spki" }).toString("base64"),
    local_test_only:true,
    purpose:"C013 AC1 isolated-development acceptance"
  }
};
const registryBase64 = Buffer.from(JSON.stringify(registry)).toString("base64");

const principal = {
  tenantId,
  subject:"local-c013-evidence-builder",
  roles:["质量与运营人员"],
  departmentIds:["demo"]
};
const publications = await listKnowledgePublications(principal);
const findPackage = (id) => {
  const pkg = publications.find((item) => item.id === id);
  if (!pkg) throw new Error(`Publication package is unavailable in ${tenantId}: ${id}`);
  if (!pkg.documents.length) throw new Error(`Publication package has no documents: ${id}`);
  return pkg;
};

const reportFor = (pkg, label) => {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const evaluationFamilies = Object.fromEntries(Object.keys(REQUIRED_EVALUATION_FAMILIES).map((name) => [name, {
    dataset_id:`c013-ac1-${label}-${name}`,
    evidence_ref:`c013-ac1-${label}-${name}-local-only`,
    sample_count:2,
    ...(name === "online_real_questions" ? { deidentified:true } : {}),
    ...(name === "manual_blind_review" ? { blind:true } : {})
  }]));
  const productionMetrics = Object.fromEntries(Object.entries(PRODUCTION_METRIC_DEFINITIONS).map(([name, definition]) => [name, {
    value:definition.target,
    evidence_ref:`c013-ac1-${label}-${name}-local-only`
  }]));
  const unsigned = {
    policy_version:PRODUCTION_EVALUATION_POLICY_VERSION,
    package_checksum:pkg.content_version,
    text_index_version:pkg.text_index_version,
    graph_version:pkg.graph_version,
    expires_at:expiresAt,
    evaluation_families:evaluationFamilies,
    production_metrics:productionMetrics,
    local_test_only:true,
    local_test_notice:"Synthetic local-isolated acceptance evidence only. Not production evaluation evidence.",
    local_test_package_id:pkg.id
  };
  const policy = validateProductionEvaluationSubmission(unsigned);
  if (!policy.ok) throw new Error(`Generated report violates the evaluation policy: ${policy.failures.join(",")}`);
  const report = signEvidenceDocument(unsigned, { evidenceKind:"evaluation_report", signerId, privateKey:issuer });
  const verification = verifyEvidenceDocumentAttestation(report, { evidenceKind:"evaluation_report", trustedSigners:registry });
  if (!verification.ok) throw new Error(`Generated signature failed verification: ${verification.failures.join(",")}`);
  return report;
};

const packageA = findPackage(packageAId);
const packageB = findPackage(packageBId);
await mkdir(outputDirectory, { recursive:true, mode:0o700 });
const registryFile = await writeJsonAtomic(resolve(outputDirectory, "trusted-signers.json"), registry);
const environmentFile = resolve(outputDirectory, "trusted-signers.env");
await writeFile(environmentFile, `HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64=${registryBase64}\n`, { encoding:"utf8", mode:0o600 });
const reportA = await writeJsonAtomic(resolve(outputDirectory, "evaluation-package-a.json"), reportFor(packageA, "package-a"));
const reportB = await writeJsonAtomic(resolve(outputDirectory, "evaluation-package-b.json"), reportFor(packageB, "package-b"));

console.log(JSON.stringify({
  local_test_only:true,
  tenant_id:tenantId,
  signer_id:signerId,
  package_a:{ id:packageA.id, report:reportA },
  package_b:{ id:packageB.id, report:reportB },
  trusted_signers:{ env_file:environmentFile, registry:registryFile }
}, null, 2));
