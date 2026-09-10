import { retrieveGraphRagKnowledge, readGraphRagConfig } from "../graphrag-client.mjs";
import { loadHuameiKnowledge } from "../huamei-knowledge.mjs";
import { completeAgentWithLlm, readLlmConfig } from "../llm-client.mjs";

const PROBE_AGENT = {
  id:"A-06",
  name:"生产依赖探测",
  role:"只验证模型服务可达性，不处理客户数据"
};
const PROBE_MESSAGE = "服务就绪探测通过。";
const OFFICIAL_GRAPHRAG_ENGINE = "official_graphrag_3_1_1";
const SAFE_PROBE_TERM = /^[\p{L}\p{N}][\p{L}\p{N}_.+··®™()-]{1,39}$/u;
const FILE_NAME_SUFFIX = /\.[A-Za-z0-9]{1,8}$/;

const state = {
  key:"",
  checkedAt:0,
  report:null,
  inflight:null
};

const clamp = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
};

const releaseBinding = (domain = {}) => {
  const release = domain.knowledge_admission?.active_release || {};
  return {
    tenantId:String(domain.knowledge_admission?.tenant_id || domain.tenant_id || "huamei-shanghai"),
    releaseId:String(release.id || ""),
    indexVersion:String(release.index_version || release.manifest?.index_version || ""),
    approvedRecordIds:[...new Set((release.approved_record_ids || []).map(String).filter(Boolean))]
  };
};

const readinessProbeRecord = (binding, env, injectedRecord = null) => {
  if (injectedRecord) return injectedRecord;
  const knowledge = loadHuameiKnowledge();
  if (!knowledge.loaded) return null;
  const configuredId = String(env.HUAMEI_GRAPHRAG_READINESS_RECORD_ID || "").trim();
  const candidateIds = configuredId ? [configuredId] : binding.approvedRecordIds;
  const approvedIds = new Set(binding.approvedRecordIds);
  for (const recordId of candidateIds) {
    if (!approvedIds.has(recordId)) continue;
    const record = knowledge.publicRecords.find((item) => item.record_id === recordId);
    if (!record) continue;
    return {
      record_id:record.record_id,
      record_type:record.record_type,
      title:record.title,
      source_relative_path:record.source_relative_path,
      record_content_sha256:record.record_content_sha256
    };
  }
  return null;
};

export function buildGraphRagReadinessQuery(probeRecord) {
  // The probe query may contain only immutable catalog path terms. Never put a
  // title, free text, timestamp, request ID, or cache-busting nonce in the
  // query because official GraphRAG can forward it to its query model.
  const sourcePath = String(probeRecord?.source_relative_path || "").normalize("NFKC").trim();
  const segments = sourcePath.split("/").map((part) => part.trim()).filter(Boolean);
  if (segments.length && FILE_NAME_SUFFIX.test(segments.at(-1))) segments.pop();
  const terms = segments.filter((term) => SAFE_PROBE_TERM.test(term)).slice(-4);
  if (!terms.length) {
    const error = new Error("GraphRAG readiness record has no approved safe taxonomy path");
    error.code = "GRAPHRAG_READINESS_QUERY_UNSAFE";
    throw error;
  }
  return terms.join(" ");
}

const groundedGraphProbeFailure = (result, binding, probeRecord) => {
  if (result?.used !== true) return result?.reason || "GRAPHRAG_READINESS_PROBE_FAILED";
  if (result.engine !== OFFICIAL_GRAPHRAG_ENGINE) return "GRAPHRAG_OFFICIAL_ENGINE_REQUIRED";
  if (result.indexVersion !== binding.indexVersion) return "GRAPHRAG_INDEX_BINDING_MISMATCH";
  if (!probeRecord || !binding.approvedRecordIds.includes(probeRecord.record_id)) {
    return "GRAPHRAG_READINESS_RECORD_NOT_APPROVED";
  }
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  if (!evidence.length) return "GRAPHRAG_GROUNDED_PROBE_FAILED";
  const approvedIds = new Set(binding.approvedRecordIds);
  if (evidence.some((item) => !approvedIds.has(String(item?.record_id || "")))) {
    return "GRAPHRAG_UNAPPROVED_EVIDENCE";
  }
  const grounded = evidence.find((item) => String(item?.record_id || "") === probeRecord.record_id);
  if (!grounded
    || !String(grounded.title || "").trim()
    || !String(grounded.source_relative_path || "").trim()
    || !String(grounded.content || "").trim()
    || grounded.metadata?.official_context !== true
    || String(grounded.metadata?.record_content_sha256 || "") !== probeRecord.record_content_sha256) {
    return "GRAPHRAG_GROUNDED_PROBE_FAILED";
  }
  return null;
};

const failedCheck = (status, errorCode) => ({
  ok:false,
  status,
  error_code:String(errorCode || "DEPENDENCY_UNAVAILABLE").slice(0, 120)
});

