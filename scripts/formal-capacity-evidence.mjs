import { isAbsolute } from "node:path";

import {
  evidenceError,
  mainModule,
  objectValue,
  parseCliOptions,
  readJsonWithSha,
  safeReference,
  signEvidenceDocumentFromEnv,
  trustedSignerRegistryFromEnv,
  validSha256,
  validTimestamp,
  verifyEvidenceDocumentAttestation,
  validateImmutableBinding,
  writeJsonAtomic
} from "./formal-evidence-common.mjs";

export const RAW_CAPACITY_SCHEMA = "huamei.load.soak.v2";
export const PROMETHEUS_CAPACITY_EXPORT_SCHEMA = "huamei.prometheus-capacity-export.v1";
export const CAPACITY_ATTESTATION_SCHEMA = "huamei.production-capacity-attestation.v2";
export const PRODUCTION_CAPACITY_SCHEMA = "huamei.production-capacity-evidence.v2";
export const FORMAL_LOAD_TAXONOMY_ALGORITHM = "factoradic-token-permutation.v1";

const productionEnvironments = new Set(["preproduction", "production"]);
const finiteNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const integer = (value) => Number.isInteger(Number(value)) ? Number(value) : null;
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));
const numericMap = (value) => Object.fromEntries(Object.entries(objectValue(value))
  .filter(([, item]) => Number.isFinite(Number(item)))
  .map(([key, item]) => [key, Number(item)]));
const nestedNumericMap = (value) => Object.fromEntries(Object.entries(objectValue(value))
  .map(([key, item]) => [key, numericMap(item)]));
const ratio = (numerator, denominator) => denominator > 0 ? round(numerator / denominator) : 0;
const normalizedBinding = (value = {}) => ({
  releaseId:String(value.releaseId || "").trim(),
  knowledgeReleaseId:String(value.knowledgeReleaseId || "").trim(),
  indexVersion:String(value.indexVersion || "").trim(),
  knowledgeManifestSha256:String(value.knowledgeManifestSha256 || "").trim().toLowerCase(),
  applicationImage:String(value.applicationImage || "").trim(),
  graphRagImage:String(value.graphRagImage || "").trim(),
  llmProvider:String(value.llmProvider || "").trim(),
  llmModel:String(value.llmModel || "").trim(),
  graphRagModelProvider:String(value.graphRagModelProvider || "").trim(),
  graphRagModel:String(value.graphRagModel || "").trim(),
  environment:String(value.environment || "").trim().toLowerCase(),
  tenantId:String(value.tenantId || "").trim().toLowerCase()
});

export function productionCapacityBindingFromEnv(env = process.env) {
  return normalizedBinding({
    releaseId:env.HUAMEI_RELEASE_ID,
    knowledgeReleaseId:env.HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID,
    indexVersion:env.HUAMEI_GRAPHRAG_INDEX_VERSION,
    knowledgeManifestSha256:env.HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256,
    applicationImage:env.HUAMEI_APP_IMAGE,
    graphRagImage:env.HUAMEI_GRAPHRAG_IMAGE,
    llmProvider:env.HUAMEI_LLM_PROVIDER,
    llmModel:env.HUAMEI_LLM_MODEL,
    graphRagModelProvider:env.GRAPHRAG_MODEL_PROVIDER,
    graphRagModel:env.GRAPHRAG_COMPLETION_MODEL,
    environment:env.HUAMEI_EVIDENCE_ENVIRONMENT || env.HUAMEI_DEPLOYMENT_ENV || env.HUAMEI_RUNTIME_ENV,
    tenantId:env.HUAMEI_RELEASE_TENANT_ID || env.HUAMEI_PUBLIC_TENANT_ID
  });
}

const bindingFields = Object.freeze([
  ["release_id", "releaseId"],
  ["knowledge_release_id", "knowledgeReleaseId"],
  ["application_image", "applicationImage"],
  ["graphrag_image", "graphRagImage"],
  ["index_version", "indexVersion"],
  ["knowledge_manifest_sha256", "knowledgeManifestSha256"],
  ["llm_provider", "llmProvider"],
  ["llm_model", "llmModel"],
  ["graphrag_model_provider", "graphRagModelProvider"],
  ["graphrag_model", "graphRagModel"],
  ["environment", "environment"]
]);

const validateDocumentBinding = (document, binding, prefix, failures) => {
  for (const [field, key] of bindingFields) {
    if (document[field] !== binding[key]) failures.push(`${prefix}_${field.toUpperCase()}_MISMATCH`);
  }
};

const formalHttpsTarget = (value) => {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch { return false; }
};

const timeWindow = (startedAt, finishedAt) => {
  const started = Date.parse(String(startedAt || ""));
  const finished = Date.parse(String(finishedAt || ""));
  return Number.isFinite(started) && Number.isFinite(finished) && finished > started
    ? { started, finished, seconds:(finished - started) / 1_000 }
    : null;
};

const percentile = (values, probability) => {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(probability * ordered.length) - 1))];
};

const validatedThresholds = (options = {}) => ({
  minimumConcurrentUsers:Math.max(20, Number(options.minimumConcurrentUsers || 20)),
  minimumDurationSeconds:Math.max(1_800, Number(options.minimumDurationSeconds || 1_800)),
  maximumErrorRate:Math.min(0.005, Math.max(0, Number(options.maximumErrorRate ?? 0.005))),
  maximumP95Ms:Math.min(10_000, Math.max(1, Number(options.maximumP95Ms || 10_000))),
  minimumRequests:Math.max(2_500, Number(options.minimumRequests || 2_500)),
  minimumDependencyAttemptCoverage:Math.max(0.95, Math.min(1, Number(options.minimumDependencyAttemptCoverage || 0.95))),
  minimumDependencySuccessRate:Math.max(0.99, Math.min(1, Number(options.minimumDependencySuccessRate || 0.99))),
  minimumQueryDiversityRatio:Math.max(0.95, Math.min(1, Number(options.minimumQueryDiversityRatio || 0.95))),
  minimumCacheMissRatio:Math.max(0.95, Math.min(1, Number(options.minimumCacheMissRatio || 0.95))),
  maximumTelemetrySampleGapSeconds:Math.min(60, Math.max(1, Number(options.maximumTelemetrySampleGapSeconds || 60)))
});

const closeEnough = (actual, expected, tolerance = 0.011) => Number.isFinite(actual)
  && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;

const validateDependencyUsage = (name, value, success, thresholds, failures) => {
  const usage = objectValue(value);
  const required = integer(usage.required_requests);
  const successful = integer(usage.successful_requests);
  const skipped = integer(usage.fallback_or_skip_requests);
  const reportedRatio = finiteNumber(usage.observed_success_ratio);
  const minimumAttempts = Math.ceil(Number(success || 0) * thresholds.minimumDependencyAttemptCoverage);
  if (required === null || required < minimumAttempts) failures.push(`CAPACITY_RAW_${name}_ATTEMPT_COVERAGE_INSUFFICIENT`);
  if (successful === null || successful < 0 || (required !== null && successful > required)) {
    failures.push(`CAPACITY_RAW_${name}_SUCCESS_COUNT_INVALID`);
  }
  if (skipped === null || required === null || successful === null || skipped !== required - successful) {
    failures.push(`CAPACITY_RAW_${name}_FALLBACK_COUNT_MISMATCH`);
  }
  const recomputed = required > 0 && successful !== null ? ratio(successful, required) : 0;
  if (reportedRatio === null || !closeEnough(reportedRatio, recomputed, 0.000001)) {
    failures.push(`CAPACITY_RAW_${name}_SUCCESS_RATIO_MISMATCH`);
  }
  if (recomputed < thresholds.minimumDependencySuccessRate) failures.push(`CAPACITY_RAW_${name}_SUCCESS_RATE_INSUFFICIENT`);
  return { required, successful, skipped, success_ratio:recomputed };
};

