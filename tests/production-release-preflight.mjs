import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";

import {
  FORMAL_EVIDENCE_AUTHORITY_BY_KIND,
  signEvidenceDocument,
  verifyEvidenceDocumentAttestation
} from "../scripts/formal-evidence-common.mjs";

import {
  loadMigrationInventory,
  loadFormalReleaseEvidence,
  parseReleaseTenants,
  runProductionReleasePreflight,
  tenantTables,
  validateActiveKnowledgeRelease,
  validateApplicationReadyBinding,
  validateDatabaseRoleTopology,
  validateFormalReleaseEvidence,
  validateFormalSourceEvidence,
  validateGraphRagReadyBinding,
  validateMigrationInventory,
  validateReleaseConfiguration,
  validateRuntimeObjectAclEvidence,
  validateRuntimeSecurityEvidence
} from "../scripts/production-release-preflight.mjs";
import {
  LEGACY_FIELD_ENVELOPE_FIELDS,
  summarizeLegacyFieldEnvelopeInventory
} from "../scripts/migrate-field-envelopes-v2.mjs";
import {
  CAPACITY_ATTESTATION_SCHEMA,
  PROMETHEUS_CAPACITY_EXPORT_SCHEMA,
  RAW_CAPACITY_SCHEMA,
  buildProductionCapacityEvidence
} from "../scripts/formal-capacity-evidence.mjs";
import {
  FORMAL_EVALUATION_ENDPOINT_REGISTRY_SCHEMA,
  resolveFormalEvaluationEndpointTarget
} from "../scripts/formal-production-evaluation.mjs";
import {
  POSTGRES_APPROVED_SECURITY_DEFINER_FUNCTIONS,
  POSTGRES_RUNTIME_CALLABLE_FUNCTIONS,
  postgresRuntimeTablePrivilegeMap
} from "../server/platform/postgres-object-acl-policy.mjs";

const digest = (character) => character.repeat(64);
const image = (name, character) => `registry.huamei.invalid/${name}@sha256:${digest(character)}`;
const fieldKey = Buffer.from(Array.from({ length:32 }, (_, index) => index + 1)).toString("base64");
const contactVaultKey = Buffer.from(Array.from({ length:32 }, (_, index) => 255 - index)).toString("base64");
const generatedSecret = (offset) => `key_${Buffer.from(Array.from({ length:32 }, (_, index) => (index + offset) % 256)).toString("base64url")}`;
const formalIndexVersion = "index-2026-08-26.1";
const formalManifestChecksum = digest("c");
const formalTaxonomyManifestSha = digest("7");
const formalTaxonomySignedPayloadSha = digest("9");
const formalTaxonomyCatalogSha = digest("b");
const formalTaxonomyEntryIdsSha = digest("a");
const evaluationEndpointRegistryPath = "/release-control/formal-evaluation-endpoints.json";
const evaluationEndpointRegistry = {
  schema_version:FORMAL_EVALUATION_ENDPOINT_REGISTRY_SCHEMA,
  registry_id:"formal-evaluation-endpoints-2026-08-26",
  generated_at:"2026-08-26T01:00:00.000Z",
  approval:{
    status:"approved",
    approval_id:"endpoint-registry-approval-001",
    approved_by:"release-platform-owner-001",
    approved_at:"2026-08-26T01:05:00.000Z"
  },
  endpoints:[{
    entry_id:"huamei-preproduction-acquisition-001",
    active:true,
    tenant_id:"huamei-shanghai",
    environment:"preproduction",
    origin:"https://preprod.huamei.example.com",
    deployment_id:"huamei-preprod-deployment-2026-08-26-001",
    release_id:"2026.08.26-r1",
    knowledge_release_id:"krel_2026_08_26",
    application_image:image("app", "a"),
    graphrag_image:image("graphrag", "b"),
    index_version:formalIndexVersion,
    knowledge_manifest_sha256:formalManifestChecksum,
    service:"huamei-acquisition-agent",
    service_version:"2.1.0"
  }]
};
const evaluationEndpointRegistryBytes = Buffer.from(JSON.stringify(evaluationEndpointRegistry));
const evaluationEndpointRegistrySha = createHash("sha256").update(evaluationEndpointRegistryBytes).digest("hex");
const evidenceSignerIds = {
  blind_dataset:"quality-custodian-001",
  evaluation_raw:"qa-execution-001",
  evaluation_scorecard:"review-board-001",
  evaluation_report:"evaluation-issuer-001",
  capacity_raw:"load-runner-001",
  capacity_observability_attestation:"sre-observability-001",
  capacity_report:"capacity-issuer-001"
};
const evidencePrivateKeys = {};
const evidenceTrustedSigners = {};
for (const [kind, signerId] of Object.entries(evidenceSignerIds)) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  evidencePrivateKeys[kind] = privateKey;
  evidenceTrustedSigners[signerId] = {
    authority_role:FORMAL_EVIDENCE_AUTHORITY_BY_KIND[kind],
    allowed_kinds:[kind],
    public_key_spki_der_base64:publicKey.export({ format:"der", type:"spki" }).toString("base64")
  };
}
const signedEvidence = (kind, document) => signEvidenceDocument(document, {
  evidenceKind:kind,
  signerId:evidenceSignerIds[kind],
  privateKey:evidencePrivateKeys[kind],
  signedAt:"2026-08-26T03:00:00.000Z"
});
const sourceEvidence = (kind, document) => {
  const signed = signedEvidence(kind, document);
  const verification = verifyEvidenceDocumentAttestation(signed, {
    evidenceKind:kind,
    trustedSigners:evidenceTrustedSigners
  });
  assert.equal(verification.ok, true, `${kind}测试证据必须可验签`);
  return { document:signed, summary:verification.signer };
};
const evidenceBytes = (document) => Buffer.from(JSON.stringify(document));
const evidenceSha = (document) => createHash("sha256").update(evidenceBytes(document)).digest("hex");
const baseEnvironment = {
  HUAMEI_RELEASE_ID:"2026.08.26-r1",
  HUAMEI_EVIDENCE_ENVIRONMENT:"preproduction",
  HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID:"krel_2026_08_26",
  HUAMEI_APP_IMAGE:image("app", "a"),
  HUAMEI_GRAPHRAG_IMAGE:image("graphrag", "b"),
  HUAMEI_POSTGRES_IMAGE:image("postgres", "c"),
  HUAMEI_REDIS_IMAGE:image("redis", "d"),
  HUAMEI_CADDY_IMAGE:image("caddy", "e"),
  HUAMEI_RELEASE_TENANT_IDS:"huamei-shanghai",
  HUAMEI_CANARY_TOKEN:"canary-token-not-printed-1234567890123456",
  LITELLM_LOCAL_MODEL_COST_MAP:"True",
  HUAMEI_OUTBOX_DELIVERY_ENABLED:"false",
  HUAMEI_LLM_ENABLED:"true",
  HUAMEI_LLM_PROVIDER:"aliyun_model_studio",
  HUAMEI_LLM_BASE_URL:"https://llm-gateway.huamei.invalid/v1",
  HUAMEI_LLM_API_KEY:generatedSecret(11),
  HUAMEI_LLM_MODEL:"qwen-plus-production",
  GRAPHRAG_MODEL_PROVIDER:"openai_compatible",
  GRAPHRAG_API_BASE:"https://graph-model.huamei.invalid/v1",
  GRAPHRAG_API_KEY:generatedSecret(71),
  HUAMEI_GRAPHRAG_SERVICE_KEY:generatedSecret(72),
  GRAPHRAG_COMPLETION_MODEL:"qwen-plus-production",
  GRAPHRAG_EMBEDDING_MODEL:"text-embedding-production",
  HUAMEI_GRAPHRAG_INDEX_VERSION:formalIndexVersion,
  HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256:formalManifestChecksum,
  HUAMEI_LLM_DATA_EGRESS_APPROVED:"true",
  HUAMEI_LLM_DATA_EGRESS_APPROVAL_ID:"egress-approval-2026-08-26",
  HUAMEI_APPROVED_MODEL_EGRESS_HOSTS:"llm-gateway.huamei.invalid,graph-model.huamei.invalid",
  HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON:JSON.stringify({ active_key_id:"phase1-v1", keys:{ "phase1-v1":fieldKey } }),
  HUAMEI_CONTACT_VAULT_KEYRING_JSON:JSON.stringify({ active_key_id:"contact-v1", keys:{ "contact-v1":contactVaultKey } }),
  HUAMEI_PRIVACY_VERIFICATION_SECRET:generatedSecret(92),
  HUAMEI_PRIVACY_COMPLETION_SECRET:generatedSecret(93),
  HUAMEI_PRIVACY_CANCELLATION_SECRET:generatedSecret(97),
  HUAMEI_ACQUISITION_METRICS_TOKEN:generatedSecret(94),
  HUAMEI_OUTBOX_METRICS_TOKEN:generatedSecret(95),
  HUAMEI_CONVERSATION_RECOVERY_METRICS_TOKEN:generatedSecret(96),
  HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_PATH:evaluationEndpointRegistryPath,
  HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_SHA256:evaluationEndpointRegistrySha,
  HUAMEI_FORMAL_EVALUATION_EXPECTED_ORIGIN:"https://preprod.huamei.example.com",
  HUAMEI_RELEASE_EVALUATION_REPORT_PATH:"/release-evidence/evaluation.json",
  HUAMEI_RELEASE_EVALUATION_REPORT_SHA256:digest("f"),
  HUAMEI_RELEASE_CAPACITY_REPORT_PATH:"/release-evidence/capacity.json",
  HUAMEI_RELEASE_CAPACITY_REPORT_SHA256:digest("0"),
  HUAMEI_FORMAL_BLIND_DATASET_PATH:"/release-evidence/blind-dataset.json",
  HUAMEI_FORMAL_BLIND_DATASET_SHA256:digest("1"),
  HUAMEI_FORMAL_EVALUATION_RAW_PATH:"/release-evidence/evaluation-raw.json",
  HUAMEI_FORMAL_EVALUATION_RAW_SHA256:digest("2"),
  HUAMEI_FORMAL_EVALUATION_SCORECARD_PATH:"/release-evidence/evaluation-scorecard.json",
  HUAMEI_FORMAL_EVALUATION_SCORECARD_SHA256:digest("3"),
  HUAMEI_FORMAL_CAPACITY_RAW_PATH:"/release-evidence/capacity-raw.json",
  HUAMEI_FORMAL_CAPACITY_RAW_SHA256:digest("4"),
  HUAMEI_FORMAL_CAPACITY_PROMETHEUS_PATH:"/release-evidence/capacity-prometheus.json",
  HUAMEI_FORMAL_CAPACITY_PROMETHEUS_SHA256:digest("6"),
  HUAMEI_FORMAL_CAPACITY_ATTESTATION_PATH:"/release-evidence/capacity-attestation.json",
  HUAMEI_FORMAL_CAPACITY_ATTESTATION_SHA256:digest("5"),
  HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256:formalTaxonomyManifestSha,
  HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64:Buffer.from(JSON.stringify(evidenceTrustedSigners)).toString("base64")
};
const evaluationTarget = resolveFormalEvaluationEndpointTarget(evaluationEndpointRegistry, {
  registrySha256:evaluationEndpointRegistrySha,
  binding:{
    releaseId:baseEnvironment.HUAMEI_RELEASE_ID,
    knowledgeReleaseId:baseEnvironment.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID,
    indexVersion:baseEnvironment.HUAMEI_GRAPHRAG_INDEX_VERSION,
    knowledgeManifestSha256:baseEnvironment.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256,
    applicationImage:baseEnvironment.HUAMEI_APP_IMAGE,
    graphRagImage:baseEnvironment.HUAMEI_GRAPHRAG_IMAGE,
    llmProvider:baseEnvironment.HUAMEI_LLM_PROVIDER,
    llmModel:baseEnvironment.HUAMEI_LLM_MODEL,
    environment:"preproduction",
    tenantId:"huamei-shanghai"
  }
});

