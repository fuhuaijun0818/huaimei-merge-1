import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKUP_MANIFEST_AUTHORITY,
  BACKUP_MANIFEST_KIND,
  BACKUP_MANIFEST_SCHEMA,
  BACKUP_STORAGE_ATTESTATION_AUTHORITY,
  BACKUP_STORAGE_ATTESTATION_KIND,
  BACKUP_STORAGE_ATTESTATION_SCHEMA,
  RESTORE_CRITICAL_TABLES,
  loadBackupManifestForRestore,
  signBackupManifest,
  signBackupStorageAttestation,
  validateBackupManifestStructure,
  validateRestoredSnapshotAgainstManifest,
  verifyBackupManifest,
  verifyBackupStorageAttestation
} from "../scripts/backup-manifest-common.mjs";
import { sha256 } from "../scripts/formal-evidence-common.mjs";
import { runRestoreVerification } from "../scripts/verify-restored-database.mjs";

const counts = Object.fromEntries(RESTORE_CRITICAL_TABLES.map((table) => [table, 0]));
Object.assign(counts, {
  tenants:1,
  conversation_sessions:3,
  conversation_messages:10,
  knowledge_releases:1,
  knowledge_reviews:3,
  audit_events:8
});
const release = {
  tenant_id:"huamei-shanghai",
  release_id:"krel-backup-001",
  index_version:"index-backup-001",
  package_checksum:"a".repeat(64),
  record_list_checksum:"b".repeat(64),
  index_checksum:"c".repeat(64)
};
const anchor = {
  tenant_id:"huamei-shanghai",
  event_id:"audit-anchor-001",
  occurred_at:"2026-08-26T00:08:00.000Z"
};
const backupArtifactBytes = Buffer.from("huamei-encrypted-postgres-backup-fixture-v1\n", "utf8");
const unsignedManifest = {
  schema_version:BACKUP_MANIFEST_SCHEMA,
  backup_id:"backup-2026-08-26-001",
  database_instance_id:"huamei-prod-pg-001",
  backup_started_at:"2026-08-26T00:00:00.000Z",
  restore_point:"2026-08-26T00:09:00.000Z",
  backup_completed_at:"2026-08-26T00:10:00.000Z",
  artifact:{
    object_version_id:"object-version-001",
    sha256:sha256(backupArtifactBytes),
    size_bytes:backupArtifactBytes.length
  },
  critical_table_counts:counts,
  active_knowledge_releases:[release],
  audit_anchors:[anchor]
};
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signerId = "backup-operator-001";
const registry = {
  [signerId]:{
    authority_role:BACKUP_MANIFEST_AUTHORITY,
    allowed_kinds:[BACKUP_MANIFEST_KIND],
    public_key_spki_der_base64:publicKey.export({ format:"der", type:"spki" }).toString("base64")
  }
};
const signedManifest = signBackupManifest(unsignedManifest, {
  signerId,
  privateKey,
  signedAt:"2026-08-26T00:11:00.000Z"
});
const verification = verifyBackupManifest(signedManifest, { trustedSigners:registry });
assert.equal(verification.ok, true, JSON.stringify(verification.failures));
assert.match(verification.signer.public_key_spki_sha256, /^[0-9a-f]{64}$/);

const exactSnapshot = {
  counts:{ ...counts },
  active_knowledge_releases:[release],
  audit_anchors:[anchor]
};
assert.equal(validateRestoredSnapshotAgainstManifest(signedManifest, exactSnapshot).ok, true);

const missingRows = structuredClone(exactSnapshot);
missingRows.counts.conversation_messages -= 1;
const missingRowsResult = validateRestoredSnapshotAgainstManifest(signedManifest, missingRows);
assert.equal(missingRowsResult.ok, false, "恢复库缺一行也必须失败关闭");
assert.ok(missingRowsResult.failures.some((item) => item.code === "RESTORE_TABLE_ROWS_MISSING"));

const emptySnapshot = structuredClone(exactSnapshot);
emptySnapshot.counts = Object.fromEntries(RESTORE_CRITICAL_TABLES.map((table) => [table, 0]));
const emptyResult = validateRestoredSnapshotAgainstManifest(signedManifest, emptySnapshot);
assert.equal(emptyResult.ok, false, "空恢复不得因schema存在而通过");
assert.ok(emptyResult.failures.some((item) => item.code === "RESTORE_EMPTY_DATASET"));

const missingRelease = structuredClone(exactSnapshot);
missingRelease.active_knowledge_releases = [];
assert.ok(validateRestoredSnapshotAgainstManifest(signedManifest, missingRelease).failures
  .some((item) => item.code === "RESTORE_ACTIVE_KNOWLEDGE_RELEASE_MISMATCH"));