export function validateRawCapacityReport(raw = {}, options = {}) {
  const thresholds = validatedThresholds(options);
  const failures = [];
  const binding = normalizedBinding(options.binding);
  if (raw.schema_version !== RAW_CAPACITY_SCHEMA) failures.push("CAPACITY_RAW_SCHEMA_INVALID");
  if (raw.evidence_class !== "sustained_ai_main_path") failures.push("CAPACITY_RAW_EVIDENCE_CLASS_INVALID");
  if (raw.formal_acceptance_eligible !== true) failures.push("CAPACITY_RAW_NOT_FORMAL_ELIGIBLE");
  if (raw.target !== "acquisition-agent") failures.push("CAPACITY_RAW_TARGET_INVALID");
  if (!safeReference(raw.test_id)) failures.push("CAPACITY_RAW_TEST_ID_INVALID");
  if (!formalHttpsTarget(raw.base_url)) failures.push("CAPACITY_RAW_FORMAL_HTTPS_TARGET_REQUIRED");
  if (options.tenantId && raw.tenant_id !== options.tenantId) failures.push("CAPACITY_RAW_TENANT_MISMATCH");
  if (binding.releaseId) validateDocumentBinding(objectValue(raw.binding), binding, "CAPACITY_RAW_BINDING", failures);

  const virtualUsers = integer(raw.virtual_users);
  const rampSeconds = finiteNumber(raw.ramp_seconds);
  const requestedDuration = finiteNumber(raw.requested_duration_seconds);
  const actualDuration = finiteNumber(raw.actual_duration_seconds);
  const reportedSteadyDuration = finiteNumber(raw.steady_state_duration_seconds);
  if (virtualUsers === null || virtualUsers < thresholds.minimumConcurrentUsers) failures.push("CAPACITY_RAW_CONCURRENCY_INSUFFICIENT");
  if (rampSeconds === null || rampSeconds < 0) failures.push("CAPACITY_RAW_RAMP_INVALID");
  if (requestedDuration === null || requestedDuration - Number(rampSeconds || 0) < thresholds.minimumDurationSeconds) {
    failures.push("CAPACITY_RAW_REQUESTED_STEADY_DURATION_INSUFFICIENT");
  }
  if (actualDuration === null || actualDuration - Number(rampSeconds || 0) < thresholds.minimumDurationSeconds) {
    failures.push("CAPACITY_RAW_STEADY_STATE_DURATION_INSUFFICIENT");
  }
  const recomputedSteadyDuration = actualDuration !== null && rampSeconds !== null
    ? round(actualDuration - rampSeconds, 3) : null;
  if (reportedSteadyDuration === null || !closeEnough(reportedSteadyDuration, recomputedSteadyDuration, 0.011)) {
    failures.push("CAPACITY_RAW_STEADY_DURATION_MISMATCH");
  }
  const window = timeWindow(raw.started_at, raw.finished_at);
  if (!window) failures.push("CAPACITY_RAW_TIME_WINDOW_INVALID");
  else if (actualDuration !== null && Math.abs(window.seconds - actualDuration) > Math.max(5, actualDuration * 0.02)) {
    failures.push("CAPACITY_RAW_DURATION_TIME_WINDOW_MISMATCH");
  }

  const loadIdentity = objectValue(raw.load_identity);
  const perVirtualUserCallers = loadIdentity.mode === "per_virtual_user_callers"
    && integer(loadIdentity.caller_count) >= virtualUsers && validSha256(loadIdentity.caller_ids_sha256);
  const sharedApproved = loadIdentity.mode === "shared_caller_with_approved_limit"
    && integer(loadIdentity.caller_count) === 1
    && integer(loadIdentity.approved_rate_limit_per_minute) !== null
    && Number(loadIdentity.approved_rate_limit_per_minute) >= Number(loadIdentity.required_rate_limit_per_minute)
    && safeReference(loadIdentity.rate_limit_approval_id);
  if (!perVirtualUserCallers && !sharedApproved) failures.push("CAPACITY_RAW_LOAD_IDENTITY_OR_RATE_LIMIT_NOT_PROVEN");

  const requests = integer(raw.requests);
  const success = integer(raw.success);
  if (requests === null || requests < thresholds.minimumRequests) failures.push("CAPACITY_RAW_REQUEST_COUNT_INSUFFICIENT");
  if (success === null || success < 0 || (requests !== null && success > requests)) failures.push("CAPACITY_RAW_SUCCESS_COUNT_INVALID");
  const counts = objectValue(raw.status_counts);
  const countValues = Object.values(counts).map(integer);
  if (!Object.keys(counts).length || countValues.some((value) => value === null || value < 0)) {
    failures.push("CAPACITY_RAW_STATUS_COUNTS_INVALID");
  }
  const counted = countValues.every((value) => value !== null) ? countValues.reduce((sum, value) => sum + value, 0) : -1;
  if (requests !== null && counted !== requests) failures.push("CAPACITY_RAW_STATUS_TOTAL_MISMATCH");
  if (success !== null && integer(counts["200"]) !== success) failures.push("CAPACITY_RAW_SUCCESS_STATUS_MISMATCH");
  const recomputedErrorRate = requests > 0 && success !== null ? round(1 - success / requests) : 1;
  const reportedErrorRate = finiteNumber(raw.error_rate);
  if (reportedErrorRate === null || !closeEnough(reportedErrorRate, recomputedErrorRate, 0.000001)) {
    failures.push("CAPACITY_RAW_ERROR_RATE_MISMATCH");
  }
  if (recomputedErrorRate > thresholds.maximumErrorRate) failures.push("CAPACITY_RAW_ERROR_RATE_THRESHOLD_FAILED");

  const latencySamples = Array.isArray(raw.latency_samples_ms) ? raw.latency_samples_ms.map(finiteNumber) : [];
  if (requests === null || latencySamples.length !== requests || latencySamples.some((value) => value === null || value < 0)) {
    failures.push("CAPACITY_RAW_LATENCY_SAMPLES_INVALID");
  }
  const samplesValid = latencySamples.length > 0 && latencySamples.every((value) => value !== null && value >= 0);
  const recomputedLatency = samplesValid ? {
    min:round(latencySamples.reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY), 2),
    mean:round(latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length, 2),
    p50:round(percentile(latencySamples, 0.50), 2),
    p95:round(percentile(latencySamples, 0.95), 2),
    p99:round(percentile(latencySamples, 0.99), 2),
    max:round(latencySamples.reduce((maximum, value) => Math.max(maximum, value), 0), 2)
  } : {};
  const reportedLatency = objectValue(raw.latency_ms);
  for (const field of ["min", "mean", "p50", "p95", "p99", "max"]) {
    if (!closeEnough(finiteNumber(reportedLatency[field]), recomputedLatency[field], 0.011)) {
      failures.push(`CAPACITY_RAW_LATENCY_${field.toUpperCase()}_MISMATCH`);
    }
  }
  if (Number(recomputedLatency.p95) > thresholds.maximumP95Ms) failures.push("CAPACITY_RAW_P95_THRESHOLD_FAILED");
  const throughput = finiteNumber(raw.throughput_rps);
  const recomputedThroughput = requests > 0 && actualDuration > 0 ? round(requests / actualDuration, 2) : 0;
  if (!closeEnough(throughput, recomputedThroughput, 0.011)) failures.push("CAPACITY_RAW_THROUGHPUT_MISMATCH");

  const minuteBuckets = nestedNumericMap(raw.minute_buckets);
  const bucketKeys = Object.keys(minuteBuckets).map(integer);
  const minuteTotals = Object.values(minuteBuckets).map((bucket) => Object.values(bucket).reduce((sum, value) => sum + value, 0));
  const minuteStatusTotals = {};
  for (const bucket of Object.values(minuteBuckets)) {
    for (const [status, value] of Object.entries(bucket)) minuteStatusTotals[status] = (minuteStatusTotals[status] || 0) + value;
  }
  const normalizedCounts = numericMap(counts);
  const consecutiveBuckets = bucketKeys.every((value, index) => value === index);
  if (bucketKeys.some((value) => value === null) || !consecutiveBuckets
    || minuteTotals.length < Math.floor(Number(actualDuration || 0) / 60)
    || minuteTotals.some((value) => !Number.isInteger(value) || value <= 0)
    || (requests !== null && minuteTotals.reduce((sum, value) => sum + value, 0) !== requests)
    || Object.keys(normalizedCounts).some((status) => minuteStatusTotals[status] !== normalizedCounts[status])
    || Object.keys(minuteStatusTotals).some((status) => normalizedCounts[status] !== minuteStatusTotals[status])) {
    failures.push("CAPACITY_RAW_MINUTE_BUCKETS_INVALID");
  }
  const turnP95 = numericMap(raw.turn_latency_p95_ms);
  if (Object.keys(turnP95).length < 3 || Object.values(turnP95).some((value) => value < 0)) {
    failures.push("CAPACITY_RAW_MULTITURN_METRICS_INVALID");
  }

  const dependency = objectValue(raw.dependency_usage);
  const liveModel = validateDependencyUsage("LIVE_MODEL", dependency.live_model, success, thresholds, failures);
  const graphRag = validateDependencyUsage("GRAPHRAG", dependency.graphrag, success, thresholds, failures);
  if (objectValue(dependency.graphrag).engine !== "official_graphrag_3_1_1") {
    failures.push("CAPACITY_RAW_OFFICIAL_GRAPHRAG_NOT_PROVEN");
  }
  const diversity = objectValue(raw.query_diversity);
  const queryHashes = Array.isArray(diversity.query_hashes) ? diversity.query_hashes : [];
  if (diversity.query_hash_source !== "graphrag_response_sanitized_query_sha256") {
    failures.push("CAPACITY_RAW_QUERY_HASH_SOURCE_INVALID");
  }
  const validQueryHashes = queryHashes.every(validSha256);
  const distinctQueries = validQueryHashes ? new Set(queryHashes).size : 0;
  const recomputedQueryRatio = ratio(distinctQueries, queryHashes.length);
  if (!validQueryHashes || queryHashes.length !== requests || integer(diversity.request_count) !== requests
    || integer(diversity.distinct_query_count) !== distinctQueries
    || !closeEnough(finiteNumber(diversity.unique_ratio), recomputedQueryRatio, 0.000001)) {
    failures.push("CAPACITY_RAW_QUERY_DIVERSITY_INVALID");
  }
  if (recomputedQueryRatio < thresholds.minimumQueryDiversityRatio) failures.push("CAPACITY_RAW_QUERY_DIVERSITY_INSUFFICIENT");
  if (integer(objectValue(dependency.graphrag).expected_cache_miss_count) !== distinctQueries) {
    failures.push("CAPACITY_RAW_EXPECTED_CACHE_MISS_COUNT_MISMATCH");
  }
  const formalTaxonomy = objectValue(raw.formal_load_taxonomy);
  const formalTaxonomyMetrics = {
    manifest_id:String(formalTaxonomy.manifest_id || ""),
    manifest_sha256:String(formalTaxonomy.manifest_sha256 || "").toLowerCase(),
    signer_id:String(formalTaxonomy.signer_id || ""),
    signed_payload_sha256:String(formalTaxonomy.signed_payload_sha256 || "").toLowerCase(),
    catalog_sha256:String(formalTaxonomy.catalog_sha256 || "").toLowerCase(),
    algorithm_version:String(formalTaxonomy.algorithm_version || ""),
    requests_checked:integer(formalTaxonomy.requests_checked),
    applied_responses:integer(formalTaxonomy.applied_responses),
    application_ratio:finiteNumber(formalTaxonomy.application_ratio),
    distinct_entry_count:integer(formalTaxonomy.distinct_entry_count),
    entry_ids_sha256:String(formalTaxonomy.entry_ids_sha256 || "").toLowerCase()
  };
  if (formalTaxonomy.required !== true || !safeReference(formalTaxonomyMetrics.manifest_id)
    || !validSha256(formalTaxonomyMetrics.manifest_sha256) || !safeReference(formalTaxonomyMetrics.signer_id)
    || !validSha256(formalTaxonomyMetrics.signed_payload_sha256)
    || !validSha256(formalTaxonomyMetrics.catalog_sha256)
    || formalTaxonomyMetrics.algorithm_version !== FORMAL_LOAD_TAXONOMY_ALGORITHM
    || formalTaxonomyMetrics.requests_checked !== requests
    || formalTaxonomyMetrics.applied_responses !== requests
    || formalTaxonomyMetrics.application_ratio !== 1
    || formalTaxonomyMetrics.distinct_entry_count !== requests
    || !validSha256(formalTaxonomyMetrics.entry_ids_sha256)) {
    failures.push("CAPACITY_RAW_FORMAL_LOAD_TAXONOMY_INVALID");
  }

  const contract = objectValue(raw.contract_checks);
  if (integer(contract.responses_checked) !== requests || integer(contract.valid_responses) !== success
    || contract.canary_isolation_passed !== true || Object.keys(objectValue(contract.failure_counts)).length) {
    failures.push("CAPACITY_RAW_RESPONSE_CONTRACT_OR_CANARY_INVALID");
  }
  const users = Array.isArray(raw.user_summaries) ? raw.user_summaries : [];
  const canaryHashes = new Set();
  let totalTurns = 0;
  for (const item of users) {
    const turns = integer(item?.turns);
    const validTurns = integer(item?.valid_turns);
    const canary = String(item?.conversation_canary_sha256 || "");
    if (integer(item?.user_index) === null || turns === null || turns <= 0 || validTurns !== turns
      || !validSha256(canary) || !validTimestamp(item?.started_at) || !validTimestamp(item?.finished_at)
      || integer(item?.llm_successes) !== turns || integer(item?.graphrag_successes) !== turns) {
      failures.push("CAPACITY_RAW_USER_SESSION_INVALID");
      break;
    }
    canaryHashes.add(canary);
    totalTurns += turns;
  }
  if (users.length !== virtualUsers || canaryHashes.size !== users.length || totalTurns !== requests) {
    failures.push("CAPACITY_RAW_USER_SESSION_TOTAL_MISMATCH");
  }

  const rawAcceptance = objectValue(raw.acceptance);
  if (rawAcceptance.formal_candidate !== true || rawAcceptance.passed !== true) failures.push("CAPACITY_RAW_RUNNER_REJECTED");
  if (finiteNumber(rawAcceptance.max_error_rate) === null
    || Number(rawAcceptance.max_error_rate) > thresholds.maximumErrorRate) failures.push("CAPACITY_RAW_ERROR_GATE_TOO_PERMISSIVE");
  if (finiteNumber(rawAcceptance.max_p95_ms) === null
    || Number(rawAcceptance.max_p95_ms) > thresholds.maximumP95Ms) failures.push("CAPACITY_RAW_LATENCY_GATE_TOO_PERMISSIVE");
  if (integer(rawAcceptance.minimum_requests) === null
    || Number(rawAcceptance.minimum_requests) < thresholds.minimumRequests) failures.push("CAPACITY_RAW_REQUEST_GATE_TOO_PERMISSIVE");
  if (finiteNumber(rawAcceptance.minimum_dependency_attempt_coverage) === null
    || Number(rawAcceptance.minimum_dependency_attempt_coverage) < thresholds.minimumDependencyAttemptCoverage) {
    failures.push("CAPACITY_RAW_DEPENDENCY_ATTEMPT_GATE_TOO_PERMISSIVE");
  }
  if (finiteNumber(rawAcceptance.minimum_dependency_success_rate) === null
    || Number(rawAcceptance.minimum_dependency_success_rate) < thresholds.minimumDependencySuccessRate) {
    failures.push("CAPACITY_RAW_DEPENDENCY_SUCCESS_GATE_TOO_PERMISSIVE");
  }
  if (finiteNumber(rawAcceptance.minimum_query_diversity_ratio) === null
    || Number(rawAcceptance.minimum_query_diversity_ratio) < thresholds.minimumQueryDiversityRatio) {
    failures.push("CAPACITY_RAW_QUERY_DIVERSITY_GATE_TOO_PERMISSIVE");
  }

  return {
    ok:failures.length === 0,
    failures:[...new Set(failures)],
    thresholds,
    metrics:{
      test_id:raw.test_id || null,
      concurrent_users:virtualUsers,
      ramp_seconds:rampSeconds,
      requested_duration_seconds:requestedDuration,
      actual_duration_seconds:actualDuration,
      steady_state_duration_seconds:recomputedSteadyDuration,
      requests,
      success,
      error_rate:recomputedErrorRate,
      p95_ms:recomputedLatency.p95 ?? null,
      throughput_rps:throughput,
      latency_ms:recomputedLatency,
      latency_sample_count:latencySamples.length,
      turn_latency_p95_ms:turnP95,
      minute_buckets:minuteBuckets,
      status_counts:normalizedCounts,
      time_window:window,
      live_model:liveModel,
      graphrag:graphRag,
      query_diversity:{ request_count:queryHashes.length, distinct_query_count:distinctQueries, unique_ratio:recomputedQueryRatio },
      expected_cache_miss_count:distinctQueries,
      formal_load_taxonomy:formalTaxonomyMetrics,
      load_identity:loadIdentity
    }
  };
}