assert.deepEqual(parseReleaseTenants(baseEnvironment), ["huamei-shanghai"]);
assert.equal(validateReleaseConfiguration(baseEnvironment).ok, true);
assert.ok(validateReleaseConfiguration({ ...baseEnvironment, HUAMEI_EVIDENCE_ENVIRONMENT:"" }).failures.includes("FORMAL_EVIDENCE_ENVIRONMENT_REQUIRED"));
assert.equal(validateReleaseConfiguration({ ...baseEnvironment, HUAMEI_APP_IMAGE:"registry/app:latest" }).ok, false);
assert.ok(validateReleaseConfiguration({ ...baseEnvironment, HUAMEI_LLM_ENABLED:"false" }).failures.includes("PRODUCTION_LLM_MUST_BE_ENABLED"));
assert.ok(validateReleaseConfiguration({ ...baseEnvironment, HUAMEI_LLM_BASE_URL:"http://model.internal/v1" }).failures.includes("PRODUCTION_LLM_HTTPS_ENDPOINT_REQUIRED"));
assert.ok(validateReleaseConfiguration({ ...baseEnvironment, HUAMEI_LLM_API_KEY:baseEnvironment.GRAPHRAG_API_KEY }).failures.includes("PRODUCTION_SECRET_REUSE_FORBIDDEN"));
assert.ok(validateReleaseConfiguration({ ...baseEnvironment, HUAMEI_GRAPHRAG_SERVICE_KEY:"weak" }).failures.includes("GRAPHRAG_SERVICE_KEY_REQUIRED"));
assert.ok(validateReleaseConfiguration({ ...baseEnvironment, HUAMEI_ACQUISITION_METRICS_TOKEN:"weak" }).failures.includes("ACQUISITION_METRICS_TOKEN_REQUIRED"));
assert.ok(validateReleaseConfiguration({ ...baseEnvironment, HUAMEI_CONVERSATION_RECOVERY_METRICS_TOKEN:"weak" }).failures.includes("CONVERSATION_RECOVERY_METRICS_TOKEN_REQUIRED"));
assert.ok(validateReleaseConfiguration({
  ...baseEnvironment,
  HUAMEI_OUTBOX_METRICS_TOKEN:baseEnvironment.HUAMEI_ACQUISITION_METRICS_TOKEN
}).failures.includes("PRODUCTION_SECRET_REUSE_FORBIDDEN"));
assert.ok(validateReleaseConfiguration({
  ...baseEnvironment,
  HUAMEI_CONVERSATION_RECOVERY_METRICS_TOKEN:baseEnvironment.HUAMEI_OUTBOX_METRICS_TOKEN
}).failures.includes("PRODUCTION_SECRET_REUSE_FORBIDDEN"));
assert.ok(validateReleaseConfiguration({
  ...baseEnvironment,
  HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_PATH:"relative/endpoints.json"
}).failures.includes("FORMAL_EVALUATION_ENDPOINT_REGISTRY_ABSOLUTE_PATH_REQUIRED"));
assert.ok(validateReleaseConfiguration({
  ...baseEnvironment,
  HUAMEI_OUTBOX_DELIVERY_ENABLED:"true",
  HUAMEI_OUTBOX_TARGET_URL:"http://receiver.internal/events",
  HUAMEI_OUTBOX_TARGET_SERVICE_KEY:"short"
}).failures.includes("OUTBOX_HTTPS_TARGET_REQUIRED"));

