import {
  createRequestContext,
  getRequestContext,
  outboundTraceHeaders
} from "./observability/index.mjs";
import { issueExternalTestManagementIdentity, issueLocalManagementIdentity } from "./platform/local-management-identity.mjs";

const SERVICE_URL = String(process.env.HUAMEI_ACQUISITION_SERVICE_URL || "http://127.0.0.1:4180").replace(/\/+$/, "");
const SERVICE_CALLER_SECRET = String(
  process.env.HUAMEI_ACQUISITION_CALLER_SECRET || process.env.HUAMEI_ACQUISITION_SERVICE_KEY || ""
);
const REQUEST_TIMEOUT_MS = Math.max(1_000, Number(process.env.HUAMEI_ACQUISITION_SERVICE_TIMEOUT_MS || 30_000));
const IN_PROCESS = String(process.env.HUAMEI_ACQUISITION_SERVICE_IN_PROCESS || "false").toLowerCase() === "true";
const runtimeEnvironment = String(process.env.HUAMEI_RUNTIME_ENV || process.env.HUAMEI_DEPLOYMENT_ENV || process.env.NODE_ENV || "development").trim().toLowerCase();
const productionRuntime = ["prod", "production"].includes(runtimeEnvironment);

const configuredCallerId = String(process.env.HUAMEI_ACQUISITION_CALLER_ID || "huamei_web_gateway").trim().slice(0, 128);
const SERVICE_CALLER_ID = /^[a-z0-9][a-z0-9_.:@/-]{1,127}$/i.test(configuredCallerId)
  ? configuredCallerId
  : "huamei_web_gateway";
const SERVICE_TENANT_ID = String(
  process.env.HUAMEI_ACQUISITION_TENANT_ID
    || process.env.HUAMEI_PUBLIC_TENANT_ID
    || process.env.HUAMEI_DEFAULT_TENANT_ID
    || "huamei-shanghai"
).trim().toLowerCase();

const serviceHeaders = (requestId, idempotencyKey = "", authorization = "", extra = {}) => outboundTraceHeaders({
  "Content-Type":"application/json",
  ...(requestId ? { "X-Request-Id":requestId } : {}),
  ...(idempotencyKey ? { "Idempotency-Key":idempotencyKey } : {}),
  "X-Caller-Id":SERVICE_CALLER_ID,
  "X-Tenant-Id":SERVICE_TENANT_ID,
  ...(authorization ? { Authorization:authorization } : {}),
  ...(SERVICE_CALLER_SECRET ? { "X-Service-Key":SERVICE_CALLER_SECRET } : {}),
  ...extra
}, getRequestContext() || createRequestContext({
  requestId,
  service:process.env.HUAMEI_GATEWAY_SERVICE_NAME || "huamei-gateway"
}));

const bindServiceTenant = (payload = {}) => {
  const supplied = [payload?.tenant_id, payload?.tenantId, payload?.context?.tenant_id, payload?.context?.tenantId]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (supplied.some((tenantId) => tenantId !== SERVICE_TENANT_ID)) {
    const error = new Error("网关调用方已绑定固定租户，请求不能覆盖tenant_id");
    error.code = "TENANT_ACCESS_DENIED";
    error.status = 403;
    throw error;
  }
  return { ...payload, tenant_id:SERVICE_TENANT_ID };
};