const counterFields = Object.freeze([
  "business_requests_total",
  "live_model_attempts_total",
  "live_model_success_total",
  "live_model_tokens_total",
  "graphrag_attempts_total",
  "graphrag_success_total",
  "graphrag_cache_misses_total",
  "graphrag_model_attempts_total",
  "graphrag_model_success_total",
  "graphrag_model_tokens_total",
  "formal_load_taxonomy_applied_total",
  "formal_load_taxonomy_rejected_total"
]);

const peakPerMinute = (samples, field) => {
  let peak = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const elapsedMinutes = (samples[index].timestamp_ms - samples[index - 1].timestamp_ms) / 60_000;
    if (elapsedMinutes > 0) peak = Math.max(peak, (samples[index][field] - samples[index - 1][field]) / elapsedMinutes);
  }
  return round(peak, 2);
};

export function validatePrometheusCapacityExport(document = {}, context = {}) {
  const failures = [];
  const binding = normalizedBinding(context.binding);
  const raw = objectValue(context.rawReport);
  const rawValidation = context.rawValidation || validateRawCapacityReport(raw, {
    tenantId:binding.tenantId,
    binding,
    ...context.thresholds
  });
  const thresholds = rawValidation.thresholds || validatedThresholds(context.thresholds);
  if (document.schema_version !== PROMETHEUS_CAPACITY_EXPORT_SCHEMA) failures.push("CAPACITY_PROMETHEUS_SCHEMA_INVALID");
  if (document.evidence_class !== "raw_prometheus_capacity_export") failures.push("CAPACITY_PROMETHEUS_CLASS_INVALID");
  if (!safeReference(document.export_id)) failures.push("CAPACITY_PROMETHEUS_EXPORT_ID_INVALID");
  if (document.test_id !== raw.test_id) failures.push("CAPACITY_PROMETHEUS_TEST_ID_MISMATCH");
  if (document.tenant_id !== binding.tenantId) failures.push("CAPACITY_PROMETHEUS_TENANT_MISMATCH");
  validateDocumentBinding(document, binding, "CAPACITY_PROMETHEUS_BINDING", failures);
  const exportWindow = timeWindow(document.window_started_at, document.window_finished_at);
  const rawWindow = rawValidation.metrics?.time_window || timeWindow(raw.started_at, raw.finished_at);
  if (!exportWindow || !rawWindow || exportWindow.started > rawWindow.started || exportWindow.finished < rawWindow.finished) {
    failures.push("CAPACITY_PROMETHEUS_WINDOW_DOES_NOT_COVER_RUN");
  }
  const queryReferences = objectValue(document.query_references);
  for (const field of ["concurrency", "business_requests", "live_model", "graphrag", "graphrag_cache", "graphrag_query_model", "formal_load_taxonomy"]) {
    if (!safeReference(queryReferences[field])) failures.push(`CAPACITY_PROMETHEUS_${field.toUpperCase()}_QUERY_REFERENCE_INVALID`);
  }
  const rawSamples = Array.isArray(document.samples) ? document.samples : [];
  const samples = [];
  for (const item of rawSamples) {
    const timestamp = Date.parse(String(item?.timestamp || ""));
    const normalized = { timestamp_ms:timestamp, active_virtual_users:integer(item?.active_virtual_users) };
    for (const field of counterFields) normalized[field] = finiteNumber(item?.[field]);
    if (!Number.isFinite(timestamp) || normalized.active_virtual_users === null || normalized.active_virtual_users < 0
      || counterFields.some((field) => normalized[field] === null || normalized[field] < 0)) {
      failures.push("CAPACITY_PROMETHEUS_SAMPLE_INVALID");
      continue;
    }
    samples.push(normalized);
  }
  let maximumGapSeconds = null;
  let monotonic = samples.length === rawSamples.length && samples.length > 1;
  for (let index = 1; index < samples.length; index += 1) {
    const gap = (samples[index].timestamp_ms - samples[index - 1].timestamp_ms) / 1_000;
    if (!(gap > 0)) monotonic = false;
    maximumGapSeconds = Math.max(maximumGapSeconds || 0, gap);
    for (const field of counterFields) if (samples[index][field] < samples[index - 1][field]) monotonic = false;
  }
  if (!monotonic) failures.push("CAPACITY_PROMETHEUS_COUNTERS_NOT_MONOTONIC");
  if (maximumGapSeconds === null || maximumGapSeconds > thresholds.maximumTelemetrySampleGapSeconds) {
    failures.push("CAPACITY_PROMETHEUS_SAMPLE_GAP_TOO_LARGE");
  }
  const steadyStarted = rawWindow ? rawWindow.started + Number(rawValidation.metrics?.ramp_seconds || 0) * 1_000 : Number.NaN;
  const steadyFinished = rawWindow?.finished;
  const steadySamples = samples.filter((item) => item.timestamp_ms >= steadyStarted && item.timestamp_ms <= steadyFinished);
  const minimumActiveUsers = steadySamples.length ? Math.min(...steadySamples.map((item) => item.active_virtual_users)) : 0;
  const expectedSteadySamples = Math.floor(thresholds.minimumDurationSeconds / thresholds.maximumTelemetrySampleGapSeconds) + 1;
  if (steadySamples.length < expectedSteadySamples) failures.push("CAPACITY_PROMETHEUS_CONCURRENCY_SAMPLES_INSUFFICIENT");
  if (minimumActiveUsers < thresholds.minimumConcurrentUsers) failures.push("CAPACITY_PROMETHEUS_MINIMUM_USERS_NOT_PROVEN");
  if (steadySamples.length && (steadySamples[0].timestamp_ms > steadyStarted
    || steadySamples[steadySamples.length - 1].timestamp_ms < steadyFinished - thresholds.maximumTelemetrySampleGapSeconds * 1_000)) {
    failures.push("CAPACITY_PROMETHEUS_STEADY_WINDOW_NOT_COVERED");
  }
  const first = samples[0] || {};
  const last = samples[samples.length - 1] || {};
  const deltas = Object.fromEntries(counterFields.map((field) => [field, Number.isFinite(last[field]) && Number.isFinite(first[field])
    ? last[field] - first[field] : 0]));
  if (deltas.business_requests_total !== rawValidation.metrics?.requests) failures.push("CAPACITY_PROMETHEUS_BUSINESS_REQUEST_TOTAL_MISMATCH");
  const minimumModelAttempts = Math.ceil(Number(rawValidation.metrics?.success || 0) * thresholds.minimumDependencyAttemptCoverage);
  const modelSuccessRate = ratio(deltas.live_model_success_total, deltas.live_model_attempts_total);
  if (deltas.live_model_attempts_total < minimumModelAttempts) failures.push("CAPACITY_PROMETHEUS_MODEL_ATTEMPT_COVERAGE_INSUFFICIENT");
  if (modelSuccessRate < thresholds.minimumDependencySuccessRate) failures.push("CAPACITY_PROMETHEUS_MODEL_SUCCESS_RATE_INSUFFICIENT");
  if (deltas.live_model_attempts_total !== rawValidation.metrics?.live_model?.required
    || deltas.live_model_success_total !== rawValidation.metrics?.live_model?.successful) {
    failures.push("CAPACITY_PROMETHEUS_MODEL_RAW_USAGE_MISMATCH");
  }
  const minimumGraphAttempts = Math.ceil(Number(rawValidation.metrics?.success || 0) * thresholds.minimumDependencyAttemptCoverage);
  const graphSuccessRate = ratio(deltas.graphrag_success_total, deltas.graphrag_attempts_total);
  if (deltas.graphrag_attempts_total < minimumGraphAttempts) failures.push("CAPACITY_PROMETHEUS_GRAPHRAG_ATTEMPT_COVERAGE_INSUFFICIENT");
  if (graphSuccessRate < thresholds.minimumDependencySuccessRate) failures.push("CAPACITY_PROMETHEUS_GRAPHRAG_SUCCESS_RATE_INSUFFICIENT");
  if (deltas.graphrag_attempts_total !== rawValidation.metrics?.graphrag?.required
    || deltas.graphrag_success_total !== rawValidation.metrics?.graphrag?.successful) {
    failures.push("CAPACITY_PROMETHEUS_GRAPHRAG_RAW_USAGE_MISMATCH");
  }
  // Per-query Prometheus labels are intentionally diagnostic-only and remain
  // cardinality-capped by GraphRAG. Formal diversity is recomputed from the
  // runner's complete list of service-returned sanitized-query SHA-256 values.
  // The signed taxonomy binding, unique entry IDs, server-side entry->query
  // hash check, and cross-replica aggregate counters prevent a caller from
  // substituting raw-text hashes without creating an independently visible
  // usage mismatch.
  const diagnosticHashEntries = Object.entries(objectValue(document.sanitized_query_hash_counts))
    .filter(([queryHash, count]) => (validSha256(queryHash) || queryHash === "overflow")
      && Number.isInteger(count) && count > 0);
  const diagnosticHashCount = diagnosticHashEntries.reduce((sum, [, count]) => sum + count, 0);
  const diagnosticDistinctHashCount = diagnosticHashEntries.filter(([queryHash]) => queryHash !== "overflow").length;
  const cacheMissRatio = ratio(deltas.graphrag_cache_misses_total, deltas.graphrag_attempts_total);
  if (cacheMissRatio < thresholds.minimumCacheMissRatio
    || deltas.graphrag_cache_misses_total < Number(rawValidation.metrics?.expected_cache_miss_count || 0)) {
    failures.push("CAPACITY_PROMETHEUS_CACHE_MISS_COVERAGE_INSUFFICIENT");
  }
  const graphModelAttemptCoverage = ratio(deltas.graphrag_model_attempts_total, deltas.graphrag_cache_misses_total);
  const graphModelSuccessRate = ratio(deltas.graphrag_model_success_total, deltas.graphrag_model_attempts_total);
  if (graphModelAttemptCoverage < thresholds.minimumDependencyAttemptCoverage) {
    failures.push("CAPACITY_PROMETHEUS_GRAPHRAG_MODEL_ATTEMPT_COVERAGE_INSUFFICIENT");
  }
  if (graphModelSuccessRate < thresholds.minimumDependencySuccessRate) {
    failures.push("CAPACITY_PROMETHEUS_GRAPHRAG_MODEL_SUCCESS_RATE_INSUFFICIENT");
  }
  if (!(deltas.live_model_tokens_total > 0) || !(deltas.graphrag_model_tokens_total > 0)) {
    failures.push("CAPACITY_PROMETHEUS_MODEL_TOKEN_USAGE_NOT_PROVEN");
  }
  const rawFormalTaxonomy = objectValue(rawValidation.metrics?.formal_load_taxonomy);
  const exportedFormalTaxonomy = objectValue(document.formal_load_taxonomy);
  const formalTaxonomyApplicationRatio = ratio(
    deltas.formal_load_taxonomy_applied_total,
    deltas.business_requests_total
  );
  if (exportedFormalTaxonomy.query_reference !== queryReferences.formal_load_taxonomy
    || exportedFormalTaxonomy.manifest_id !== rawFormalTaxonomy.manifest_id
    || exportedFormalTaxonomy.manifest_sha256 !== rawFormalTaxonomy.manifest_sha256
    || exportedFormalTaxonomy.signer_id !== rawFormalTaxonomy.signer_id
    || exportedFormalTaxonomy.signed_payload_sha256 !== rawFormalTaxonomy.signed_payload_sha256
    || exportedFormalTaxonomy.catalog_sha256 !== rawFormalTaxonomy.catalog_sha256
    || exportedFormalTaxonomy.algorithm_version !== FORMAL_LOAD_TAXONOMY_ALGORITHM
    || deltas.formal_load_taxonomy_applied_total !== rawValidation.metrics?.requests
    || deltas.formal_load_taxonomy_rejected_total !== 0
    || formalTaxonomyApplicationRatio !== 1) {
    failures.push("CAPACITY_PROMETHEUS_FORMAL_LOAD_TAXONOMY_USAGE_INVALID");
  }
  const derived = {
    export_id:document.export_id || null,
    test_id:document.test_id || null,
    window:exportWindow,
    query_references:queryReferences,
    sample_count:samples.length,
    steady_sample_count:steadySamples.length,
    maximum_sample_gap_seconds:maximumGapSeconds,
    minimum_active_users:minimumActiveUsers,
    concurrent_window_seconds:rawValidation.metrics?.steady_state_duration_seconds ?? null,
    business_requests:deltas.business_requests_total,
    live_model:{
      attempts:deltas.live_model_attempts_total,
      success:deltas.live_model_success_total,
      success_rate:modelSuccessRate,
      tokens:deltas.live_model_tokens_total,
      peak_requests_per_minute:peakPerMinute(samples, "live_model_attempts_total"),
      peak_tokens_per_minute:peakPerMinute(samples, "live_model_tokens_total")
    },
    graphrag:{
      attempts:deltas.graphrag_attempts_total,
      success:deltas.graphrag_success_total,
      success_rate:graphSuccessRate,
      cache_misses:deltas.graphrag_cache_misses_total,
      cache_miss_ratio:cacheMissRatio,
      sanitized_query_count:diagnosticHashCount,
      distinct_sanitized_query_count:diagnosticDistinctHashCount,
      sanitized_query_metrics_complete:diagnosticHashCount === deltas.graphrag_attempts_total
        && !diagnosticHashEntries.some(([queryHash]) => queryHash === "overflow")
    },
    graphrag_query_model:{
      attempts:deltas.graphrag_model_attempts_total,
      success:deltas.graphrag_model_success_total,
      attempt_coverage:graphModelAttemptCoverage,
      success_rate:graphModelSuccessRate,
      tokens:deltas.graphrag_model_tokens_total,
      peak_requests_per_minute:peakPerMinute(samples, "graphrag_model_attempts_total"),
      peak_tokens_per_minute:peakPerMinute(samples, "graphrag_model_tokens_total")
    },
    formal_load_taxonomy:{
      query_reference:queryReferences.formal_load_taxonomy,
      manifest_id:rawFormalTaxonomy.manifest_id || null,
      manifest_sha256:rawFormalTaxonomy.manifest_sha256 || null,
      signer_id:rawFormalTaxonomy.signer_id || null,
      signed_payload_sha256:rawFormalTaxonomy.signed_payload_sha256 || null,
      catalog_sha256:rawFormalTaxonomy.catalog_sha256 || null,
      algorithm_version:rawFormalTaxonomy.algorithm_version || null,
      applied:deltas.formal_load_taxonomy_applied_total,
      rejected:deltas.formal_load_taxonomy_rejected_total,
      application_ratio:formalTaxonomyApplicationRatio
    }
  };
  return { ok:failures.length === 0, failures:[...new Set(failures)], derived, thresholds };
}