const evidenceCommon = {
  release_id:baseEnvironment.HUAMEI_RELEASE_ID,
  knowledge_release_id:baseEnvironment.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID,
  environment:"preproduction",
  generated_at:"2026-08-26T04:00:00.000Z",
  tenant_id:"huamei-shanghai",
  application_image:baseEnvironment.HUAMEI_APP_IMAGE,
  graphrag_image:baseEnvironment.HUAMEI_GRAPHRAG_IMAGE,
  index_version:baseEnvironment.HUAMEI_GRAPHRAG_INDEX_VERSION,
  knowledge_manifest_sha256:baseEnvironment.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256,
  passed:true,
  llm:{ enabled:true, provider:baseEnvironment.HUAMEI_LLM_PROVIDER, model:baseEnvironment.HUAMEI_LLM_MODEL },
  active_knowledge:{
    release_id:baseEnvironment.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID,
    index_version:baseEnvironment.HUAMEI_GRAPHRAG_INDEX_VERSION,
    manifest_sha256:baseEnvironment.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256,
    engine:"official_graphrag_3_1_1"
  },
  approval:{
    status:"approved",
    approval_id:"go-live-approval-2026-08-26",
    approved_by:"release-owner-001",
    approved_at:"2026-08-26T05:00:00.000Z"
  }
};
const blindDatasetSource = sourceEvidence("blind_dataset", {
  schema_version:"huamei.production-blind-evaluation-set.v1",
  evidence_class:"independent_blind_holdout",
  formal_acceptance_eligible:true,
  dataset_id:"blind-holdout-2026-08-26-a",
  provenance:{
    classification:"independent_blind_holdout",
    development_used:false,
    sealed:true,
    sealed_at:"2026-08-25T08:00:00.000Z",
    custodian_id:"quality-custodian-001",
    approval_id:"blind-set-approval-001"
  },
  cases:[]
});
const blindDatasetSha = evidenceSha(blindDatasetSource.document);
const evaluationRawSource = sourceEvidence("evaluation_raw", {
  schema_version:"huamei.production-evaluation-raw.v1",
  generated_at:"2026-08-26T02:00:00.000Z",
  dataset_id:blindDatasetSource.document.dataset_id,
  dataset_sha256:blindDatasetSha,
  release_id:evidenceCommon.release_id,
  knowledge_release_id:evidenceCommon.knowledge_release_id,
  environment:evidenceCommon.environment,
  tenant_id:evidenceCommon.tenant_id,
  application_image:evidenceCommon.application_image,
  graphrag_image:evidenceCommon.graphrag_image,
  index_version:evidenceCommon.index_version,
  knowledge_manifest_sha256:evidenceCommon.knowledge_manifest_sha256,
  llm:evidenceCommon.llm,
  evaluation_target:evaluationTarget,
  cases:[]
});
const evaluationRawSha = evidenceSha(evaluationRawSource.document);
const evaluationScorecardSource = sourceEvidence("evaluation_scorecard", {
  schema_version:"huamei.production-evaluation-scorecard.v1",
  generated_at:"2026-08-26T03:00:00.000Z",
  dataset_sha256:blindDatasetSha,
  raw_report_sha256:evaluationRawSha,
  release_id:evidenceCommon.release_id,
  knowledge_release_id:evidenceCommon.knowledge_release_id,
  index_version:evidenceCommon.index_version,
  knowledge_manifest_sha256:evidenceCommon.knowledge_manifest_sha256,
  role_approvals:{},
  approval:evidenceCommon.approval
});
const evaluationScorecardSha = evidenceSha(evaluationScorecardSource.document);
const capacityBinding = {
  releaseId:evidenceCommon.release_id,
  knowledgeReleaseId:evidenceCommon.knowledge_release_id,
  environment:evidenceCommon.environment,
  tenantId:evidenceCommon.tenant_id,
  applicationImage:evidenceCommon.application_image,
  graphRagImage:evidenceCommon.graphrag_image,
  indexVersion:evidenceCommon.index_version,
  knowledgeManifestSha256:evidenceCommon.knowledge_manifest_sha256,
  llmProvider:baseEnvironment.HUAMEI_LLM_PROVIDER,
  llmModel:baseEnvironment.HUAMEI_LLM_MODEL,
  graphRagModelProvider:baseEnvironment.GRAPHRAG_MODEL_PROVIDER,
  graphRagModel:baseEnvironment.GRAPHRAG_COMPLETION_MODEL
};
const capacityRawSource = sourceEvidence("capacity_raw", {
  schema_version:RAW_CAPACITY_SCHEMA,
  evidence_class:"sustained_ai_main_path",
  formal_acceptance_eligible:true,
  test_id:"soak-production-001",
  started_at:"2026-08-26T00:00:00.000Z",
  finished_at:"2026-08-26T00:32:00.000Z",
  target:"acquisition-agent",
  base_url:"https://preprod.huamei.invalid",
  tenant_id:evidenceCommon.tenant_id,
  binding:{
    release_id:capacityBinding.releaseId,
    knowledge_release_id:capacityBinding.knowledgeReleaseId,
    environment:capacityBinding.environment,
    application_image:capacityBinding.applicationImage,
    graphrag_image:capacityBinding.graphRagImage,
    index_version:capacityBinding.indexVersion,
    knowledge_manifest_sha256:capacityBinding.knowledgeManifestSha256,
    llm_provider:capacityBinding.llmProvider,
    llm_model:capacityBinding.llmModel,
    graphrag_model_provider:capacityBinding.graphRagModelProvider,
    graphrag_model:capacityBinding.graphRagModel
  },
  load_identity:{
    mode:"per_virtual_user_callers",
    caller_count:20,
    caller_ids_sha256:digest("8"),
    approved_rate_limit_per_minute:null,
    rate_limit_approval_id:null
  },
  virtual_users:20,
  ramp_seconds:120,
  requested_duration_seconds:1920,
  actual_duration_seconds:1920,
  steady_state_duration_seconds:1800,
  requests:2500,
  success:2500,
  status_counts:{ "200":2500 },
  error_rate:0,
  throughput_rps:1.3,
  latency_ms:{ min:1000, mean:1000, p50:1000, p95:1000, p99:1000, max:1000 },
  latency_samples_ms:Array.from({ length:2500 }, () => 1000),
  turn_latency_p95_ms:{ "0":1000, "1":1000, "2":1000, "3":1000, "4":1000 },
  minute_buckets:Object.fromEntries(Array.from({ length:32 }, (_, index) => [String(index), { "200":index < 4 ? 79 : 78 }])),
  dependency_usage:{
    live_model:{ required_requests:2500, successful_requests:2500, fallback_or_skip_requests:0, observed_success_ratio:1 },
    graphrag:{
      required_requests:2500,
      successful_requests:2500,
      fallback_or_skip_requests:0,
      observed_success_ratio:1,
      engine:"official_graphrag_3_1_1",
      expected_cache_miss_count:2500
    }
  },
  query_diversity:{
    query_hashes:Array.from({ length:2500 }, (_, index) => createHash("sha256").update(`preflight-query-${index}`).digest("hex")),
    request_count:2500,
    distinct_query_count:2500,
    unique_ratio:1,
    query_hash_source:"graphrag_response_sanitized_query_sha256"
  },
  formal_load_taxonomy:{
    required:true,
    manifest_id:"formal-load-taxonomy-2026-08-26-a",
    manifest_sha256:formalTaxonomyManifestSha,
    signer_id:"taxonomy-approver-001",
    signed_payload_sha256:formalTaxonomySignedPayloadSha,
    catalog_sha256:formalTaxonomyCatalogSha,
    algorithm_version:"factoradic-token-permutation.v1",
    requests_checked:2500,
    applied_responses:2500,
    application_ratio:1,
    distinct_entry_count:2500,
    entry_ids_sha256:formalTaxonomyEntryIdsSha
  },
  contract_checks:{ responses_checked:2500, valid_responses:2500, failure_counts:{}, canary_isolation_passed:true },
  user_summaries:Array.from({ length:20 }, (_, index) => ({
    user_index:index,
    conversation_canary_sha256:createHash("sha256").update(`preflight-user-${index}`).digest("hex"),
    started_at:"2026-08-26T00:00:00.000Z",
    finished_at:"2026-08-26T00:32:00.000Z",
    turns:125,
    valid_turns:125,
    llm_successes:125,
    graphrag_successes:125
  })),
  acceptance:{
    max_error_rate:0.005,
    max_p95_ms:10000,
    minimum_requests:2500,
    minimum_dependency_attempt_coverage:0.95,
    minimum_dependency_success_rate:0.99,
    minimum_query_diversity_ratio:0.95,
    formal_candidate:true,
    passed:true
  }
});
const capacityRawSha = evidenceSha(capacityRawSource.document);
const capacityPrometheusSource = {
  schema_version:PROMETHEUS_CAPACITY_EXPORT_SCHEMA,
  evidence_class:"raw_prometheus_capacity_export",
  export_id:"prometheus-export-001",
  test_id:capacityRawSource.document.test_id,
  release_id:capacityBinding.releaseId,
  knowledge_release_id:capacityBinding.knowledgeReleaseId,
  environment:capacityBinding.environment,
  tenant_id:capacityBinding.tenantId,
  application_image:capacityBinding.applicationImage,
  graphrag_image:capacityBinding.graphRagImage,
  index_version:capacityBinding.indexVersion,
  knowledge_manifest_sha256:capacityBinding.knowledgeManifestSha256,
  llm_provider:capacityBinding.llmProvider,
  llm_model:capacityBinding.llmModel,
  graphrag_model_provider:capacityBinding.graphRagModelProvider,
  graphrag_model:capacityBinding.graphRagModel,
  window_started_at:"2026-08-26T00:00:00.000Z",
  window_finished_at:"2026-08-26T00:32:00.000Z",
  query_references:{
    concurrency:"prom-query-concurrency-001",
    business_requests:"prom-query-business-001",
    live_model:"prom-query-live-model-001",
    graphrag:"prom-query-graphrag-001",
    graphrag_cache:"prom-query-cache-001",
    graphrag_query_model:"prom-query-graphrag-model-001",
    graphrag_query_hashes:"prom-query-graphrag-hashes-001",
    formal_load_taxonomy:"prom-query-formal-taxonomy-001"
  },
  formal_load_taxonomy:{
    query_reference:"prom-query-formal-taxonomy-001",
    manifest_id:"formal-load-taxonomy-2026-08-26-a",
    manifest_sha256:formalTaxonomyManifestSha,
    signer_id:"taxonomy-approver-001",
    signed_payload_sha256:formalTaxonomySignedPayloadSha,
    catalog_sha256:formalTaxonomyCatalogSha,
    algorithm_version:"factoradic-token-permutation.v1"
  },
  sanitized_query_hash_counts:Object.fromEntries(
    capacityRawSource.document.query_diversity.query_hashes.map((queryHash) => [queryHash, 1])
  ),
  samples:Array.from({ length:65 }, (_, index) => ({
    timestamp:new Date(Date.parse("2026-08-26T00:00:00.000Z") + index * 30_000).toISOString(),
    active_virtual_users:index < 4 ? index * 5 : 20,
    business_requests_total:Math.floor(2500 * index / 64),
    live_model_attempts_total:Math.floor(2500 * index / 64),
    live_model_success_total:Math.floor(2500 * index / 64),
    live_model_tokens_total:Math.floor(6400000 * index / 64),
    graphrag_attempts_total:Math.floor(2500 * index / 64),
    graphrag_success_total:Math.floor(2500 * index / 64),
    graphrag_cache_misses_total:Math.floor(2500 * index / 64),
    graphrag_model_attempts_total:Math.floor(2500 * index / 64),
    graphrag_model_success_total:Math.floor(2500 * index / 64),
    graphrag_model_tokens_total:Math.floor(3200000 * index / 64),
    formal_load_taxonomy_applied_total:Math.floor(2500 * index / 64),
    formal_load_taxonomy_rejected_total:0
  }))
};
const capacityPrometheusSha = evidenceSha(capacityPrometheusSource);
const capacityAttestationSource = sourceEvidence("capacity_observability_attestation", {
  schema_version:CAPACITY_ATTESTATION_SCHEMA,
  evidence_class:"independent_production_telemetry",
  generated_at:"2026-08-26T03:30:00.000Z",
  raw_report_sha256:capacityRawSha,
  prometheus_export_sha256:capacityPrometheusSha,
  release_id:evidenceCommon.release_id,
  knowledge_release_id:evidenceCommon.knowledge_release_id,
  environment:evidenceCommon.environment,
  tenant_id:evidenceCommon.tenant_id,
  application_image:evidenceCommon.application_image,
  graphrag_image:evidenceCommon.graphrag_image,
  index_version:evidenceCommon.index_version,
  knowledge_manifest_sha256:evidenceCommon.knowledge_manifest_sha256,
  llm_provider:capacityBinding.llmProvider,
  llm_model:capacityBinding.llmModel,
  graphrag_model_provider:capacityBinding.graphRagModelProvider,
  graphrag_model:capacityBinding.graphRagModel,
  telemetry:{
    source:"prometheus",
    export_id:capacityPrometheusSource.export_id,
    export_sha256:capacityPrometheusSha,
    test_id:capacityRawSource.document.test_id,
    window_started_at:capacityPrometheusSource.window_started_at,
    window_finished_at:capacityPrometheusSource.window_finished_at,
    concurrency:{
      query_reference:"prom-query-concurrency-001",
      minimum_active_users:20,
      concurrent_window_seconds:1800,
      sample_count:65,
      maximum_sample_gap_seconds:30
    },
    live_model:{
      query_reference:"prom-query-live-model-001",
      provider:capacityBinding.llmProvider,
      model:capacityBinding.llmModel,
      attempt_count:2500,
      success_count:2500,
      success_rate:1,
      token_count:6400000,
      peak_requests_per_minute:80,
      peak_tokens_per_minute:200000
    },
    graphrag:{
      query_reference:"prom-query-graphrag-001",
      cache_query_reference:"prom-query-cache-001",
      engine:"official_graphrag_3_1_1",
      knowledge_release_id:capacityBinding.knowledgeReleaseId,
      index_version:capacityBinding.indexVersion,
      knowledge_manifest_sha256:capacityBinding.knowledgeManifestSha256,
      attempt_count:2500,
      success_count:2500,
      success_rate:1,
      cache_miss_count:2500,
      cache_miss_ratio:1
    },
    graphrag_query_model:{
      query_reference:"prom-query-graphrag-model-001",
      provider:capacityBinding.graphRagModelProvider,
      model:capacityBinding.graphRagModel,
      attempt_count:2500,
      success_count:2500,
      attempt_coverage:1,
      success_rate:1,
      token_count:3200000,
      peak_requests_per_minute:80,
      peak_tokens_per_minute:100000
    },
    formal_load_taxonomy:{
      query_reference:"prom-query-formal-taxonomy-001",
      manifest_id:"formal-load-taxonomy-2026-08-26-a",
      manifest_sha256:formalTaxonomyManifestSha,
      signer_id:"taxonomy-approver-001",
      signed_payload_sha256:formalTaxonomySignedPayloadSha,
      catalog_sha256:formalTaxonomyCatalogSha,
      algorithm_version:"factoradic-token-permutation.v1",
      applied:2500,
      rejected:0,
      application_ratio:1
    }
  },
  provider_quota:{
    approved:true,
    provider:capacityBinding.llmProvider,
    model:capacityBinding.llmModel,
    requests_per_minute:2000,
    tokens_per_minute:2000000,
    approval_id:"app-model-quota-001",
    approved_by:"app-model-owner-001",
    approved_at:"2026-08-25T03:00:00.000Z",
    valid_from:"2026-08-25T00:00:00.000Z",
    valid_until:"2026-08-27T00:00:00.000Z"
  },
  graphrag_provider_quota:{
    approved:true,
    provider:capacityBinding.graphRagModelProvider,
    model:capacityBinding.graphRagModel,
    requests_per_minute:2000,
    tokens_per_minute:2000000,
    approval_id:"graph-model-quota-001",
    approved_by:"graph-model-owner-001",
    approved_at:"2026-08-25T03:00:00.000Z",
    valid_from:"2026-08-25T00:00:00.000Z",
    valid_until:"2026-08-27T00:00:00.000Z"
  },
  approval:{
    status:"approved",
    approval_id:"capacity-release-001",
    approved_by:"capacity-release-owner-001",
    approved_at:"2026-08-26T03:30:00.000Z"
  }
});
const capacityAttestationSha = evidenceSha(capacityAttestationSource.document);
const sourceDocuments = {
  blind_dataset:blindDatasetSource.document,
  evaluation_raw:evaluationRawSource.document,
  evaluation_scorecard:evaluationScorecardSource.document,
  capacity_raw:capacityRawSource.document,
  capacity_prometheus:capacityPrometheusSource,
  capacity_observability_attestation:capacityAttestationSource.document
};
const sourceDigests = {
  blind_dataset:blindDatasetSha,
  evaluation_raw:evaluationRawSha,
  evaluation_scorecard:evaluationScorecardSha,
  capacity_raw:capacityRawSha,
  capacity_prometheus:capacityPrometheusSha,
  capacity_observability_attestation:capacityAttestationSha
};
const evaluationEvidence = signedEvidence("evaluation_report", {
  ...evidenceCommon,
  schema_version:"huamei.production-evaluation-evidence.v3",
  dataset_id:blindDatasetSource.document.dataset_id,
  dataset_sha256:blindDatasetSha,
  raw_report_sha256:evaluationRawSha,
  scorecard_sha256:evaluationScorecardSha,
  case_count:3240,
  evaluation_target:evaluationTarget,
  verified_sources:{
    blind_dataset:blindDatasetSource.summary,
    evaluation_raw:evaluationRawSource.summary,
    evaluation_scorecard:evaluationScorecardSource.summary
  },
  acceptance:{ passed:true }
});
const capacityEvidenceUnsigned = buildProductionCapacityEvidence({
  rawReport:capacityRawSource.document,
  rawReportPath:baseEnvironment.HUAMEI_FORMAL_CAPACITY_RAW_PATH,
  rawReportSha256:capacityRawSha,
  prometheusExport:capacityPrometheusSource,
  prometheusExportPath:baseEnvironment.HUAMEI_FORMAL_CAPACITY_PROMETHEUS_PATH,
  prometheusExportSha256:capacityPrometheusSha,
  attestation:capacityAttestationSource.document,
  attestationSha256:capacityAttestationSha,
  binding:capacityBinding,
  generatedAt:evidenceCommon.generated_at,
  sourceVerifications:{
    capacity_raw:{ ok:true, signer:capacityRawSource.summary },
    capacity_observability_attestation:{ ok:true, signer:capacityAttestationSource.summary }
  }
});
assert.equal(capacityEvidenceUnsigned.passed, true, JSON.stringify(capacityEvidenceUnsigned.acceptance.failures));
const capacityEvidence = signedEvidence("capacity_report", capacityEvidenceUnsigned);
assert.equal(validateFormalReleaseEvidence({ evaluation:evaluationEvidence, capacity:capacityEvidence, env:baseEnvironment }).ok, true);
assert.ok(validateFormalReleaseEvidence({
  evaluation:evaluationEvidence,
  capacity:{ ...capacityEvidence, duration_seconds:60, llm:{ ...capacityEvidence.llm, enabled:false } },
  env:baseEnvironment
}).failures.includes("CAPACITY_SOAK_DURATION_NOT_PROVEN"));
assert.ok(validateFormalReleaseEvidence({
  evaluation:{ ...evaluationEvidence, index_version:"stale-index" },
  capacity:capacityEvidence,
  env:baseEnvironment
}).failures.includes("EVALUATION_EVIDENCE_INDEX_VERSION_MISMATCH"));
assert.equal(validateFormalSourceEvidence({
  evaluation:evaluationEvidence,
  capacity:capacityEvidence,
  sources:sourceDocuments,
  sourceDigests,
  evaluationTarget,
  env:baseEnvironment
}).ok, true);
const wrongOriginSourceValidation = validateFormalSourceEvidence({
  evaluation:evaluationEvidence,
  capacity:capacityEvidence,
  sources:{
    ...sourceDocuments,
    evaluation_raw:{
      ...sourceDocuments.evaluation_raw,
      evaluation_target:{ ...evaluationTarget, origin:"https://wrong.huamei.example.com" }
    }
  },
  sourceDigests,
  evaluationTarget,
  env:baseEnvironment
});
assert.equal(wrongOriginSourceValidation.ok, false, "raw评测origin偏离受信registry必须阻断预检");
assert.ok(wrongOriginSourceValidation.failures.includes("PREFLIGHT_RAW_EVALUATION_TARGET_ORIGIN_TRUST_MISMATCH"));
const wrongDeploymentFinalValidation = validateFormalSourceEvidence({
  evaluation:{
    ...evaluationEvidence,
    evaluation_target:{ ...evaluationTarget, deployment_id:"wrong-deployment-001" }
  },
  capacity:capacityEvidence,
  sources:sourceDocuments,
  sourceDigests,
  evaluationTarget,
  env:baseEnvironment
});
assert.equal(wrongDeploymentFinalValidation.ok, false, "最终报告部署身份偏离受信registry必须阻断预检");
assert.ok(wrongDeploymentFinalValidation.failures.includes("PREFLIGHT_FINAL_EVALUATION_TARGET_DEPLOYMENT_ID_TRUST_MISMATCH"));

