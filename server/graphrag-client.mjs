import { createHash } from "node:crypto";
import { getObservability, outboundTraceHeaders } from "./observability/index.mjs";
import { loadHuameiKnowledge, officialKnowledgeRecordText } from "./huamei-knowledge.mjs";

const DEFAULT_TIMEOUT_MS = 1_500;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 15_000;
const OFFICIAL_GRAPHRAG_ENGINE = "official_graphrag_3_1_1";
const graphRagObservability = getObservability({
  service:process.env.HUAMEI_SERVICE_NAME || "huamei-acquisition",
  environment:process.env.HUAMEI_RUNTIME_ENV || process.env.NODE_ENV || "development"
});

const state = {
  calls:0,
  successes:0,
  failures:0,
  timeouts:0,
  cacheHits:0,
  consecutiveFailures:0,
  circuitOpenedAt:0,
  lastError:null,
  lastSuccessAt:null,
  lastEngine:null,
  lastIndexVersion:null,
  inflight:new Map()
};

const clamp = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
};

export function readGraphRagConfig(env = process.env) {
  const baseUrl = String(env.HUAMEI_GRAPHRAG_URL || "").trim().replace(/\/+$/, "");
  return {
    enabled:String(env.HUAMEI_GRAPHRAG_ENABLED || "false").toLowerCase() === "true",
    configured:Boolean(baseUrl),
    baseUrl,
    serviceKey:String(env.HUAMEI_GRAPHRAG_SERVICE_KEY || "").trim(),
    timeoutMs:clamp(env.HUAMEI_GRAPHRAG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 200, 45_000),
    topK:clamp(env.HUAMEI_GRAPHRAG_TOP_K, 6, 1, 12)
  };
}

const circuitOpen = () => state.circuitOpenedAt > 0 && Date.now() - state.circuitOpenedAt < CIRCUIT_OPEN_MS;

const validateBaseUrl = (baseUrl) => {
  const parsed = new URL(baseUrl);
  const local = ["127.0.0.1", "localhost", "::1", "graphrag"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    const error = new Error("GraphRAG非本机地址必须使用HTTPS");
    error.code = "GRAPHRAG_INSECURE_URL";
    throw error;
  }
};

const markFailure = (error) => {
  state.failures += 1;
  state.consecutiveFailures += 1;
  state.lastError = error?.code || error?.name || "GRAPHRAG_ERROR";
  if (["AbortError", "TimeoutError"].includes(error?.name)) state.timeouts += 1;
  if (state.consecutiveFailures >= FAILURE_THRESHOLD) state.circuitOpenedAt = Date.now();
};

const markSuccess = (body) => {
  state.successes += 1;
  state.consecutiveFailures = 0;
  state.circuitOpenedAt = 0;
  state.lastError = null;
  state.lastSuccessAt = new Date().toISOString();
  state.cacheHits += Number(body.cache_hit === true);
  state.lastEngine = body.engine || null;
  state.lastIndexVersion = body.index_version || null;
};

const normalizeApprovedText = (value) => String(value || "")
  .normalize("NFKC")
  .replace(/\r\n/g, "\n")
  .replace(/\r/g, "\n")
  .trim();

const normalizeApprovedContentFingerprint = (value) => normalizeApprovedText(value)
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "");