const approvedRecord = (value, prefix, failures, options = {}) => {
  const record = objectValue(value);
  const approved = record.status === "approved" || (options.booleanApproved === true && record.approved === true);
  if (!approved || !safeReference(record.approval_id)
    || !safeReference(record.approved_by) || !validTimestamp(record.approved_at)) failures.push(`${prefix}_APPROVAL_INVALID`);
  return record;
};

const coversWindow = (outer, inner) => outer && inner && outer.started <= inner.started && outer.finished >= inner.finished;
const compareTelemetryNumber = (reported, expected, code, failures, tolerance = 0.011) => {
  if (!closeEnough(finiteNumber(reported), finiteNumber(expected), tolerance)) failures.push(code);
};

const validateQuota = (quotaValue, model, rawWindow, observed, prefix, failures) => {
  const quota = objectValue(quotaValue);
  if (quota.approved !== true || quota.provider !== model.provider || quota.model !== model.model
    || !(Number(quota.requests_per_minute) > 0) || !(Number(quota.tokens_per_minute) > 0)) {
    failures.push(`${prefix}_INVALID`);
  }
  if (Number(quota.requests_per_minute) < Number(observed.peak_requests_per_minute || 0)) failures.push(`${prefix}_RPM_BELOW_OBSERVED_PEAK`);
  if (Number(quota.tokens_per_minute) < Number(observed.peak_tokens_per_minute || 0)) failures.push(`${prefix}_TPM_BELOW_OBSERVED_PEAK`);
  approvedRecord(quota, prefix, failures, { booleanApproved:true });
  if (!coversWindow(timeWindow(quota.valid_from, quota.valid_until), rawWindow)) failures.push(`${prefix}_WINDOW_INVALID`);
  return quota;
};