// Distinct signer aliases are not independent when they resolve to the same
// Ed25519 public key. Rebuild a fully valid source chain with evaluation_raw
// signed by the blind-dataset key under a different trusted alias.
const unsigned = (document) => {
  const copy = structuredClone(document);
  delete copy.execution_attestation;
  return copy;
};
const degradedCapacityRaw = signedEvidence("capacity_raw", {
  ...unsigned(capacityRawSource.document),
  dependency_usage:{
    ...capacityRawSource.document.dependency_usage,
    live_model:{
      ...capacityRawSource.document.dependency_usage.live_model,
      successful_requests:2400,
      fallback_or_skip_requests:100,
      observed_success_ratio:0.96
    }
  }
});
const degradedCapacityRawSha = evidenceSha(degradedCapacityRaw);
const degradedRawVerification = verifyEvidenceDocumentAttestation(degradedCapacityRaw, {
  evidenceKind:"capacity_raw",
  trustedSigners:evidenceTrustedSigners
});
const degradedCapacityAttestation = signedEvidence("capacity_observability_attestation", {
  ...unsigned(capacityAttestationSource.document),
  raw_report_sha256:degradedCapacityRawSha
});
const degradedCapacityAttestationSha = evidenceSha(degradedCapacityAttestation);
const degradedAttestationVerification = verifyEvidenceDocumentAttestation(degradedCapacityAttestation, {
  evidenceKind:"capacity_observability_attestation",
  trustedSigners:evidenceTrustedSigners
});
const deceptiveCapacityReport = signedEvidence("capacity_report", {
  ...unsigned(capacityEvidence),
  raw_report_sha256:degradedCapacityRawSha,
  attestation_sha256:degradedCapacityAttestationSha,
  verified_sources:{
    capacity_raw:degradedRawVerification.signer,
    capacity_observability_attestation:degradedAttestationVerification.signer
  }
});
const revalidatedDegradedCapacity = validateFormalSourceEvidence({
  evaluation:evaluationEvidence,
  capacity:deceptiveCapacityReport,
  sources:{
    ...sourceDocuments,
    capacity_raw:degradedCapacityRaw,
    capacity_observability_attestation:degradedCapacityAttestation
  },
  sourceDigests:{
    ...sourceDigests,
    capacity_raw:degradedCapacityRawSha,
    capacity_observability_attestation:degradedCapacityAttestationSha
  },
  evaluationTarget,
  env:baseEnvironment
});
assert.equal(revalidatedDegradedCapacity.ok, false, "最终报告即使有效签名，预检也必须重算raw而非信任摘要");
assert.ok(revalidatedDegradedCapacity.failures.includes(
  "PREFLIGHT_CAPACITY_RAW_LIVE_MODEL_SUCCESS_RATE_INSUFFICIENT"
));
const aliasedQaSignerId = "qa-execution-alias-001";
const aliasedTrustedSigners = {
  ...evidenceTrustedSigners,
  [aliasedQaSignerId]:{
    authority_role:FORMAL_EVIDENCE_AUTHORITY_BY_KIND.evaluation_raw,
    allowed_kinds:["evaluation_raw"],
    public_key_spki_der_base64:evidenceTrustedSigners[evidenceSignerIds.blind_dataset].public_key_spki_der_base64
  }
};
const signAs = (kind, signerId, privateKey, document) => signEvidenceDocument(unsigned(document), {
  evidenceKind:kind,
  signerId,
  privateKey,
  signedAt:"2026-08-26T03:00:00.000Z"
});
const aliasedEvaluationRaw = signAs(
  "evaluation_raw",
  aliasedQaSignerId,
  evidencePrivateKeys.blind_dataset,
  evaluationRawSource.document
);
const aliasedEvaluationRawSha = evidenceSha(aliasedEvaluationRaw);
const aliasedEvaluationRawVerification = verifyEvidenceDocumentAttestation(aliasedEvaluationRaw, {
  evidenceKind:"evaluation_raw",
  trustedSigners:aliasedTrustedSigners
});
assert.equal(aliasedEvaluationRawVerification.ok, true);
assert.equal(
  aliasedEvaluationRawVerification.signer.public_key_spki_sha256,
  blindDatasetSource.summary.public_key_spki_sha256,
  "同一公钥的不同alias必须产生同一SPKI指纹"
);
const aliasedScorecard = signedEvidence("evaluation_scorecard", {
  ...unsigned(evaluationScorecardSource.document),
  raw_report_sha256:aliasedEvaluationRawSha
});
const aliasedScorecardSha = evidenceSha(aliasedScorecard);
const aliasedScorecardVerification = verifyEvidenceDocumentAttestation(aliasedScorecard, {
  evidenceKind:"evaluation_scorecard",
  trustedSigners:aliasedTrustedSigners
});
const aliasedEvaluationReport = signedEvidence("evaluation_report", {
  ...unsigned(evaluationEvidence),
  raw_report_sha256:aliasedEvaluationRawSha,
  scorecard_sha256:aliasedScorecardSha,
  verified_sources:{
    blind_dataset:blindDatasetSource.summary,
    evaluation_raw:aliasedEvaluationRawVerification.signer,
    evaluation_scorecard:aliasedScorecardVerification.signer
  }
});
const aliasedSources = {
  ...sourceDocuments,
  evaluation_raw:aliasedEvaluationRaw,
  evaluation_scorecard:aliasedScorecard
};
const aliasedSourceDigests = {
  ...sourceDigests,
  evaluation_raw:aliasedEvaluationRawSha,
  evaluation_scorecard:aliasedScorecardSha
};
const aliasedEnvironment = {
  ...baseEnvironment,
  HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64:Buffer.from(JSON.stringify(aliasedTrustedSigners)).toString("base64")
};
const aliasedFinalValidation = validateFormalReleaseEvidence({
  evaluation:aliasedEvaluationReport,
  capacity:capacityEvidence,
  env:aliasedEnvironment
});
assert.equal(aliasedFinalValidation.ok, false, "同一key使用多个signer alias时最终报告必须失败关闭");
assert.ok(aliasedFinalValidation.failures.includes("FORMAL_EVIDENCE_SIGNING_KEYS_NOT_GLOBALLY_INDEPENDENT"));
const aliasedSourceValidation = validateFormalSourceEvidence({
  evaluation:aliasedEvaluationReport,
  capacity:capacityEvidence,
  sources:aliasedSources,
  sourceDigests:aliasedSourceDigests,
  evaluationTarget,
  env:aliasedEnvironment
});
assert.equal(aliasedSourceValidation.ok, false, "真实源文件验签也必须识别同key多alias");
assert.ok(aliasedSourceValidation.failures.includes("FORMAL_EVIDENCE_SIGNING_KEYS_NOT_GLOBALLY_INDEPENDENT"));
const evidenceFiles = new Map([
  [baseEnvironment.HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_PATH, evaluationEndpointRegistryBytes],
  [baseEnvironment.HUAMEI_RELEASE_EVALUATION_REPORT_PATH, evidenceBytes(evaluationEvidence)],
  [baseEnvironment.HUAMEI_RELEASE_CAPACITY_REPORT_PATH, evidenceBytes(capacityEvidence)],
  [baseEnvironment.HUAMEI_FORMAL_BLIND_DATASET_PATH, evidenceBytes(sourceDocuments.blind_dataset)],
  [baseEnvironment.HUAMEI_FORMAL_EVALUATION_RAW_PATH, evidenceBytes(sourceDocuments.evaluation_raw)],
  [baseEnvironment.HUAMEI_FORMAL_EVALUATION_SCORECARD_PATH, evidenceBytes(sourceDocuments.evaluation_scorecard)],
  [baseEnvironment.HUAMEI_FORMAL_CAPACITY_RAW_PATH, evidenceBytes(sourceDocuments.capacity_raw)],
  [baseEnvironment.HUAMEI_FORMAL_CAPACITY_PROMETHEUS_PATH, evidenceBytes(sourceDocuments.capacity_prometheus)],
  [baseEnvironment.HUAMEI_FORMAL_CAPACITY_ATTESTATION_PATH, evidenceBytes(sourceDocuments.capacity_observability_attestation)]
]);
const evidenceEnvironment = {
  ...baseEnvironment,
  HUAMEI_RELEASE_EVALUATION_REPORT_SHA256:evidenceSha(evaluationEvidence),
  HUAMEI_RELEASE_CAPACITY_REPORT_SHA256:evidenceSha(capacityEvidence),
  HUAMEI_FORMAL_BLIND_DATASET_SHA256:blindDatasetSha,
  HUAMEI_FORMAL_EVALUATION_RAW_SHA256:evaluationRawSha,
  HUAMEI_FORMAL_EVALUATION_SCORECARD_SHA256:evaluationScorecardSha,
  HUAMEI_FORMAL_CAPACITY_RAW_SHA256:capacityRawSha,
  HUAMEI_FORMAL_CAPACITY_PROMETHEUS_SHA256:capacityPrometheusSha,
  HUAMEI_FORMAL_CAPACITY_ATTESTATION_SHA256:capacityAttestationSha
};
assert.equal((await loadFormalReleaseEvidence(evidenceEnvironment, {
  readFileImpl:async (path) => evidenceFiles.get(path)
})).ok, true);
const wrongExpectedOriginLoad = await loadFormalReleaseEvidence({
  ...evidenceEnvironment,
  HUAMEI_FORMAL_EVALUATION_EXPECTED_ORIGIN:"https://wrong.huamei.example.com"
}, { readFileImpl:async (path) => evidenceFiles.get(path) });
assert.equal(wrongExpectedOriginLoad.ok, false, "普通环境地址与受信registry不符不得改变评测目标");
assert.ok(wrongExpectedOriginLoad.failures.includes("FORMAL_EVALUATION_ENDPOINT_REGISTRY_INVALID"));
const privateEndpointRegistry = structuredClone(evaluationEndpointRegistry);
privateEndpointRegistry.endpoints[0].origin = "https://127.0.0.1";
const privateEndpointRegistryBytes = Buffer.from(JSON.stringify(privateEndpointRegistry));
const privateEndpointRegistrySha = createHash("sha256").update(privateEndpointRegistryBytes).digest("hex");
const privateEndpointFiles = new Map(evidenceFiles);
privateEndpointFiles.set(baseEnvironment.HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_PATH, privateEndpointRegistryBytes);
const privateEndpointLoad = await loadFormalReleaseEvidence({
  ...evidenceEnvironment,
  HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_SHA256:privateEndpointRegistrySha
}, { readFileImpl:async (path) => privateEndpointFiles.get(path) });
assert.equal(privateEndpointLoad.ok, false, "私网endpoint注册表必须在发布预检失败关闭");
assert.ok(privateEndpointLoad.failures.includes("FORMAL_EVALUATION_ENDPOINT_REGISTRY_INVALID"));
assert.equal((await loadFormalReleaseEvidence({ ...evidenceEnvironment, HUAMEI_RELEASE_CAPACITY_REPORT_SHA256:digest("9") }, {
  readFileImpl:async (path) => evidenceFiles.get(path)
})).ok, false);
const tamperedPrometheusLoad = await loadFormalReleaseEvidence({
  ...evidenceEnvironment,
  HUAMEI_FORMAL_CAPACITY_PROMETHEUS_SHA256:digest("9")
}, { readFileImpl:async (path) => evidenceFiles.get(path) });
assert.equal(tamperedPrometheusLoad.ok, false, "Prometheus原始导出SHA错配必须在发布预检阻断");
assert.ok(tamperedPrometheusLoad.failures.includes("CAPACITY_PROMETHEUS_CHECKSUM_MISMATCH"));