const remoteFetch = async (path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${SERVICE_URL}${path}`, { ...options, signal:controller.signal });
  } catch (cause) {
    const error = new Error(cause?.name === "AbortError" ? "售前智能体服务响应超时" : "售前智能体服务当前不可达");
    error.code = cause?.name === "AbortError" ? "ACQUISITION_SERVICE_TIMEOUT" : "ACQUISITION_SERVICE_UNAVAILABLE";
    error.status = 503;
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const parseResponse = async (response) => {
  let payload;
  try { payload = await response.json(); }
  catch { payload = {}; }
  if (response.ok) return payload;
  const error = new Error(payload.error?.message || "售前智能体服务调用失败");
  error.code = payload.error?.code || "ACQUISITION_SERVICE_ERROR";
  error.details = payload.error?.details || [];
  error.status = response.status;
  throw error;
};

const adminOperationPath = (operation, handoverId = "") => {
  const encodedId = handoverId ? encodeURIComponent(handoverId) : "";
  if (operation === "handovers.list") return "/v1/handovers";
  if (operation === "handovers.get") return `/v1/handovers/${encodedId}`;
  if (operation === "handovers.claim") return `/v1/handovers/${encodedId}/claim`;
  if (operation === "handovers.complete") return `/v1/handovers/${encodedId}/complete`;
  if (operation === "handovers.contact-reveal") return `/v1/handovers/${encodedId}/contact-reveal`;
  if (operation === "human-work.create") return "/v1/operations/human-work";
  if (operation === "feedback.bad-cases.list") return "/v1/feedback/bad-cases";
  if (operation === "feedback.bad-cases.review") return `/v1/feedback/bad-cases/${encodedId}/review`;
  const error = new Error("不支持的人工接管代理操作");
  error.code = "ADMIN_OPERATION_NOT_ALLOWED";
  error.status = 404;
  throw error;
};

export async function callAcquisitionAdminOperation({
  operation,
  handoverId = "",
  tenantId,
  authorization,
  developmentSubject = "",
  payload = {},
  query = {},
  requestId = "",
  idempotencyKey = ""
}) {
  const authorizedTenantId = assertServiceTenant(tenantId);
  const bearer = String(authorization || "").trim();
  let localIdentityHeaders = {};
  if (!/^Bearer\s+\S+/i.test(bearer) && !productionRuntime) {
    const targetUrl = new URL(SERVICE_URL);
    const issueIdentity = String(process.env.HUAMEI_EXTERNAL_TEST_MODE).toLowerCase() === "true"
      ? issueExternalTestManagementIdentity : issueLocalManagementIdentity;
    localIdentityHeaders = issueIdentity({
      env:process.env,
      callerId:SERVICE_CALLER_ID,
      gatewayHost:process.env.HUAMEI_HOST || "127.0.0.1",
      serviceUrl:targetUrl,
      subject:developmentSubject || process.env.HUAMEI_LOCAL_ADMIN_SUBJECT,
      tenantId:authorizedTenantId,
      method:["handovers.claim", "handovers.complete", "handovers.contact-reveal", "human-work.create", "feedback.bad-cases.review"].includes(operation) ? "POST" : "GET",
      pathname:adminOperationPath(operation, handoverId)
    }).headers;
  } else if (!/^Bearer\s+\S+/i.test(bearer)) {
    const error = new Error("Bearer token is required");
    error.code = "OIDC_TOKEN_MISSING";
    error.status = 401;
    throw error;
  }
  const pathname = adminOperationPath(operation, handoverId);
  const target = new URL(`${SERVICE_URL}${pathname}`);
  target.searchParams.set("tenant_id", authorizedTenantId);
  for (const [key, value] of Object.entries(query || {})) {
    if (!["status", "limit"].includes(key) || value === undefined || value === null || String(value).trim() === "") continue;
    target.searchParams.set(key, String(value).slice(0, 80));
  }
  const write = ["handovers.claim", "handovers.complete", "handovers.contact-reveal", "human-work.create", "feedback.bad-cases.review"].includes(operation);
  const response = await remoteFetch(`${target.pathname}${target.search}`, {
    method:write ? "POST" : "GET",
    // Basic auth belongs to the browser-to-gateway boundary. Only a Bearer
    // token or the separately signed internal proof crosses this boundary.
    headers:serviceHeaders(requestId, idempotencyKey, /^Bearer\s+\S+/i.test(bearer) ? bearer : "", localIdentityHeaders),
    ...(write ? { body:JSON.stringify({ ...payload, tenant_id:authorizedTenantId }) } : {})
  });
  return parseResponse(response);
}

export async function callAcquisitionChannel(channel, payload, metadata = {}) {
  const tenantBoundPayload = bindServiceTenant(payload);
  if (IN_PROCESS) {
    const [{ normalizeChannelInbound, formatChannelOutbound }, { processAcquisitionEnvelope }] = await Promise.all([
      import("./acquisition-channel-adapters.mjs"), import("./acquisition-domain-service.mjs")
    ]);
    const envelope = normalizeChannelInbound(channel, tenantBoundPayload);
    return formatChannelOutbound(channel, await processAcquisitionEnvelope(envelope, { ...metadata, caller:SERVICE_CALLER_ID }));
  }
  const response = await remoteFetch(`/v1/channels/${encodeURIComponent(channel)}/inbound`, {
    method:"POST",
    headers:serviceHeaders(metadata.requestId, metadata.idempotencyKey),
    body:JSON.stringify(tenantBoundPayload)
  });
  return parseResponse(response);
}

export async function submitAcquisitionConversationFeedback(payload, metadata = {}) {
  const tenantBoundPayload = bindServiceTenant(payload);
  if (IN_PROCESS) {
    const { createConversationFeedback } = await import("./acquisition-feedback-store.mjs");
    const created = createConversationFeedback(tenantBoundPayload);
    return { data:created.feedback, meta:{ replayed:created.replayed === true } };
  }
  const response = await remoteFetch("/v1/conversations/feedback", {
    method:"POST",
    headers:serviceHeaders(metadata.requestId, metadata.idempotencyKey),
    body:JSON.stringify(tenantBoundPayload)
  });
  return parseResponse(response);
}

const toLegacyInvocation = (result) => ({
  request_id:result.request_id,
  run_id:result.run_id,
  status:result.status,
  agent:result.agent,
  output:{
    message:result.reply.text,
    structured_data:{
      projects:result.profile_signals.projects,
      doctors:result.profile_signals.doctors,
      intent:result.profile_signals.intent,
      intent_analysis:{
        primary_intent:result.profile_signals.intent,
        confidence:result.profile_signals.intent_confidence,
        domain:result.profile_signals.intent_domain,
        dialogue_act:result.profile_signals.dialogue_act,
        clarification_required:result.profile_signals.clarification_required,
        entities:{ projects:result.profile_signals.projects, doctors:result.profile_signals.doctors }
      },
      next_questions:result.reply.suggestions
    },
    recommended_actions:result.profile_signals.next_action ? [{ type:result.profile_signals.next_action }] : [],
    handover:result.handover,
    citations:result.reply.citations
  },
  guardrails:result.guardrails,
  usage:result.usage,
  created_at:new Date().toISOString()
});

export async function callAcquisitionLegacyInvocation(payload, metadata = {}) {
  const standardPayload = bindServiceTenant({
    tenant_id:payload.tenant_id || payload.context?.tenant_id,
    channel:"api",
    conversation_id:payload.context?.session_id || payload.customer_id || metadata.requestId,
    message:{ text:payload.message },
    actor:{ customer_id:payload.customer_id },
    interests:payload.context?.interests,
    context:{ ...payload.context, source_channel:payload.channel || "partner_api", mode:payload.mode || "assist" }
  });
  if (IN_PROCESS) {
    const [{ normalizeChannelInbound }, { processAcquisitionEnvelope }] = await Promise.all([
      import("./acquisition-channel-adapters.mjs"), import("./acquisition-domain-service.mjs")
    ]);
    return toLegacyInvocation(await processAcquisitionEnvelope(normalizeChannelInbound("api", standardPayload), { ...metadata, caller:SERVICE_CALLER_ID }));
  }
  const response = await remoteFetch("/v1/conversations/reply", {
    method:"POST",
    headers:serviceHeaders(metadata.requestId, metadata.idempotencyKey),
    body:JSON.stringify(standardPayload)
  });
  return toLegacyInvocation(await parseResponse(response));
}

const assertServiceTenant = (tenantId) => {
  const supplied = String(tenantId || "").trim().toLowerCase();
  if (supplied && supplied !== SERVICE_TENANT_ID) {
    const error = new Error("网关调用方已绑定固定租户，请求不能读取其他租户");
    error.code = "TENANT_ACCESS_DENIED";
    error.status = 403;
    throw error;
  }
  return supplied || SERVICE_TENANT_ID;
};

export async function getAcquisitionServiceRun(runId, tenantId) {
  const authorizedTenantId = assertServiceTenant(tenantId);
  if (IN_PROCESS) {
    const { getRunAsync } = await import("./agent-runtime.mjs");
    return getRunAsync(runId, authorizedTenantId);
  }
  const response = await remoteFetch(
    `/v1/runs/${encodeURIComponent(runId)}?tenant_id=${encodeURIComponent(authorizedTenantId)}`,
    { headers:serviceHeaders("") }
  );
  if (response.status === 404) return null;
  return (await parseResponse(response)).data || null;
}

export async function listAcquisitionServiceRuns(limit = 50, tenantId) {
  const authorizedTenantId = assertServiceTenant(tenantId);
  if (IN_PROCESS) {
    const { listRunsAsync } = await import("./agent-runtime.mjs");
    return listRunsAsync(limit, authorizedTenantId, "A-01");
  }
  const response = await remoteFetch(
    `/v1/runs?limit=${encodeURIComponent(limit)}&tenant_id=${encodeURIComponent(authorizedTenantId)}`,
    { headers:serviceHeaders("") }
  );
  return (await parseResponse(response)).data || [];
}

export async function getAcquisitionServiceStatus() {
  if (IN_PROCESS) {
    const { getAcquisitionDomainStatus } = await import("./acquisition-domain-service.mjs");
    return { reachable:true, transport:"in_process_test_fallback", url:null, ...await getAcquisitionDomainStatus() };
  }
  try {
    const configuredReadyTimeout = Math.max(2_000, Math.min(Number(process.env.HUAMEI_ACQUISITION_READY_TIMEOUT_MS) || 6_000, 10_000));
    const response = await remoteFetch("/ready", { headers:serviceHeaders("") }, configuredReadyTimeout);
    const status = await parseResponse(response);
    return { reachable:true, transport:"http", url:SERVICE_URL, ...status };
  } catch (error) {
    return { reachable:false, transport:"http", url:SERVICE_URL, status:"unavailable", error:{ code:error.code, message:error.message } };
  }
}

// Channel status is intentionally read from the acquisition service rather
// than inferred in the browser.  A channel with credentials but no official
// delivery adapter remains non-deliverable and must not be rendered as live.
export async function listAcquisitionServiceChannels() {
  if (IN_PROCESS) {
    const { listAcquisitionChannelStatuses } = await import("./acquisition-channel-adapters.mjs");
    return listAcquisitionChannelStatuses();
  }
  const response = await remoteFetch("/v1/channels", { headers:serviceHeaders("") });
  const payload = await parseResponse(response);
  return Array.isArray(payload.data) ? payload.data : [];
}

export const getAcquisitionServiceClientConfig = () => ({
  url:IN_PROCESS ? null : SERVICE_URL,
  transport:IN_PROCESS ? "in_process_test_fallback" : "http",
  timeout_ms:REQUEST_TIMEOUT_MS,
  caller_id:SERVICE_CALLER_ID,
  tenant_id:SERVICE_TENANT_ID
});