export function validateCapacityAttestation(attestation = {}, context = {}) {
  const binding = normalizedBinding(context.binding);
  const raw = objectValue(context.rawReport);
  const rawValidation = context.rawValidation || validateRawCapacityReport(raw, {
    tenantId:binding.tenantId,
    binding,
    ...context.thresholds
  });
  const prometheusValidation = context.prometheusValidation || validatePrometheusCapacityExport(context.prometheusExport, {
    binding,
    rawReport:raw,
    rawValidation,
    thresholds:context.thresholds
  });
  const derived = objectValue(prometheusValidation.derived);
  const failures = [];
  if (attestation.schema_version !== CAPACITY_ATTESTATION_SCHEMA) failures.push("CAPACITY_ATTESTATION_SCHEMA_INVALID");
  if (attestation.evidence_class !== "independent_production_telemetry") failures.push("CAPACITY_ATTESTATION_CLASS_INVALID");
  if (!validTimestamp(attestation.generated_at)) failures.push("CAPACITY_ATTESTATION_TIMESTAMP_INVALID");
  if (attestation.raw_report_sha256 !== context.rawReportSha256) failures.push("CAPACITY_ATTESTATION_RAW_SHA256_MISMATCH");
  if (attestation.prometheus_export_sha256 !== context.prometheusExportSha256
    || !validSha256(attestation.prometheus_export_sha256)) failures.push("CAPACITY_ATTESTATION_PROMETHEUS_SHA256_MISMATCH");
  for (const [field, expected] of [
    ["release_id", binding.releaseId], ["knowledge_release_id", binding.knowledgeReleaseId],
    ["environment", binding.environment], ["tenant_id", binding.tenantId],
    ["application_image", binding.applicationImage], ["graphrag_image", binding.graphRagImage],
    ["index_version", binding.indexVersion], ["knowledge_manifest_sha256", binding.knowledgeManifestSha256],
    ["llm_provider", binding.llmProvider], ["llm_model", binding.llmModel],
    ["graphrag_model_provider", binding.graphRagModelProvider], ["graphrag_model", binding.graphRagModel]
  ]) if (attestation[field] !== expected) failures.push(`CAPACITY_ATTESTATION_${field.toUpperCase()}_MISMATCH`);
  const rawWindow = rawValidation.metrics?.time_window || timeWindow(raw.started_at, raw.finished_at);
  const telemetry = objectValue(attestation.telemetry);
  if (telemetry.source !== "prometheus" || telemetry.export_id !== derived.export_id
    || telemetry.test_id !== raw.test_id || telemetry.export_sha256 !== context.prometheusExportSha256) {
    failures.push("CAPACITY_TELEMETRY_SOURCE_INVALID");
  }
  const telemetryWindow = timeWindow(telemetry.window_started_at, telemetry.window_finished_at);
  if (!coversWindow(telemetryWindow, rawWindow)
    || telemetryWindow?.started !== derived.window?.started || telemetryWindow?.finished !== derived.window?.finished) {
    failures.push("CAPACITY_TELEMETRY_WINDOW_MISMATCH");
  }
  const concurrency = objectValue(telemetry.concurrency);
  if (concurrency.query_reference !== derived.query_references?.concurrency) failures.push("CAPACITY_CONCURRENCY_QUERY_REFERENCE_MISMATCH");
  compareTelemetryNumber(concurrency.minimum_active_users, derived.minimum_active_users, "CAPACITY_CONCURRENCY_MINIMUM_MISMATCH", failures);
  compareTelemetryNumber(concurrency.concurrent_window_seconds, derived.concurrent_window_seconds, "CAPACITY_CONCURRENCY_WINDOW_MISMATCH", failures);
  compareTelemetryNumber(concurrency.sample_count, derived.sample_count, "CAPACITY_CONCURRENCY_SAMPLE_COUNT_MISMATCH", failures);
  compareTelemetryNumber(concurrency.maximum_sample_gap_seconds, derived.maximum_sample_gap_seconds, "CAPACITY_CONCURRENCY_SAMPLE_GAP_MISMATCH", failures);

  const liveModel = objectValue(telemetry.live_model);
  if (liveModel.query_reference !== derived.query_references?.live_model
    || liveModel.provider !== binding.llmProvider || liveModel.model !== binding.llmModel) failures.push("CAPACITY_LIVE_MODEL_BINDING_MISMATCH");
  for (const [field, expected] of [
    ["attempt_count", derived.live_model?.attempts], ["success_count", derived.live_model?.success],
    ["success_rate", derived.live_model?.success_rate], ["token_count", derived.live_model?.tokens],
    ["peak_requests_per_minute", derived.live_model?.peak_requests_per_minute],
    ["peak_tokens_per_minute", derived.live_model?.peak_tokens_per_minute]
  ]) compareTelemetryNumber(liveModel[field], expected, `CAPACITY_LIVE_MODEL_${field.toUpperCase()}_MISMATCH`, failures);

  const graph = objectValue(telemetry.graphrag);
  if (graph.query_reference !== derived.query_references?.graphrag
    || graph.cache_query_reference !== derived.query_references?.graphrag_cache
    || graph.engine !== "official_graphrag_3_1_1"
    || graph.knowledge_release_id !== binding.knowledgeReleaseId || graph.index_version !== binding.indexVersion
    || graph.knowledge_manifest_sha256 !== binding.knowledgeManifestSha256) failures.push("CAPACITY_GRAPHRAG_BINDING_MISMATCH");
  for (const [field, expected] of [
    ["attempt_count", derived.graphrag?.attempts], ["success_count", derived.graphrag?.success],
    ["success_rate", derived.graphrag?.success_rate], ["cache_miss_count", derived.graphrag?.cache_misses],
    ["cache_miss_ratio", derived.graphrag?.cache_miss_ratio]
  ]) compareTelemetryNumber(graph[field], expected, `CAPACITY_GRAPHRAG_${field.toUpperCase()}_MISMATCH`, failures);

  const graphModel = objectValue(telemetry.graphrag_query_model);
  if (graphModel.query_reference !== derived.query_references?.graphrag_query_model
    || graphModel.provider !== binding.graphRagModelProvider || graphModel.model !== binding.graphRagModel) {
    failures.push("CAPACITY_GRAPHRAG_MODEL_BINDING_MISMATCH");
  }
  for (const [field, expected] of [
    ["attempt_count", derived.graphrag_query_model?.attempts], ["success_count", derived.graphrag_query_model?.success],
    ["attempt_coverage", derived.graphrag_query_model?.attempt_coverage],
    ["success_rate", derived.graphrag_query_model?.success_rate], ["token_count", derived.graphrag_query_model?.tokens],
    ["peak_requests_per_minute", derived.graphrag_query_model?.peak_requests_per_minute],
    ["peak_tokens_per_minute", derived.graphrag_query_model?.peak_tokens_per_minute]
  ]) compareTelemetryNumber(graphModel[field], expected, `CAPACITY_GRAPHRAG_MODEL_${field.toUpperCase()}_MISMATCH`, failures);

  const formalTaxonomy = objectValue(telemetry.formal_load_taxonomy);
  const derivedFormalTaxonomy = objectValue(derived.formal_load_taxonomy);
  if (formalTaxonomy.query_reference !== derivedFormalTaxonomy.query_reference
    || formalTaxonomy.manifest_id !== derivedFormalTaxonomy.manifest_id
    || formalTaxonomy.manifest_sha256 !== derivedFormalTaxonomy.manifest_sha256
    || formalTaxonomy.signer_id !== derivedFormalTaxonomy.signer_id
    || formalTaxonomy.signed_payload_sha256 !== derivedFormalTaxonomy.signed_payload_sha256
    || formalTaxonomy.catalog_sha256 !== derivedFormalTaxonomy.catalog_sha256
    || formalTaxonomy.algorithm_version !== FORMAL_LOAD_TAXONOMY_ALGORITHM) {
    failures.push("CAPACITY_FORMAL_LOAD_TAXONOMY_BINDING_MISMATCH");
  }
  for (const [field, expected] of [
    ["applied", derivedFormalTaxonomy.applied],
    ["rejected", derivedFormalTaxonomy.rejected],
    ["application_ratio", derivedFormalTaxonomy.application_ratio]
  ]) compareTelemetryNumber(formalTaxonomy[field], expected, `CAPACITY_FORMAL_LOAD_TAXONOMY_${field.toUpperCase()}_MISMATCH`, failures, 0.000001);

  const providerQuota = validateQuota(attestation.provider_quota, {
    provider:binding.llmProvider,
    model:binding.llmModel
  }, rawWindow, derived.live_model || {}, "CAPACITY_PROVIDER_QUOTA", failures);
  const graphRagProviderQuota = validateQuota(attestation.graphrag_provider_quota, {
    provider:binding.graphRagModelProvider,
    model:binding.graphRagModel
  }, rawWindow, derived.graphrag_query_model || {}, "CAPACITY_GRAPHRAG_PROVIDER_QUOTA", failures);
  const approval = approvedRecord(attestation.approval, "CAPACITY_RELEASE", failures);
  return {
    ok:failures.length === 0,
    failures:[...new Set(failures)],
    telemetry:{ source:"prometheus", export_id:derived.export_id || null, export_sha256:context.prometheusExportSha256 || null, ...derived },
    providerQuota,
    graphRagProviderQuota,
    approval
  };
}