const issuerOnlyRegistry = Object.fromEntries([
  "evaluation-issuer-001",
  "capacity-issuer-001"
].map((signerId) => [signerId, evidenceTrustedSigners[signerId]]));
const issuerOnlyResult = await loadFormalReleaseEvidence({
  ...evidenceEnvironment,
  HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64:Buffer.from(JSON.stringify(issuerOnlyRegistry)).toString("base64")
}, { readFileImpl:async (path) => evidenceFiles.get(path) });
assert.equal(issuerOnlyResult.ok, false, "注册表只有两个最终issuer时不得信任来源摘要");
assert.ok(issuerOnlyResult.failures.some((code) => code.includes("SIGNER_UNTRUSTED")));

const fabricatedSummary = (kind, signerId, authorityRole) => ({
  signer_id:signerId,
  evidence_kind:kind,
  authority_role:authorityRole,
  signed_payload_sha256:digest("9"),
  signed_at:"2026-08-26T03:00:00.000Z"
});
const fabricatedEvaluation = signedEvidence("evaluation_report", {
  ...evaluationEvidence,
  verified_sources:{
    blind_dataset:fabricatedSummary("blind_dataset", "fabricated-quality-001", "quality_custodian"),
    evaluation_raw:fabricatedSummary("evaluation_raw", "fabricated-qa-001", "qa_execution"),
    evaluation_scorecard:fabricatedSummary("evaluation_scorecard", "fabricated-board-001", "review_board")
  }
});
const fabricatedCapacity = signedEvidence("capacity_report", {
  ...capacityEvidence,
  verified_sources:{
    capacity_raw:fabricatedSummary("capacity_raw", "fabricated-load-001", "load_runner"),
    capacity_observability_attestation:fabricatedSummary(
      "capacity_observability_attestation",
      "fabricated-sre-001",
      "sre_observability"
    )
  }
});
const fabricatedFinalFiles = new Map([
  [baseEnvironment.HUAMEI_RELEASE_EVALUATION_REPORT_PATH, evidenceBytes(fabricatedEvaluation)],
  [baseEnvironment.HUAMEI_RELEASE_CAPACITY_REPORT_PATH, evidenceBytes(fabricatedCapacity)]
]);
const fabricatedWithoutSources = await loadFormalReleaseEvidence({
  ...evidenceEnvironment,
  HUAMEI_RELEASE_EVALUATION_REPORT_SHA256:evidenceSha(fabricatedEvaluation),
  HUAMEI_RELEASE_CAPACITY_REPORT_SHA256:evidenceSha(fabricatedCapacity),
  HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64:Buffer.from(JSON.stringify(issuerOnlyRegistry)).toString("base64")
}, {
  readFileImpl:async (path) => {
    if (!fabricatedFinalFiles.has(path)) throw new Error("source evidence intentionally absent");
    return fabricatedFinalFiles.get(path);
  }
});
assert.equal(fabricatedWithoutSources.ok, false, "虚构5个来源signer但不提供真实源文件必须失败");
assert.ok(fabricatedWithoutSources.failures.includes("BLIND_DATASET_UNREADABLE"));

