import { isAbsolute } from "node:path";

import {
  evidenceError,
  mainModule,
  parseCliOptions,
  readJsonWithSha,
  writeJsonAtomic
} from "./formal-evidence-common.mjs";
import { signBackupManifestFromEnv } from "./backup-manifest-common.mjs";

export async function runBackupManifestSigner(options = {}) {
  const input = String(options.input || "").trim();
  const expectedSha = String(options["input-sha256"] || "").trim();
  const output = String(options.output || "").trim();
  if (!isAbsolute(output)) throw evidenceError("BACKUP_MANIFEST_SIGNED_OUTPUT_ABSOLUTE_PATH_REQUIRED");
  if (input === output) throw evidenceError("BACKUP_MANIFEST_SIGNER_WILL_NOT_OVERWRITE_INPUT");
  const source = await readJsonWithSha({ path:input, expectedSha, label:"BACKUP_MANIFEST_UNSIGNED_INPUT" });
  const signed = await signBackupManifestFromEnv(source.document, options.env || process.env);
  const written = await writeJsonAtomic(output, signed);
  return { status:"signed", backup_id:signed.backup_id, signer_id:signed.execution_attestation.signer_id, input_sha256:source.sha256, output:written };
}

if (mainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runBackupManifestSigner(parseCliOptions()), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status:"blocked", code:error.code || "BACKUP_MANIFEST_SIGNING_FAILED", details:error.details || null }));
    process.exitCode = 1;
  }
}