const quotaSummary = (quota) => ({
  approved:quota.approved === true,
  provider:quota.provider || null,
  model:quota.model || null,
  requests_per_minute:Number(quota.requests_per_minute) || 0,
  tokens_per_minute:Number(quota.tokens_per_minute) || 0,
  approval_id:quota.approval_id || null,
  approved_by:quota.approved_by || null,
  approved_at:quota.approved_at || null,
  valid_from:quota.valid_from || null,
  valid_until:quota.valid_until || null
});

export function buildProductionCapacityEvidence(options = {}) {
  const raw = objectValue(options.rawReport);
  const prometheusExport = objectValue(options.prometheusExport);
  const attestation = objectValue(options.attestation);
  const binding = normalizedBinding(options.binding);
  const failures = [...validateImmutableBinding(binding)];
  if (!safeReference(binding.graphRagModelProvider)) failures.push("GRAPHRAG_MODEL_PROVIDER_INVALID");
  if (!safeReference(binding.graphRagModel)) failures.push("GRAPHRAG_MODEL_INVALID");
  const sourceVerifications = objectValue(options.sourceVerifications);
  const requiredTrustedSources = {
    capacity_raw:"capacity_raw",
    capacity_observability_attestation:"capacity_observability_attestation"
  };
  const verifiedSources = {};
  for (const [name, kind] of Object.entries(requiredTrustedSources)) {
    const verification = objectValue(sourceVerifications[name]);
    if (verification.ok !== true || !verification.signer || verification.signer.evidence_kind !== kind) {
      failures.push(`CAPACITY_${name.toUpperCase()}_TRUST_ATTESTATION_INVALID`);
    } else verifiedSources[name] = verification.signer;
  }
  const sourceSignerIds = Object.values(verifiedSources).map((item) => item.signer_id);
  const sourceSignerFingerprints = Object.values(verifiedSources).map((item) => item.public_key_spki_sha256);
  if (sourceSignerIds.length !== Object.keys(requiredTrustedSources).length
    || new Set(sourceSignerIds).size !== sourceSignerIds.length) failures.push("CAPACITY_TRUST_AUTHORITIES_NOT_INDEPENDENT");
  if (sourceSignerFingerprints.length !== Object.keys(requiredTrustedSources).length
    || sourceSignerFingerprints.some((item) => !validSha256(item))
    || new Set(sourceSignerFingerprints).size !== sourceSignerFingerprints.length) {
    failures.push("CAPACITY_TRUST_SIGNING_KEYS_NOT_INDEPENDENT");
  }
  if (!productionEnvironments.has(binding.environment)) failures.push("CAPACITY_ENVIRONMENT_NOT_FORMAL");
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(binding.tenantId)) failures.push("CAPACITY_TENANT_INVALID");
  if (!validSha256(options.rawReportSha256)) failures.push("CAPACITY_RAW_REPORT_SHA256_INVALID");
  if (!validSha256(options.prometheusExportSha256)) failures.push("CAPACITY_PROMETHEUS_EXPORT_SHA256_INVALID");
  if (!validSha256(options.attestationSha256)) failures.push("CAPACITY_ATTESTATION_SHA256_INVALID");
  const rawValidation = validateRawCapacityReport(raw, { ...options.thresholds, tenantId:binding.tenantId, binding });
  failures.push(...rawValidation.failures);
  const prometheusValidation = validatePrometheusCapacityExport(prometheusExport, {
    binding,
    rawReport:raw,
    rawValidation,
    thresholds:options.thresholds
  });
  failures.push(...prometheusValidation.failures);
  const attestationValidation = validateCapacityAttestation(attestation, {
    binding,
    rawReport:raw,
    rawReportSha256:String(options.rawReportSha256 || "").toLowerCase(),
    rawValidation,
    prometheusExport,
    prometheusExportSha256:String(options.prometheusExportSha256 || "").toLowerCase(),
    prometheusValidation,
    thresholds:options.thresholds
  });
  failures.push(...attestationValidation.failures);
  const passed = failures.length === 0;
  const metrics = rawValidation.metrics;
  const telemetry = attestationValidation.telemetry;
  const approval = attestationValidation.approval;
  return {
    schema_version:PRODUCTION_CAPACITY_SCHEMA,
    evidence_class:"real_20_user_live_model_soak",
    formal_acceptance_eligible:passed,
    release_id:binding.releaseId,
    knowledge_release_id:binding.knowledgeReleaseId,
    environment:binding.environment,
    generated_at:options.generatedAt || new Date().toISOString(),
    tenant_id:binding.tenantId,
    application_image:binding.applicationImage,
    graphrag_image:binding.graphRagImage,
    index_version:binding.indexVersion,
    knowledge_manifest_sha256:binding.knowledgeManifestSha256,
    raw_report_path:options.rawReportPath || null,
    raw_report_sha256:String(options.rawReportSha256 || "").toLowerCase() || null,
    prometheus_export_path:options.prometheusExportPath || null,
    prometheus_export_sha256:String(options.prometheusExportSha256 || "").toLowerCase() || null,
    attestation_sha256:String(options.attestationSha256 || "").toLowerCase() || null,
    verified_sources:verifiedSources,
    concurrent_users:metrics.concurrent_users,
    duration_seconds:metrics.steady_state_duration_seconds,
    llm:{
      enabled:Number(telemetry.live_model?.attempts || 0) > 0,
      provider:binding.llmProvider,
      model:binding.llmModel,
      attempt_count:telemetry.live_model?.attempts || 0,
      request_count:telemetry.live_model?.attempts || 0,
      success_count:telemetry.live_model?.success || 0,
      success_rate:telemetry.live_model?.success_rate || 0
    },
    active_knowledge:{
      release_id:binding.knowledgeReleaseId,
      index_version:binding.indexVersion,
      manifest_sha256:binding.knowledgeManifestSha256,
      engine:"official_graphrag_3_1_1",
      attempt_count:telemetry.graphrag?.attempts || 0,
      query_count:telemetry.graphrag?.attempts || 0,
      success_count:telemetry.graphrag?.success || 0,
      success_rate:telemetry.graphrag?.success_rate || 0,
      cache_miss_count:telemetry.graphrag?.cache_misses || 0,
      cache_miss_ratio:telemetry.graphrag?.cache_miss_ratio || 0
    },
    graphrag_query_model:{
      provider:binding.graphRagModelProvider,
      model:binding.graphRagModel,
      attempt_count:telemetry.graphrag_query_model?.attempts || 0,
      success_count:telemetry.graphrag_query_model?.success || 0,
      attempt_coverage:telemetry.graphrag_query_model?.attempt_coverage || 0,
      success_rate:telemetry.graphrag_query_model?.success_rate || 0
    },
    formal_load_taxonomy:{
      manifest_id:telemetry.formal_load_taxonomy?.manifest_id || null,
      manifest_sha256:telemetry.formal_load_taxonomy?.manifest_sha256 || null,
      signer_id:telemetry.formal_load_taxonomy?.signer_id || null,
      signed_payload_sha256:telemetry.formal_load_taxonomy?.signed_payload_sha256 || null,
      catalog_sha256:telemetry.formal_load_taxonomy?.catalog_sha256 || null,
      algorithm_version:telemetry.formal_load_taxonomy?.algorithm_version || null,
      applied:telemetry.formal_load_taxonomy?.applied || 0,
      rejected:telemetry.formal_load_taxonomy?.rejected || 0,
      application_ratio:telemetry.formal_load_taxonomy?.application_ratio || 0,
      distinct_entry_count:metrics.formal_load_taxonomy?.distinct_entry_count || 0,
      entry_ids_sha256:metrics.formal_load_taxonomy?.entry_ids_sha256 || null
    },
    provider_quota:quotaSummary(attestationValidation.providerQuota),
    graphrag_provider_quota:quotaSummary(attestationValidation.graphRagProviderQuota),
    metrics:{
      raw:{
        requested_duration_seconds:metrics.requested_duration_seconds,
        actual_duration_seconds:metrics.actual_duration_seconds,
        ramp_seconds:metrics.ramp_seconds,
        steady_state_duration_seconds:metrics.steady_state_duration_seconds,
        requests:metrics.requests,
        success:metrics.success,
        error_rate:metrics.error_rate,
        throughput_rps:metrics.throughput_rps,
        latency_ms:metrics.latency_ms,
        latency_sample_count:metrics.latency_sample_count,
        turn_latency_p95_ms:metrics.turn_latency_p95_ms,
        minute_buckets:metrics.minute_buckets,
        status_counts:metrics.status_counts,
        query_diversity:metrics.query_diversity,
        formal_load_taxonomy:metrics.formal_load_taxonomy,
        load_identity:metrics.load_identity
      },
      telemetry,
      thresholds:rawValidation.thresholds
    },
    approval:passed ? {
      status:"approved",
      approval_id:approval.approval_id,
      approved_by:approval.approved_by,
      approved_at:approval.approved_at
    } : {
      status:"blocked",
      approval_id:approval.approval_id || null,
      approved_by:approval.approved_by || null,
      approved_at:approval.approved_at || null
    },
    acceptance:{
      passed,
      failures:[...new Set(failures)],
      raw_report_passed:rawValidation.ok,
      prometheus_export_passed:prometheusValidation.ok,
      independent_attestation_passed:attestationValidation.ok
    },
    passed
  };
}