const summaryMismatchEvaluation = signedEvidence("evaluation_report", {
  ...evaluationEvidence,
  verified_sources:{
    ...evaluationEvidence.verified_sources,
    blind_dataset:{ ...evaluationEvidence.verified_sources.blind_dataset, signed_at:"2026-08-26T03:05:00.000Z" }
  }
});
const summaryMismatchFiles = new Map(evidenceFiles);
summaryMismatchFiles.set(baseEnvironment.HUAMEI_RELEASE_EVALUATION_REPORT_PATH, evidenceBytes(summaryMismatchEvaluation));
const summaryMismatchResult = await loadFormalReleaseEvidence({
  ...evidenceEnvironment,
  HUAMEI_RELEASE_EVALUATION_REPORT_SHA256:evidenceSha(summaryMismatchEvaluation)
}, { readFileImpl:async (path) => summaryMismatchFiles.get(path) });
assert.equal(summaryMismatchResult.ok, false, "最终报告来源摘要必须与真实源文件验签结果逐字段一致");
assert.ok(summaryMismatchResult.failures.includes("BLIND_DATASET_FINAL_REPORT_SUMMARY_SIGNED_AT_MISMATCH"));

const fingerprintMismatchEvaluation = signedEvidence("evaluation_report", {
  ...evaluationEvidence,
  verified_sources:{
    ...evaluationEvidence.verified_sources,
    blind_dataset:{ ...evaluationEvidence.verified_sources.blind_dataset, public_key_spki_sha256:digest("8") }
  }
});
const fingerprintMismatchFiles = new Map(evidenceFiles);
fingerprintMismatchFiles.set(baseEnvironment.HUAMEI_RELEASE_EVALUATION_REPORT_PATH, evidenceBytes(fingerprintMismatchEvaluation));
const fingerprintMismatchResult = await loadFormalReleaseEvidence({
  ...evidenceEnvironment,
  HUAMEI_RELEASE_EVALUATION_REPORT_SHA256:evidenceSha(fingerprintMismatchEvaluation)
}, { readFileImpl:async (path) => fingerprintMismatchFiles.get(path) });
assert.equal(fingerprintMismatchResult.ok, false, "最终报告必须逐字段绑定真实来源公钥指纹");
assert.ok(fingerprintMismatchResult.failures.includes("BLIND_DATASET_FINAL_REPORT_SUMMARY_PUBLIC_KEY_SPKI_SHA256_MISMATCH"));