export async function probeProductionExternalDependencies(options = {}) {
  const env = options.env || process.env;
  const graphConfig = readGraphRagConfig(env);
  const llmConfig = readLlmConfig(env);
  const binding = releaseBinding(options.domain);
  const probeRecord = readinessProbeRecord(binding, env, options.probeRecord);
  let probeQuery = "";
  try { probeQuery = buildGraphRagReadinessQuery(probeRecord); }
  catch {}
  const maximumAgeMs = clamp(env.HUAMEI_EXTERNAL_DEPENDENCY_READINESS_MAX_AGE_MS, 20_000, 5_000, 120_000);
  const failureCacheMs = clamp(env.HUAMEI_EXTERNAL_DEPENDENCY_FAILURE_CACHE_MS, 5_000, 1_000, 30_000);
  const probeTimeoutMs = clamp(env.HUAMEI_EXTERNAL_DEPENDENCY_PROBE_TIMEOUT_MS, 4_000, 2_000, 8_000);
  const key = JSON.stringify([
    binding.tenantId,
    binding.releaseId,
    binding.indexVersion,
    graphConfig.baseUrl,
    llmConfig.baseUrl,
    llmConfig.model,
    probeRecord?.record_id || "",
    probeRecord?.record_content_sha256 || "",
    probeQuery,
    binding.approvedRecordIds
  ]);
  const now = Date.now();
  if (!options.force && state.key === key && state.report) {
    const cacheFor = state.report.ok ? maximumAgeMs : failureCacheMs;
    if (now - state.checkedAt <= cacheFor) return { ...state.report, cached:true };
  }
  if (!options.force && state.key === key && state.inflight) return state.inflight;

  const operation = (async () => {
    const checks = {};
    if (!binding.releaseId || !binding.indexVersion) {
      checks.knowledge_binding = failedCheck("not_ready", "ACTIVE_KNOWLEDGE_BINDING_REQUIRED");
    } else if (!probeRecord || !binding.approvedRecordIds.includes(String(probeRecord.record_id || ""))) {
      checks.knowledge_binding = failedCheck("not_ready", "GRAPHRAG_READINESS_RECORD_NOT_APPROVED");
    } else if (!probeQuery) {
      checks.knowledge_binding = failedCheck("not_ready", "GRAPHRAG_READINESS_QUERY_UNSAFE");
    } else {
      checks.knowledge_binding = {
        ok:true,
        status:"bound",
        release_id:binding.releaseId,
        index_version:binding.indexVersion,
        readiness_record_id:probeRecord.record_id
      };
    }
    if (!graphConfig.enabled || !graphConfig.configured) {
      checks.graphrag = failedCheck("not_configured", "GRAPHRAG_PRODUCTION_CONFIGURATION_REQUIRED");
    }
    if (!llmConfig.enabled || !llmConfig.configured) {
      checks.llm = failedCheck("not_configured", "LLM_PRODUCTION_CONFIGURATION_REQUIRED");
    }

    const probes = [];
    if (checks.knowledge_binding.ok && !checks.graphrag) {
      probes.push((async () => {
        const result = await (options.graphRetriever || retrieveGraphRagKnowledge)(
          probeQuery,
          {
            env,
            tenantId:binding.tenantId,
            releaseId:binding.releaseId,
            indexVersion:binding.indexVersion,
            topK:1,
            readinessProbe:true,
            requestId:`readiness-graph-${Date.now()}`
          }
        );
        const failure = groundedGraphProbeFailure(result, binding, probeRecord);
        checks.graphrag = failure
          ? failedCheck("unavailable", failure)
          : {
              ok:true,
              status:"grounded",
              engine:result.engine,
              index_version:result.indexVersion,
              record_id:probeRecord.record_id
            };
      })());
    }
    if (!checks.llm) {
      probes.push((async () => {
        try {
          const completion = await (options.llmCompleter || completeAgentWithLlm)({
            agent:PROBE_AGENT,
            input:{ message:"执行不含客户数据的服务就绪探测", mode:"assist" },
            context:{ macro_stage:"系统", micro_stage:"就绪探测", interests:[] },
            localResult:{
              status:"completed",
              message:PROBE_MESSAGE,
              structured_data:{ probe:true },
              recommended_actions:[],
              handover:{ required:false },
              citations:[]
            },
            env:{ ...env, HUAMEI_LLM_TIMEOUT_MS:String(probeTimeoutMs), HUAMEI_LLM_MAX_RETRIES:"0" }
          });
          checks.llm = completion?.used === true
            ? { ok:true, status:"reachable", provider:completion.usage?.provider || llmConfig.provider, model:completion.usage?.model || llmConfig.model }
            : failedCheck("unavailable", completion?.reason || "LLM_READINESS_PROBE_FAILED");
        } catch (error) {
          checks.llm = failedCheck("unavailable", error?.code || error?.name || "LLM_READINESS_PROBE_FAILED");
        }
      })());
    }
    await Promise.allSettled(probes);
    if (!checks.graphrag) checks.graphrag = failedCheck("unavailable", "GRAPHRAG_READINESS_PROBE_FAILED");
    if (!checks.llm) checks.llm = failedCheck("unavailable", "LLM_READINESS_PROBE_FAILED");
    const ok = Object.values(checks).every((check) => check.ok === true);
    const report = {
      ok,
      status:ok ? "ready" : "not_ready",
      checks,
      checked_at:new Date().toISOString(),
      cached:false
    };
    state.key = key;
    state.checkedAt = Date.now();
    state.report = report;
    return report;
  })();
  state.key = key;
  state.inflight = operation;
  try { return await operation; }
  finally {
    if (state.inflight === operation) state.inflight = null;
  }
}

export function resetExternalDependencyReadinessForTest() {
  Object.assign(state, { key:"", checkedAt:0, report:null, inflight:null });
}