const integrityError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const canonicalizeOfficialEvidence = (body, options = {}) => {
  if (String(body.engine || "") !== OFFICIAL_GRAPHRAG_ENGINE) {
    throw integrityError("GRAPHRAG_OFFICIAL_ENGINE_REQUIRED", "GraphRAG业务检索必须来自固定的官方引擎");
  }
  const knowledge = options.knowledgeState || loadHuameiKnowledge();
  if (!knowledge?.loaded || !Array.isArray(knowledge.publicRecords)) {
    throw integrityError("GRAPHRAG_CANONICAL_CATALOG_UNAVAILABLE", "本地不可变知识目录不可用");
  }
  const records = new Map(knowledge.publicRecords.map((record) => [String(record.record_id), record]));
  return body.evidence.map((candidate) => {
    const recordId = String(candidate?.record_id || "");
    const canonical = records.get(recordId);
    const candidateExcerpt = String(candidate?.content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    const candidateContent = normalizeApprovedText(candidateExcerpt);
    const approvedText = normalizeApprovedText(canonical ? officialKnowledgeRecordText(canonical) : "");
    const candidateFingerprint = normalizeApprovedContentFingerprint(candidateContent);
    const approvedFingerprint = normalizeApprovedContentFingerprint(approvedText);
    const metadataHash = String(candidate?.metadata?.record_content_sha256 || "").trim().toLowerCase();
    const exactProvenance = canonical
      && String(candidate.record_type || "") === canonical.record_type
      && String(candidate.title || "") === canonical.title
      && String(candidate.source_relative_path || "") === canonical.source_relative_path
      && String(candidate.sensitivity || "") === canonical.sensitivity
      && String(candidate.verification_note || "") === canonical.verification_note;
    if (!canonical
      || candidate?.metadata?.official_context !== true
      || metadataHash !== canonical.record_content_sha256
      || !candidateContent
      || !candidateFingerprint
      || !approvedFingerprint.includes(candidateFingerprint)
      || !exactProvenance) {
      throw integrityError("GRAPHRAG_EVIDENCE_INTEGRITY_REJECTED", "GraphRAG证据未通过本地不可变目录校验");
    }
    // GraphRAG is trusted only to rank immutable record IDs and select a
    // verbatim text unit. Customer-facing provenance is rebuilt from the local
    // catalog, while the exact locally-verified substring is preserved as the
    // citation excerpt so an unrelated section of the same record cannot be
    // substituted after verification.
    return {
      record_id:canonical.record_id,
      record_type:canonical.record_type,
      title:canonical.title,
      content:candidateExcerpt,
      source_relative_path:canonical.source_relative_path,
      sensitivity:canonical.sensitivity,
      verification_note:canonical.verification_note,
      score:Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : 0,
      graph_paths:[],
      metadata:{
        official_context:true,
        record_content_sha256:canonical.record_content_sha256
      }
    };
  });
};

export async function retrieveGraphRagKnowledge(query, options = {}) {
  const config = readGraphRagConfig(options.env || process.env);
  if (!config.enabled) {
    graphRagObservability.observeGraphRag({ mode:"local", outcome:"fallback", durationMs:0 });
    return { used:false, reason:"disabled", evidence:[] };
  }
  if (!config.configured) {
    graphRagObservability.observeGraphRag({ mode:"local", outcome:"fallback", durationMs:0 });
    return { used:false, reason:"not_configured", evidence:[] };
  }
  if (circuitOpen()) {
    graphRagObservability.observeGraphRag({ mode:"local", outcome:"circuit_open", durationMs:0 });
    return { used:false, reason:"circuit_open", evidence:[] };
  }
  validateBaseUrl(config.baseUrl);
  const tenantId = String(options.tenantId || "huamei-shanghai");
  // Match RetrievalRequest.normalize_query exactly. The response must echo the
  // service-side digest so load evidence cannot accidentally hash raw customer
  // text or a different pre-sanitization representation.
  const normalizedQuery = String(query || "").trim().split(/\s+/u).filter(Boolean).join(" ");
  const expectedQuerySha256 = createHash("sha256").update(normalizedQuery, "utf8").digest("hex");
  const releaseId = options.releaseId ? String(options.releaseId) : null;
  const indexVersion = options.indexVersion ? String(options.indexVersion) : null;
  const topK = Math.min(Math.max(Number(options.topK) || config.topK, 1), 12);
  const key = JSON.stringify([tenantId, normalizedQuery.toLowerCase(), releaseId, indexVersion, topK]);
  const existing = state.inflight.get(key);
  if (existing) return existing;
  const operation = (async () => {
    state.calls += 1;
    const startedAt = performance.now();
    try {
      const response = await (options.fetchImpl || fetch)(`${config.baseUrl}/v1/retrieve`, {
        method:"POST",
        headers:outboundTraceHeaders({
          "Content-Type":"application/json",
          Accept:"application/json",
          ...(config.serviceKey ? { "X-Service-Key":config.serviceKey } : {}),
          ...(options.requestId ? { "X-Request-Id":String(options.requestId).slice(0, 128) } : {})
        }),
        body:JSON.stringify({
          tenant_id:tenantId,
          query:normalizedQuery,
          mode:"local",
          top_k:topK,
          release_id:releaseId,
          index_version:indexVersion,
          readiness_probe:options.readinessProbe === true
        }),
        signal:AbortSignal.timeout(config.timeoutMs)
      });
      if (!response.ok) {
        const error = new Error(`GraphRAG HTTP ${response.status}`);
        error.code = response.status === 429
          ? "GRAPHRAG_OVERLOADED"
          : response.status === 409 ? "GRAPHRAG_BINDING_REJECTED" : "GRAPHRAG_HTTP_ERROR";
        throw error;
      }
      const body = await response.json();
      if (!Array.isArray(body.evidence)) {
        const error = new Error("GraphRAG返回结构无效");
        error.code = "GRAPHRAG_INVALID_RESPONSE";
        throw error;
      }
      // A stale or misrouted replica may still answer with HTTP 200.  Do not
      // expose any evidence until the response proves the same tenant/index
      // tuple that was bound to the admitted release in this request.
      const responseTenantId = String(body.tenant_id || "");
      const responseIndexVersion = String(body.index_version || "");
      if (responseTenantId !== tenantId || (indexVersion && responseIndexVersion !== indexVersion)) {
        const error = new Error("GraphRAG返回的租户或索引绑定与请求不一致");
        error.code = "GRAPHRAG_BINDING_REJECTED";
        throw error;
      }
      if (String(body.query_sha256 || "").toLowerCase() !== expectedQuerySha256) {
        const error = new Error("GraphRAG返回的净化查询指纹与实际出站查询不一致");
        error.code = "GRAPHRAG_QUERY_HASH_MISMATCH";
        throw error;
      }
      const evidence = canonicalizeOfficialEvidence(body, options);
      markSuccess(body);
      const durationMs = Math.max(0, performance.now() - startedAt);
      graphRagObservability.observeGraphRag({ mode:"local", outcome:"success", durationMs, cacheHit:body.cache_hit === true });
      graphRagObservability.logger.info("graphrag.query.completed", {
        mode:"local",
        outcome:"success",
        duration_ms:durationMs,
        cache_hit:body.cache_hit === true,
        index_version:String(body.index_version || "unknown").slice(0, 128)
      });
      return {
        used:true,
        reason:null,
        engine:String(body.engine || "unknown").slice(0, 80),
        indexVersion:String(body.index_version || "unknown").slice(0, 128),
        cacheHit:body.cache_hit === true,
        timingMs:Number(body.timing_ms) || null,
        querySha256:expectedQuerySha256,
        graphEntities:[],
        evidence:evidence.slice(0, topK)
      };
    } catch (error) {
      markFailure(error);
      const timeout = ["AbortError", "TimeoutError"].includes(error?.name);
      const outcome = timeout
        ? "timeout"
        : error?.code === "GRAPHRAG_OVERLOADED" ? "overloaded"
          : error?.code === "GRAPHRAG_BINDING_REJECTED" ? "binding_rejected" : "error";
      const durationMs = Math.max(0, performance.now() - startedAt);
      graphRagObservability.observeGraphRag({ mode:"local", outcome, durationMs });
      graphRagObservability.logger.error("graphrag.query.failed", {
        mode:"local",
        outcome,
        duration_ms:durationMs,
        error
      });
      return { used:false, reason:error?.code || (["AbortError", "TimeoutError"].includes(error?.name) ? "timeout" : "unavailable"), evidence:[] };
    }
  })();
  state.inflight.set(key, operation);
  try { return await operation; }
  finally { state.inflight.delete(key); }
}

export function getGraphRagStatus(env = process.env) {
  const config = readGraphRagConfig(env);
  let baseHost = null;
  try { baseHost = config.baseUrl ? new URL(config.baseUrl).host : null; } catch {}
  return {
    enabled:config.enabled,
    configured:config.configured,
    base_host:baseHost,
    timeout_ms:config.timeoutMs,
    circuit:circuitOpen() ? "open" : "closed",
    calls:state.calls,
    successes:state.successes,
    failures:state.failures,
    timeouts:state.timeouts,
    cache_hits:state.cacheHits,
    inflight:state.inflight.size,
    last_error:state.lastError,
    last_success_at:state.lastSuccessAt,
    engine:state.lastEngine,
    index_version:state.lastIndexVersion
  };
}

export function resetGraphRagClientForTest() {
  Object.assign(state, {
    calls:0, successes:0, failures:0, timeouts:0, cacheHits:0,
    consecutiveFailures:0, circuitOpenedAt:0, lastError:null,
    lastSuccessAt:null, lastEngine:null, lastIndexVersion:null
  });
  state.inflight.clear();
}
