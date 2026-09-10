import { isAbsolute } from "node:path";

import {
  FORMAL_EVIDENCE_AUTHORITY_BY_KIND,
  evidenceError,
  mainModule,
  parseCliOptions,
  readJsonWithSha,
  signEvidenceDocumentFromEnv,
  writeJsonAtomic
} from "./formal-evidence-common.mjs";

export async function runFormalEvidenceSigner(options = {}) {
  const env = options.env || process.env;
  const kind = String(options.kind || "").trim();
  if (!FORMAL_EVIDENCE_AUTHORITY_BY_KIND[kind]) throw evidenceError("FORMAL_EVIDENCE_KIND_INVALID");
  const input = String(options.input || "").trim();
  const expectedSha = String(options["input-sha256"] || "").trim();
  const output = String(options.output || "").trim();
  if (!isAbsolute(output)) throw evidenceError("FORMAL_EVIDENCE_SIGNED_OUTPUT_ABSOLUTE_PATH_REQUIRED");
  if (input === output) throw evidenceError("FORMAL_EVIDENCE_SIGNER_WILL_NOT_OVERWRITE_INPUT");
  const evidence = await readJsonWithSha({ path:input, expectedSha, label:"FORMAL_EVIDENCE_UNSIGNED_INPUT" });
  const signed = await signEvidenceDocumentFromEnv(evidence.document, {
    env,
    prefix:"HUAMEI_FORMAL_EVIDENCE",
    evidenceKind:kind
  });
  const written = await writeJsonAtomic(output, signed);
  return { status:"signed", kind, signer_id:signed.execution_attestation.signer_id, input_sha256:evidence.sha256, output:written };
}

if (mainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runFormalEvidenceSigner(parseCliOptions()), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status:"blocked", code:error.code || "FORMAL_EVIDENCE_SIGNING_FAILED", details:error.details || null }));
    process.exitCode = 1;
  }
}
