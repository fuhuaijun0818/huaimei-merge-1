import {
  LANGGRAPH_AUDIENCE,
  assertLangGraphTurnDecision,
  createLangGraphTurnRequest,
  issueLangGraphServiceToken
} from "./langgraph-orchestrator-contract.mjs";

const normalizedEngine = (value) => ["legacy", "shadow", "langgraph"].includes(String(value || "").trim().toLowerCase())
  ? String(value).trim().toLowerCase()
  : "legacy";
const explicitlyEnabled = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

export function readLangGraphOrchestratorConfig(env = process.env) {
  const engine = normalizedEngine(env.HUAMEI_AGENT_ENGINE);
  const baseUrl = String(env.HUAMEI_LANGGRAPH_ORCHESTRATOR_URL || "").trim().replace(/\/+$/, "");
  const shadowAdmitted = explicitlyEnabled(env.HUAMEI_LANGGRAPH_SHADOW_ADMITTED);
  return {
    engine,
    // P0-A only permits explicitly admitted shadow calls. The LangGraph
    // customer-delivery engine is deliberately unavailable until the later
    // turn-commit, durable checkpoint and production admission gates pass.
    shadowAdmitted,
    enabled:engine === "shadow" && shadowAdmitted && Boolean(baseUrl),
    baseUrl,
    serviceAuthSecret:String(env.HUAMEI_LANGGRAPH_SERVICE_AUTH_SECRET || "").trim(),
    threadSecret:String(env.HUAMEI_LANGGRAPH_THREAD_SECRET || "").trim(),
    audience:String(env.HUAMEI_LANGGRAPH_AUDIENCE || LANGGRAPH_AUDIENCE).trim(),
    timeoutMs:Math.max(250, Math.min(10_000, Number(env.HUAMEI_LANGGRAPH_TIMEOUT_MS || 4_000))),
    graphVersion:String(env.HUAMEI_LANGGRAPH_GRAPH_VERSION || "v1").trim(),
    stateSchemaVersion:String(env.HUAMEI_LANGGRAPH_STATE_SCHEMA_VERSION || "v1").trim()
  };
}

export async function requestLangGraphTurn(input, options = {}) {
  const env = options.env || process.env;
  const config = readLangGraphOrchestratorConfig(env);
  if (config.engine === "legacy") return { used:false, reason:"legacy_engine", decision:null };
  if (config.engine === "langgraph") return { used:false, reason:"langgraph_delivery_not_admitted", decision:null };
  if (!config.shadowAdmitted) return { used:false, reason:"shadow_not_admitted", decision:null };
  if (!config.enabled) return { used:false, reason:"orchestrator_unavailable", decision:null };
  if (config.serviceAuthSecret.length < 32 || config.threadSecret.length < 32) {
    const error = new Error("LangGraph service identity is not configured");
    error.code = "LANGGRAPH_SERVICE_IDENTITY_NOT_READY";
    throw error;
  }
  const { request, threadId } = createLangGraphTurnRequest({
    ...input,
    enginePin:{ engine:config.engine, graph_version:config.graphVersion, state_schema_version:config.stateSchemaVersion },
    threadSecret:config.threadSecret
  });
  const token = issueLangGraphServiceToken({
    secret:config.serviceAuthSecret,
    tenantId:request.turn.tenant_id,
    audience:config.audience,
    authorizationContext:request.authorization_context
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await (options.fetchImpl || fetch)(`${config.baseUrl}/internal/v1/orchestrate`, {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        Accept:"application/json",
        Authorization:`Bearer ${token}`,
        "X-Request-Id":String(input.traceId || "").slice(0, 160)
      },
      body:JSON.stringify(request),
      signal:controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.detail?.code || "LangGraph orchestrator request failed");
      error.code = body?.detail?.code || "LANGGRAPH_ORCHESTRATOR_ERROR";
      error.status = response.status;
      throw error;
    }
    return {
      used:true,
      threadId,
      decision:assertLangGraphTurnDecision(body, { stateSchemaVersion:config.stateSchemaVersion })
    };
  } catch (cause) {
    if (cause?.name === "AbortError") {
      const error = new Error("LangGraph orchestrator timed out");
      error.code = "LANGGRAPH_ORCHESTRATOR_TIMEOUT";
      throw error;
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}
