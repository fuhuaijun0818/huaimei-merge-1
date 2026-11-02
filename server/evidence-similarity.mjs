import { getObservability, outboundTraceHeaders } from "./observability/index.mjs";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MIN_CLAUSE_SCORE = 0.6;
const FACTUAL_ANCHOR = /\d|射频|单极|双极|激光|超声|胶原|线材|植入|玻尿酸|肉毒|麻醉|局麻|全麻|填充|注射|切口|脂肪|假体|认证|获奖|医生|院长|价格|报价|费用|优惠|活动|排班|出诊/;
const META_DISCLAIMER = /具体(?:方案|价格|费用|安排|适用).*(?:面诊|确认|核验|为准)|以.*为准|因人而异|需要.*(?:医生|顾问|人工)|建议.*(?:面诊|医生)|由.*(?:医生|顾问).*(?:确认|评估)/;
const observability = getObservability({
  service:process.env.HUAMEI_SERVICE_NAME || "huamei-acquisition",
  environment:process.env.HUAMEI_RUNTIME_ENV || process.env.NODE_ENV || "development"
});

const clamp = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
};

const safeText = (value = "") => String(value || "")
  .replace(/(?<!\d)1\d{10}(?!\d)/g, "[联系方式]")
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[已最小化]")
  .replace(/\b\d{15,18}[0-9Xx]\b/g, "[已最小化]")
  .trim();

export function readEvidenceSimilarityConfig(env = process.env) {
  const baseUrl = String(env.HUAMEI_EVIDENCE_SIMILARITY_URL || env.HUAMEI_GRAPHRAG_URL || "")
    .trim()
    .replace(/\/+$/, "");
  return {
    enabled:String(env.HUAMEI_EVIDENCE_SIMILARITY_ENABLED || "false").toLowerCase() === "true",
    configured:Boolean(baseUrl),
    baseUrl,
    serviceKey:String(env.HUAMEI_GRAPHRAG_SERVICE_KEY || "").trim(),
    timeoutMs:clamp(env.HUAMEI_EVIDENCE_SIMILARITY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_500, 20_000),
    minClauseScore:clamp(env.HUAMEI_EVIDENCE_SIMILARITY_MIN_CLAUSE_SCORE, DEFAULT_MIN_CLAUSE_SCORE, 0, 1),
    blocking:String(env.HUAMEI_EVIDENCE_SIMILARITY_BLOCKING || "true").toLowerCase() === "true"
  };
}

const factualClause = (clause = "") => {
  const text = String(clause || "").trim();
  return text.length >= 4
    && !/[？?]$/.test(text)
    && FACTUAL_ANCHOR.test(text)
    && !META_DISCLAIMER.test(text);
};

export async function checkEvidenceSimilarity({
  answer,
  documents = [],
  fetchImpl = fetch,
  env = process.env
}) {
  const config = readEvidenceSimilarityConfig(env);
  if (!config.enabled) return { used:false, enabled:false, reason:"disabled", passed:true, blocking:config.blocking };
  if (!config.configured) return { used:false, enabled:true, reason:"not_configured", passed:true, blocking:config.blocking };
  const safeAnswer = safeText(answer).slice(0, 4_000);
  const inputDocuments = (Array.isArray(documents) ? documents : [])
    .map((document) => ({
      id:String(document.label || document.knowledge_id || "").trim(),
      text:safeText(document.content).slice(0, 8_000)
    }))
    .filter((document) => document.id && document.text)
    .slice(0, 10);
  if (!safeAnswer || !inputDocuments.length) {
    return { used:false, enabled:true, reason:"insufficient_input", passed:true, blocking:config.blocking };
  }
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/semantic-similarity`, {
      method:"POST",
      headers:outboundTraceHeaders({
        "Content-Type":"application/json",
        Accept:"application/json",
        ...(config.serviceKey ? { "X-Service-Key":config.serviceKey } : {})
      }),
      body:JSON.stringify({ answer:safeAnswer, documents:inputDocuments }),
      signal:AbortSignal.timeout(config.timeoutMs)
    });
    if (!response.ok) {
      return {
        used:false,
        enabled:true,
        reason:`http_${response.status}`,
        passed:true,
        blocking:config.blocking,
        latency_ms:Number((performance.now() - startedAt).toFixed(2))
      };
    }
    const body = await response.json();
    const clauses = Array.isArray(body?.clauses) ? body.clauses : [];
    if (!clauses.length || clauses.some((item) => !Number.isFinite(Number(item?.max_score)))) {
      return {
        used:false,
        enabled:true,
        reason:"invalid_response",
        passed:true,
        blocking:config.blocking,
        latency_ms:Number((performance.now() - startedAt).toFixed(2))
      };
    }
    const checkedClauses = clauses.map((item) => ({
      clause:String(item.clause || "").slice(0, 500),
      score:Number(item.max_score),
      best_document_id:String(item.best_document_id || ""),
      factual:factualClause(item.clause),
      passed:!factualClause(item.clause) || Number(item.max_score) >= config.minClauseScore
    }));
    const lowClauses = checkedClauses.filter((item) => !item.passed);
    const result = {
      used:true,
      enabled:true,
      reason:null,
      provider:"graphrag_embedding",
      model:String(body.model || "").slice(0, 160),
      dimensions:Number(body.dimensions) || null,
      cache_hit:body.cache_hit === true,
      latency_ms:Number((performance.now() - startedAt).toFixed(2)),
      answer_similarity:Number(body.answer_similarity) || 0,
      min_clause_similarity:Number(body.min_clause_similarity) || 0,
      mean_clause_similarity:Number(body.mean_clause_similarity) || 0,
      min_clause_score:config.minClauseScore,
      blocking:config.blocking,
      passed:lowClauses.length === 0,
      checked_clause_count:checkedClauses.filter((item) => item.factual).length,
      low_clauses:lowClauses.slice(0, 5),
      clauses:checkedClauses.slice(0, 8)
    };
    observability.logger.info("evidence.similarity.completed", {
      provider:result.provider,
      model:result.model,
      passed:result.passed,
      blocking:result.blocking,
      latency_ms:result.latency_ms,
      checked_clause_count:result.checked_clause_count
    });
    return result;
  } catch (error) {
    observability.logger.error("evidence.similarity.failed", {
      reason:error?.code || error?.name || "similarity_unavailable",
      error
    });
    return {
      used:false,
      enabled:true,
      reason:error?.code || error?.name || "similarity_unavailable",
      passed:true,
      blocking:config.blocking,
      latency_ms:Number((performance.now() - startedAt).toFixed(2))
    };
  }
}