const expectedMigrations = [
  { name:"001_initial_schema.sql", checksum:digest("1") },
  { name:"002_governance.sql", checksum:digest("2") }
];
assert.equal(validateMigrationInventory(expectedMigrations, expectedMigrations).ok, true);
const migrationMismatch = validateMigrationInventory(expectedMigrations, [
  expectedMigrations[0],
  { name:"002_governance.sql", checksum:digest("3") },
  { name:"999_unknown.sql", checksum:digest("9") }
]);
assert.deepEqual(migrationMismatch.mismatched, ["002_governance.sql"]);
assert.deepEqual(migrationMismatch.unexpected, ["999_unknown.sql"]);

const cleanEnvelopeInventoryRows = LEGACY_FIELD_ENVELOPE_FIELDS.map((field) => ({
  field,
  legacy_v1_count:"0"
}));
assert.equal(summarizeLegacyFieldEnvelopeInventory(cleanEnvelopeInventoryRows).ok, true);
assert.equal(summarizeLegacyFieldEnvelopeInventory([
  ...cleanEnvelopeInventoryRows.slice(0, -1),
  { ...cleanEnvelopeInventoryRows.at(-1), legacy_v1_count:"1" }
]).ok, false, "任意一个已保护字段残留v1信封都必须阻断灰度");
assert.equal(summarizeLegacyFieldEnvelopeInventory(cleanEnvelopeInventoryRows.slice(1)).ok, false,
  "owner盘点缺少任意字段时必须fail-closed");

const identity = {
  current_user:"huamei_runtime",
  session_user:"huamei_runtime",
  rolcanlogin:true,
  rolsuper:false,
  rolcreaterole:false,
  rolcreatedb:false,
  rolinherit:false,
  rolreplication:false,
  rolbypassrls:false
};
const rlsRows = tenantTables.map((relname) => ({ relname, relrowsecurity:true, relforcerowsecurity:true }));
const privilegeEvidence = {
  schema_create:false,
  database_create:false,
  knowledge_release_insert:false,
  knowledge_release_update:false,
  knowledge_release_delete:false,
  knowledge_review_insert:false,
  knowledge_review_update:false,
  knowledge_review_delete:false,
  audit_update:false,
  audit_delete:false
};
const expectedRuntimeTablePrivileges = postgresRuntimeTablePrivilegeMap();
const relationAclRows = ["schema_migrations", ...tenantTables].map((relname) => ({
  relname,
  runtime_privileges:[...(expectedRuntimeTablePrivileges.get(relname) || new Set())].sort(),
  migrator_privileges:[],
  public_privileges:[]
}));
const sequenceAclRows = [{
  relname:"runtime_sequence_probe",
  runtime_privileges:["SELECT", "USAGE"],
  migrator_privileges:[],
  public_privileges:[]
}];
const functionAclRows = [
  ...POSTGRES_RUNTIME_CALLABLE_FUNCTIONS.map((identity) => ({
    identity,
    security_definer:POSTGRES_APPROVED_SECURITY_DEFINER_FUNCTIONS.includes(identity),
    approved_security_definer:POSTGRES_APPROVED_SECURITY_DEFINER_FUNCTIONS.includes(identity),
    runtime_callable:true,
    runtime_execute:true,
    migrator_execute:false,
    public_execute:false
  })),
  {
    identity:"public.huamei_set_updated_at()",
    security_definer:false,
    approved_security_definer:false,
    runtime_callable:false,
    runtime_execute:false,
    migrator_execute:false,
    public_execute:false
  }
];
assert.equal(validateRuntimeSecurityEvidence({
  identity,
  rlsRows,
  privilegeEvidence,
  ownerRows:[{ relname:"tenants", owner:"huamei_owner" }],
  relationAclRows,
  sequenceAclRows,
  functionAclRows
}).ok, true);
assert.equal(validateRuntimeSecurityEvidence({
  identity,
  rlsRows:rlsRows.slice(1),
  privilegeEvidence:{ ...privilegeEvidence, schema_create:true },
  ownerRows:[],
  relationAclRows:relationAclRows.map((row) => row.relname === "conversation_messages"
    ? { ...row, runtime_privileges:[...row.runtime_privileges, "TRUNCATE"] }
    : row),
  sequenceAclRows,
  functionAclRows
}).ok, false);
assert.equal(validateRuntimeObjectAclEvidence({
  relationAclRows:relationAclRows.filter((row) => row.relname !== "conversation_messages"),
  sequenceAclRows,
  functionAclRows
}).ok, false, "缺少任一业务表ACL证据必须fail-closed");
assert.equal(validateRuntimeObjectAclEvidence({
  relationAclRows,
  sequenceAclRows,
  functionAclRows:[...functionAclRows, {
    identity:"public.legacy_unapproved_security_definer()",
    security_definer:true,
    approved_security_definer:false,
    runtime_callable:false,
    runtime_execute:true,
    migrator_execute:false,
    public_execute:true
  }]
}).ok, false, "任意命名的未审核SECURITY DEFINER或函数EXECUTE必须阻断发布");

const databaseRoleRows = [
  {
    rolname:"huamei_owner",
    rolcanlogin:false,
    rolsuper:false,
    rolcreaterole:false,
    rolcreatedb:false,
    rolinherit:false,
    rolreplication:false,
    rolbypassrls:true
  },
  {
    rolname:"huamei_migrator",
    rolcanlogin:true,
    rolsuper:false,
    rolcreaterole:false,
    rolcreatedb:false,
    rolinherit:false,
    rolreplication:false,
    rolbypassrls:false
  },
  {
    rolname:"huamei_runtime",
    rolcanlogin:true,
    rolsuper:false,
    rolcreaterole:false,
    rolcreatedb:false,
    rolinherit:false,
    rolreplication:false,
    rolbypassrls:false
  }
];
const databaseMembershipRows = [{
  role_name:"huamei_owner",
  member_name:"huamei_migrator",
  admin_option:false,
  inherit_option:false,
  set_option:true
}];
assert.equal(validateDatabaseRoleTopology({
  roleRows:databaseRoleRows,
  membershipRows:databaseMembershipRows
}).ok, true);
assert.equal(validateDatabaseRoleTopology({
  roleRows:databaseRoleRows.map((row) => row.rolname === "huamei_owner" ? { ...row, rolcanlogin:true } : row),
  membershipRows:databaseMembershipRows
}).ok, false, "owner可登录必须阻断发布");
assert.equal(validateDatabaseRoleTopology({
  roleRows:databaseRoleRows,
  membershipRows:[...databaseMembershipRows, { role_name:"huamei_migrator", member_name:"huamei_runtime" }]
}).ok, false, "runtime成为任何角色成员必须阻断发布");
assert.equal(validateDatabaseRoleTopology({
  roleRows:databaseRoleRows,
  membershipRows:[{ role_name:"huamei_owner", member_name:"huamei_runtime" }]
}).ok, false, "只允许owner<-migrator这一条成员边");
assert.equal(validateDatabaseRoleTopology({
  roleRows:databaseRoleRows,
  membershipRows:[{ ...databaseMembershipRows[0], admin_option:true }]
}).ok, false, "历史ADMIN OPTION授权必须阻断发布");