export async function runProductionCapacityCli(options = {}) {
  const env = options.env || process.env;
  const binding = productionCapacityBindingFromEnv(env);
  const rawPath = String(options.raw || env.HUAMEI_FORMAL_CAPACITY_RAW_PATH || "");
  const rawSha = String(options["raw-sha256"] || env.HUAMEI_FORMAL_CAPACITY_RAW_SHA256 || "");
  const prometheusPath = String(options.prometheus || env.HUAMEI_FORMAL_CAPACITY_PROMETHEUS_PATH || "");
  const prometheusSha = String(options["prometheus-sha256"] || env.HUAMEI_FORMAL_CAPACITY_PROMETHEUS_SHA256 || "");
  const attestationPath = String(options.attestation || env.HUAMEI_FORMAL_CAPACITY_ATTESTATION_PATH || "");
  const attestationSha = String(options["attestation-sha256"] || env.HUAMEI_FORMAL_CAPACITY_ATTESTATION_SHA256 || "");
  const rawEvidence = await readJsonWithSha({ path:rawPath, expectedSha:rawSha, label:"CAPACITY_RAW_REPORT" });
  const prometheusEvidence = await readJsonWithSha({ path:prometheusPath, expectedSha:prometheusSha, label:"CAPACITY_PROMETHEUS_EXPORT" });
  const attestationEvidence = await readJsonWithSha({ path:attestationPath, expectedSha:attestationSha, label:"CAPACITY_ATTESTATION" });
  const trustedSigners = trustedSignerRegistryFromEnv(env);
  const rawVerification = verifyEvidenceDocumentAttestation(rawEvidence.document, {
    evidenceKind:"capacity_raw",
    trustedSigners
  });
  const attestationVerification = verifyEvidenceDocumentAttestation(attestationEvidence.document, {
    evidenceKind:"capacity_observability_attestation",
    trustedSigners
  });
  const report = buildProductionCapacityEvidence({
    rawReport:rawEvidence.document,
    rawReportPath:rawPath,
    rawReportSha256:rawEvidence.sha256,
    prometheusExport:prometheusEvidence.document,
    prometheusExportPath:prometheusPath,
    prometheusExportSha256:prometheusEvidence.sha256,
    attestation:attestationEvidence.document,
    attestationSha256:attestationEvidence.sha256,
    sourceVerifications:{
      capacity_raw:rawVerification,
      capacity_observability_attestation:attestationVerification
    },
    binding
  });
  const output = String(options.output || env.HUAMEI_RELEASE_CAPACITY_REPORT_PATH || "");
  if (!isAbsolute(output)) throw evidenceError("CAPACITY_OUTPUT_ABSOLUTE_PATH_REQUIRED");
  if ([rawPath, prometheusPath, attestationPath].includes(output)) throw evidenceError("CAPACITY_OUTPUT_MUST_NOT_OVERWRITE_INPUT");
  const signedReport = await signEvidenceDocumentFromEnv(report, {
    env,
    prefix:"HUAMEI_FORMAL_CAPACITY_REPORT",
    evidenceKind:"capacity_report"
  });
  const written = await writeJsonAtomic(output, signedReport);
  return { report:written, passed:report.passed, failures:report.acceptance.failures };
}

if (mainModule(import.meta.url)) {
  try {
    const result = await runProductionCapacityCli(parseCliOptions());
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status:"blocked", code:error.code || "FORMAL_CAPACITY_FAILED", details:error.details || null }));
    process.exitCode = 1;
  }
}