const missingAnchor = structuredClone(exactSnapshot);
missingAnchor.audit_anchors = [];
assert.ok(validateRestoredSnapshotAgainstManifest(signedManifest, missingAnchor).failures
  .some((item) => item.code === "RESTORE_AUDIT_ANCHOR_MISSING"));

const tampered = structuredClone(signedManifest);
tampered.critical_table_counts.conversation_messages += 1;
assert.equal(verifyBackupManifest(tampered, { trustedSigners:registry }).ok, false, "签名后修改count必须失败");

const emptyManifest = structuredClone(unsignedManifest);
emptyManifest.critical_table_counts = Object.fromEntries(RESTORE_CRITICAL_TABLES.map((table) => [table, 0]));
assert.ok(validateBackupManifestStructure(emptyManifest).failures.includes("BACKUP_MANIFEST_EMPTY_DATASET"));

const fixtureRoot = await mkdtemp(join(tmpdir(), "huamei-backup-restore-"));
const backupArtifactPath = join(fixtureRoot, "postgres-backup.dump.enc");
const tamperedArtifactPath = join(fixtureRoot, "postgres-backup-tampered.dump.enc");
await writeFile(backupArtifactPath, backupArtifactBytes, { mode:0o600 });
await writeFile(tamperedArtifactPath, Buffer.from("different-backup-object\n", "utf8"), { mode:0o600 });

const manifestBytes = Buffer.from(JSON.stringify(signedManifest));
const baseEnvironment = {
  HUAMEI_RESTORE_BACKUP_MANIFEST_PATH:"/controlled-evidence/backup-manifest.json",
  HUAMEI_RESTORE_BACKUP_MANIFEST_SHA256:sha256(manifestBytes),
  HUAMEI_RESTORE_BACKUP_TRUSTED_SIGNERS_B64:Buffer.from(JSON.stringify(registry)).toString("base64"),
  HUAMEI_RESTORE_ARTIFACT_VERIFICATION_MODE:"local_file",
  HUAMEI_RESTORE_BACKUP_ARTIFACT_PATH:backupArtifactPath,
  HUAMEI_RESTORE_EXPECTED_BACKUP_ID:unsignedManifest.backup_id,
  HUAMEI_RESTORE_REQUIRED_POINT_IN_TIME:"2026-08-26T00:14:00.000Z",
  HUAMEI_RESTORE_MAX_RPO_SECONDS:"900"
};
const loaded = await loadBackupManifestForRestore(baseEnvironment, {
  readFileImpl:async () => manifestBytes
});
assert.equal(loaded.rpo_seconds, 300);
assert.deepEqual(loaded.artifact, {
  mode:"local_file",
  sha256:unsignedManifest.artifact.sha256,
  size_bytes:unsignedManifest.artifact.size_bytes
});

const { privateKey:storagePrivateKey, publicKey:storagePublicKey } = generateKeyPairSync("ed25519");
const storageSignerId = "backup-storage-verifier-001";
const storageRegistry = {
  [storageSignerId]:{
    authority_role:BACKUP_STORAGE_ATTESTATION_AUTHORITY,
    allowed_kinds:[BACKUP_STORAGE_ATTESTATION_KIND],
    public_key_spki_der_base64:storagePublicKey.export({ format:"der", type:"spki" }).toString("base64")
  }
};
const unsignedStorageAttestation = {
  schema_version:BACKUP_STORAGE_ATTESTATION_SCHEMA,
  evidence_kind:BACKUP_STORAGE_ATTESTATION_KIND,
  backup_id:unsignedManifest.backup_id,
  object_version_id:unsignedManifest.artifact.object_version_id,
  sha256:unsignedManifest.artifact.sha256,
  size_bytes:unsignedManifest.artifact.size_bytes,
  observed_at:"2026-08-26T00:12:00.000Z",
  provider:"s3-compatible",
  request_id:"storage-head-request-001",
  object_locator_sha256:"e".repeat(64)
};
const signedStorageAttestation = signBackupStorageAttestation(unsignedStorageAttestation, {
  signerId:storageSignerId,
  privateKey:storagePrivateKey,
  signedAt:"2026-08-26T00:13:00.000Z"
});
assert.equal(verifyBackupStorageAttestation(signedStorageAttestation, { trustedSigners:storageRegistry }).ok, true);
const storageAttestationBytes = Buffer.from(JSON.stringify(signedStorageAttestation));
const storageEnvironment = {
  ...baseEnvironment,
  HUAMEI_RESTORE_ARTIFACT_VERIFICATION_MODE:"signed_storage_attestation",
  HUAMEI_RESTORE_BACKUP_ARTIFACT_PATH:"",
  HUAMEI_RESTORE_BACKUP_ARTIFACT_ATTESTATION_PATH:"/controlled-evidence/backup-storage-attestation.json",
  HUAMEI_RESTORE_BACKUP_ARTIFACT_ATTESTATION_SHA256:sha256(storageAttestationBytes),
  HUAMEI_RESTORE_BACKUP_ARTIFACT_TRUSTED_SIGNERS_B64:Buffer.from(JSON.stringify(storageRegistry)).toString("base64")
};
const storageLoaded = await loadBackupManifestForRestore(storageEnvironment, {
  readFileImpl:async () => manifestBytes,
  artifactReadFileImpl:async () => storageAttestationBytes
});
assert.equal(storageLoaded.artifact.mode, "signed_storage_attestation");
assert.equal(storageLoaded.artifact.object_version_id, unsignedManifest.artifact.object_version_id);
assert.equal(storageLoaded.artifact.signer.signer_id, storageSignerId);