const tenantId = "huamei-shanghai";
const releaseId = baseEnvironment.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID;
const packageVersion = "huamei-v1";
const packageChecksum = digest("a");
const recordListChecksum = digest("b");
const manifestChecksum = formalManifestChecksum;
const indexVersion = formalIndexVersion;
const scopeChecksum = createHash("sha256").update([
  tenantId,
  releaseId,
  packageVersion,
  packageChecksum,
  recordListChecksum,
  indexVersion
].join("\n")).digest("hex");
const reviews = [
  { id:"review-business", review_type:"business", reviewer_id:"reviewer-business", decision:"approved", evidence:{ scope_checksum:scopeChecksum } },
  { id:"review-medical", review_type:"medical", reviewer_id:"reviewer-medical", decision:"approved", evidence:{ scope_checksum:scopeChecksum } },
  { id:"review-compliance", review_type:"compliance", reviewer_id:"reviewer-compliance", decision:"approved", evidence:{ scope_checksum:scopeChecksum } }
];
const release = {
  release_id:releaseId,
  package_version:packageVersion,
  status:"active",
  is_active:true,
  package_checksum:packageChecksum,
  record_list_checksum:recordListChecksum,
  index_checksum:manifestChecksum,
  index_version:indexVersion,
  effective_at:"2026-08-25T00:00:00.000Z",
  expires_at:null,
  manifest:{
    schema_version:"huamei.graphrag.index-manifest.v1",
    manifest_sha256:manifestChecksum,
    index_version:indexVersion,
    release_binding:{
      tenant_id:tenantId,
      release_id:releaseId,
      index_version:indexVersion,
      knowledge_package_sha256:packageChecksum,
      approved_record_list_sha256:recordListChecksum,
      approval_receipt_sha256:digest("d"),
      approvals:Object.fromEntries(reviews.map((review) => [review.review_type, {
        status:"approved",
        review_id:review.id,
        reviewed_at:"2026-08-25T00:00:00.000Z"
      }]))
    }
  }
};
const active = validateActiveKnowledgeRelease(tenantId, [release], reviews, new Date("2026-08-26T00:00:00.000Z"));
assert.equal(active.ok, true, active.failures.join(","));
assert.equal(validateGraphRagReadyBinding(active.binding, {
  ready:true,
  engine:"official_graphrag_3_1_1",
  tenant_id:tenantId,
  release_id:releaseId,
  index_version:indexVersion,
  manifest_sha256:manifestChecksum
}).ok, true);
assert.equal(validateGraphRagReadyBinding(active.binding, {
  ready:true,
  engine:"official_graphrag_3_1_1",
  tenant_id:tenantId,
  release_id:"wrong-release",
  index_version:indexVersion,
  manifest_sha256:manifestChecksum
}).ok, false);

const appliedMigrations = await loadMigrationInventory();
const ownerRows = ["schema_migrations", ...tenantTables].map((relname) => ({ relname, owner:"huamei_owner" }));
const controlDatabase = {
  transaction:async (operation) => operation({
    query:async (sql) => {
      if (sql.includes("SET LOCAL ROLE")) return { rows:[] };
      if (sql.includes("current_user")) return { rows:[{ current_user:"huamei_owner", session_user:"huamei_migrator" }] };
      if (sql.includes("FROM pg_roles")) return { rows:databaseRoleRows };
      if (sql.includes("FROM pg_auth_members")) return { rows:databaseMembershipRows };
      if (sql.includes("schema_migrations")) return { rows:appliedMigrations };
      if (sql.includes("pg_get_userbyid")) return { rows:ownerRows };
      if (sql.includes("field_encryption_v2_cutover")) return { rows:cleanEnvelopeInventoryRows };
      return { rows:[] };
    }
  })
};
const runtimeDatabase = {
  query:async (sql) => {
    if (sql.includes("acldefault('r'")) return { rows:relationAclRows };
    if (sql.includes("acldefault('S'")) return { rows:sequenceAclRows };
    if (sql.includes("FROM pg_proc routine")) return { rows:functionAclRows };
    if (sql.includes("FROM pg_roles")) return { rows:[identity] };
    if (sql.includes("relrowsecurity")) return { rows:rlsRows };
    if (sql.includes("has_schema_privilege")) return { rows:[privilegeEvidence] };
    if (sql.includes("pg_get_userbyid")) return { rows:ownerRows };
    throw new Error("unexpected runtime query");
  },
  tenantQuery:async (_tenant, sql) => sql.includes("FROM knowledge_releases")
    ? { rows:[release] }
    : { rows:reviews }
};
const redis = { health:async () => ({ ok:true, status:"ok", latency_ms:1 }) };
const readyEnvironment = {
  ...evidenceEnvironment,
  HUAMEI_DATABASE_URL:"postgresql://huamei_runtime:runtime-secret-not-printed@db/huamei",
  HUAMEI_MIGRATION_DATABASE_URL:"postgresql://huamei_migrator:migration-secret-not-printed@db/huamei",
  HUAMEI_REDIS_URL:"redis://:redis-secret-not-printed@redis/0",
  HUAMEI_GRAPHRAG_URL:"http://graphrag:4191",
  HUAMEI_RELEASE_ACQUISITION_READY_URL:"http://acquisition:4180/ready",
  HUAMEI_RELEASE_APP_READY_URL:"http://app:4173/api/ready",
  HUAMEI_ACQUISITION_CALLER_ID:"gateway",
  HUAMEI_ACQUISITION_CALLER_SECRET:"caller-secret-not-printed-1234567890",
  HUAMEI_API_KEY:"api-secret-not-printed-1234567890123456",
  HUAMEI_PUBLIC_TENANT_ID:tenantId
};
const readyLlm = {
  enabled:true,
  configured:true,
  provider:readyEnvironment.HUAMEI_LLM_PROVIDER,
  model:readyEnvironment.HUAMEI_LLM_MODEL,
  mode:"hybrid_llm_runtime"
};
const readyInfrastructure = {
  configuration:{ backends:{
    field_encryption_configured:true,
    contact_vault_encryption_configured:true
  } },
  dependencies:{ contact_vault:{ ok:true, status:"ready" } }
};
assert.equal(validateApplicationReadyBinding("acquisition", {
  status:"ready",
  llm:readyLlm,
  infrastructure:readyInfrastructure
}, readyEnvironment).ok, true);
assert.equal(validateApplicationReadyBinding("app", {
  status:"ready",
  checks:{ llm:readyLlm, infrastructure:readyInfrastructure }
}, readyEnvironment).ok, true);
assert.equal(validateApplicationReadyBinding("app", {
  status:"ready",
  checks:{ llm:{ ...readyLlm, enabled:false }, infrastructure:readyInfrastructure }
}, readyEnvironment).ok, false);
const fetchImpl = async (url) => {
  const graph = String(url).includes("graphrag");
  const acquisition = String(url).includes("acquisition");
  return {
    ok:true,
    status:200,
    json:async () => graph ? {
      ready:true,
      engine:"official_graphrag_3_1_1",
      tenant_id:tenantId,
      release_id:releaseId,
      index_version:indexVersion,
      manifest_sha256:manifestChecksum
    } : acquisition ? {
      status:"ready",
      llm:readyLlm,
      infrastructure:readyInfrastructure
    } : {
      status:"ready",
      checks:{ llm:readyLlm, infrastructure:readyInfrastructure }
    }
  };
};
const report = await runProductionReleasePreflight({
  env:readyEnvironment,
  runtimeDatabase,
  controlDatabase,
  redis,
  fetchImpl,
  readFileImpl:async (path) => evidenceFiles.get(path)
});
assert.equal(report.status, "ready", JSON.stringify(report));
assert.equal(report.checks.find((item) => item.name === "field_encryption_v2_cutover")?.status, "pass");
const serializedReport = JSON.stringify(report);
for (const secret of [
  "runtime-secret-not-printed", "migration-secret-not-printed", "redis-secret-not-printed",
  "caller-secret-not-printed", "api-secret-not-printed", readyEnvironment.HUAMEI_LLM_API_KEY,
  readyEnvironment.GRAPHRAG_API_KEY, fieldKey
]) {
  assert.equal(serializedReport.includes(secret), false, `发布预检报告不得泄露${secret}`);
}

const legacyControlDatabase = {
  transaction:async (operation) => operation({
    query:async (sql) => {
      if (sql.includes("SET LOCAL ROLE")) return { rows:[] };
      if (sql.includes("current_user")) return { rows:[{ current_user:"huamei_owner", session_user:"huamei_migrator" }] };
      if (sql.includes("FROM pg_roles")) return { rows:databaseRoleRows };
      if (sql.includes("FROM pg_auth_members")) return { rows:databaseMembershipRows };
      if (sql.includes("schema_migrations")) return { rows:appliedMigrations };
      if (sql.includes("pg_get_userbyid")) return { rows:ownerRows };
      if (sql.includes("field_encryption_v2_cutover")) return {
        rows:cleanEnvelopeInventoryRows.map((row, index) => index === 0
          ? { ...row, legacy_v1_count:"1" }
          : row)
      };
      throw new Error("unexpected control query");
    }
  })
};
const legacyBlockedReport = await runProductionReleasePreflight({
  env:readyEnvironment,
  runtimeDatabase,
  controlDatabase:legacyControlDatabase,
  redis,
  fetchImpl,
  readFileImpl:async (path) => evidenceFiles.get(path)
});
assert.equal(legacyBlockedReport.status, "blocked", "只要存在v1信封就不得进入灰度");
assert.equal(
  legacyBlockedReport.checks.find((item) => item.name === "field_encryption_v2_cutover")?.code,
  "FIELD_ENCRYPTION_LEGACY_ENVELOPES_REMAIN"
);

console.log("✓ 生产发布预检：真实LLM/加密/正式证据、不可变镜像、迁移checksum、RLS与GraphRAG绑定通过");