const wrongVersionAttestation = signBackupStorageAttestation({
  ...unsignedStorageAttestation,
  object_version_id:"object-version-wrong"
}, {
  signerId:storageSignerId,
  privateKey:storagePrivateKey,
  signedAt:"2026-08-26T00:13:00.000Z"
});
const wrongVersionBytes = Buffer.from(JSON.stringify(wrongVersionAttestation));
await assert.rejects(
  loadBackupManifestForRestore({
    ...storageEnvironment,
    HUAMEI_RESTORE_BACKUP_ARTIFACT_ATTESTATION_SHA256:sha256(wrongVersionBytes)
  }, {
    readFileImpl:async () => manifestBytes,
    artifactReadFileImpl:async () => wrongVersionBytes
  }),
  (error) => error.code === "RESTORE_BACKUP_ARTIFACT_ATTESTATION_OBJECT_VERSION_MISMATCH"
);

const sameSignerStorageAttestation = signBackupStorageAttestation(unsignedStorageAttestation, {
  signerId,
  privateKey,
  signedAt:"2026-08-26T00:13:00.000Z"
});
const sameSignerStorageRegistry = {
  [signerId]:{
    authority_role:BACKUP_STORAGE_ATTESTATION_AUTHORITY,
    allowed_kinds:[BACKUP_STORAGE_ATTESTATION_KIND],
    public_key_spki_der_base64:publicKey.export({ format:"der", type:"spki" }).toString("base64")
  }
};
const sameSignerStorageBytes = Buffer.from(JSON.stringify(sameSignerStorageAttestation));
await assert.rejects(
  loadBackupManifestForRestore({
    ...storageEnvironment,
    HUAMEI_RESTORE_BACKUP_ARTIFACT_ATTESTATION_SHA256:sha256(sameSignerStorageBytes),
    HUAMEI_RESTORE_BACKUP_ARTIFACT_TRUSTED_SIGNERS_B64:Buffer.from(JSON.stringify(sameSignerStorageRegistry)).toString("base64")
  }, {
    readFileImpl:async () => manifestBytes,
    artifactReadFileImpl:async () => sameSignerStorageBytes
  }),
  (error) => error.code === "RESTORE_BACKUP_ARTIFACT_ATTESTATION_SIGNER_NOT_INDEPENDENT"
);

await assert.rejects(
  loadBackupManifestForRestore({
    ...baseEnvironment,
    HUAMEI_RESTORE_BACKUP_ARTIFACT_ATTESTATION_PATH:"/must-not-be-present.json"
  }, { readFileImpl:async () => manifestBytes }),
  (error) => error.code === "RESTORE_ARTIFACT_VERIFICATION_MODES_CONFLICT"
);
await assert.rejects(
  loadBackupManifestForRestore({}, { readFileImpl:async () => manifestBytes }),
  (error) => error.code === "RESTORE_BACKUP_MANIFEST_ABSOLUTE_PATH_REQUIRED",
  "无外置manifest必须在连接恢复库前失败"
);
await assert.rejects(
  loadBackupManifestForRestore({
    ...baseEnvironment,
    HUAMEI_RESTORE_REQUIRED_POINT_IN_TIME:"2026-08-26T00:30:00.000Z"
  }, { readFileImpl:async () => manifestBytes }),
  (error) => error.code === "RESTORE_RPO_EXCEEDED",
  "恢复点超过批准RPO必须失败"
);

const restoreEnvironment = {
  ...baseEnvironment,
  HUAMEI_RESTORE_EXPECTED_DATABASE:"huamei_restore_drill",
  HUAMEI_RESTORE_DRILL_CONFIRM_ISOLATED:"true"
};
const createRestoreDatabase = () => ({
  transaction:async (callback) => callback({
    query:async (sql) => {
      const statement = String(sql);
      if (statement.startsWith("SELECT current_database")) {
        return { rows:[{ database_name:"huamei_restore_drill", current_user:"huamei_owner", session_user:"huamei_migrator" }] };
      }
      if (statement.startsWith("SET LOCAL ROLE")) return { rows:[] };
      if (statement.includes("FROM schema_migrations")) return { rows:[] };
      if (statement.includes("FROM pg_class")) {
        return { rows:RESTORE_CRITICAL_TABLES.map((relname) => ({ relname, relrowsecurity:true, relforcerowsecurity:true })) };
      }
      if (statement.includes("FROM pg_trigger")) return { rows:[{ total:2 }] };
      if (statement.includes("AS orphan_messages")) {
        return { rows:[{ orphan_messages:0, orphan_consents:0, orphan_handovers:0, orphan_reviews:0, invalid_active_releases:0 }] };
      }
      if (statement.includes("count(*)::bigint FROM tenants")) {
        return { rows:[Object.fromEntries(Object.entries(counts).map(([table, value]) => [table, String(value)]))] };
      }
      if (statement.includes("FROM knowledge_releases") && statement.includes("WHERE is_active")) return { rows:[release] };
      if (statement.includes("JOIN unnest")) return { rows:[anchor] };
      throw new Error(`Unexpected restore verifier query: ${statement.slice(0, 120)}`);
    }
  })
});
const restoreEvidence = await runRestoreVerification({
  env:restoreEnvironment,
  database:createRestoreDatabase(),
  migrationInventory:[],
  readFileImpl:async () => manifestBytes,
  now:new Date("2026-08-26T00:20:00.000Z")
});
assert.equal(restoreEvidence.status, "passed", JSON.stringify(restoreEvidence.failures));
assert.equal(restoreEvidence.schema_version, "huamei.restore-verification.v2");
assert.equal(restoreEvidence.backup_manifest.backup_id, unsignedManifest.backup_id);
assert.equal(restoreEvidence.backup_manifest.rpo_seconds, 300);
assert.equal(restoreEvidence.backup_manifest.artifact_verification.sha256, unsignedManifest.artifact.sha256);

let databaseQueries = 0;
await assert.rejects(
  runRestoreVerification({
    env:{
      HUAMEI_RESTORE_EXPECTED_DATABASE:"huamei_restore_drill",
      HUAMEI_RESTORE_DRILL_CONFIRM_ISOLATED:"true"
    },
    database:{
      transaction:async () => { databaseQueries += 1; }
    },
    readFileImpl:async () => manifestBytes
  }),
  (error) => error.code === "RESTORE_BACKUP_MANIFEST_ABSOLUTE_PATH_REQUIRED"
);
assert.equal(databaseQueries, 0, "manifest缺失时不得查询恢复库");

databaseQueries = 0;
await assert.rejects(
  runRestoreVerification({
    env:{
      ...restoreEnvironment,
      HUAMEI_RESTORE_BACKUP_ARTIFACT_PATH:tamperedArtifactPath
    },
    database:{
      transaction:async () => { databaseQueries += 1; }
    },
    readFileImpl:async () => manifestBytes
  }),
  (error) => error.code === "RESTORE_BACKUP_ARTIFACT_SHA256_MISMATCH",
  "即使恢复库行数和锚点相同，备份对象不匹配也必须先失败"
);
assert.equal(databaseQueries, 0, "备份对象校验失败时不得查询恢复库");

const wrongSizeManifest = signBackupManifest({
  ...unsignedManifest,
  artifact:{ ...unsignedManifest.artifact, size_bytes:unsignedManifest.artifact.size_bytes + 1 }
}, {
  signerId,
  privateKey,
  signedAt:"2026-08-26T00:11:00.000Z"
});
const wrongSizeManifestBytes = Buffer.from(JSON.stringify(wrongSizeManifest));
await assert.rejects(
  loadBackupManifestForRestore({
    ...baseEnvironment,
    HUAMEI_RESTORE_BACKUP_MANIFEST_SHA256:sha256(wrongSizeManifestBytes)
  }, { readFileImpl:async () => wrongSizeManifestBytes }),
  (error) => error.code === "RESTORE_BACKUP_ARTIFACT_SIZE_MISMATCH"
);

await rm(fixtureRoot, { recursive:true, force:true });

console.log("✓ 外置Ed25519签名备份manifest、backup ID、恢复点和RPO门禁通过");
console.log("✓ 本地备份文件或独立存储证明与manifest精确绑定，错对象在首次数据库查询前失败关闭");
console.log("✓ 空恢复、关键表缺行、active release或audit anchor缺失均失败关闭");
