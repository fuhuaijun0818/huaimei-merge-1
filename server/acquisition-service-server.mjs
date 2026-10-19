import { applyManagementAccount } from "./platform/management-accounts.mjs";
import { authorizeManagementPrincipal } from "./platform/management-authorization.mjs";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  process.loadEnvFile(join(root, ".env.local"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const { ACQUISITION_CHANNELS, formatChannelOutbound, normalizeChannelInbound } = await import("./acquisition-channel-adapters.mjs");
const { getAcquisitionDomainStatus, processAcquisitionEnvelope, acquisitionHandoverDeliveryOverride } = await import("./acquisition-domain-service.mjs");
const { getHuameiKnowledgeStatus } = await import("./huamei-knowledge.mjs");
const { flushAcquisitionSessions } = await import("./acquisition-session.mjs");
const { revealContactForClaimedHandover } = await import("./contact-vault.mjs");
const { createAcquisitionServiceOpenApi } = await import("./acquisition-service-openapi.mjs");
const { getRunAsync, listRunsAsync } = await import("./agent-runtime.mjs");
const { completeAcquisitionTask } = await import("./lead-store.mjs");
const {
  claimHandover, completeHandoverWithWork, getHandover, getOperationsMetrics,
  listHandovers, listOperationTasks, recordHumanWork
} = await import("./acquisition-operations-store.mjs");
const {
  createConversationFeedback,
  listBadCaseFeedback,
  reviewConversationFeedback
} = await import("./acquisition-feedback-store.mjs");
const {
  activateKnowledgeRelease,
  attachKnowledgeIndex,
  configuredKnowledgeReleaseTenants,
  createKnowledgeReleaseDraft,
  ensureKnowledgeReleasePolicyFresh,
  getKnowledgeReleaseReceipt,
  getKnowledgeReviewScope,
  initializeKnowledgeReleasePolicy,
  listKnowledgeReleases,
  publishKnowledgeRelease,
  registerKnowledgeReleaseTenants,
  refreshKnowledgeReleasePolicy,
  submitKnowledgeReview
} = await import("./knowledge-release-policy.mjs");
const { normalizeTenantId } = await import("./platform/tenant-context.mjs");
const { redactContactPiiDeep } = await import("./platform/contact-pii-redaction.mjs");
const { canonicalPayloadHash, createRequestSecurityStores, scopedKey } = await import("./platform/request-security.mjs");
const { closePostgresClient, getPostgresClient } = await import("./platform/postgres.mjs");
const { createProductionReadiness, parseAcquisitionClientsConfig } = await import("./platform/production-readiness.mjs");
const { closeRedisClient } = await import("./platform/redis.mjs");
const { probeProductionExternalDependencies } = await import("./platform/external-dependency-readiness.mjs");
const { getOidcVerifier } = await import("./platform/oidc-auth.mjs");
const {
  FORMAL_LOAD_TAXONOMY_HEADER,
  FORMAL_LOAD_TAXONOMY_PERMISSION,
  resolveFormalLoadTaxonomyEntry
} = await import("./platform/formal-load-taxonomy.mjs");
const { verifyExternalTestManagementIdentity, verifyLocalManagementIdentity } = await import("./platform/local-management-identity.mjs");
const {
  createObservabilityHttpHandler,
  createObservedHttpHandler,
  getObservability,
  getRequestContext
} = await import("./observability/index.mjs");
const {
  approvePrivacyRightsExecution,
  createPrivacyRightsRequest,
  getPrivacyRightsExecution,
  getPrivacyRightsRequest,
  listPrivacyRightsRequests,
  preparePrivacyRightsExecution,
  transitionPrivacyRightsRequest
} = await import("./privacy-rights-service.mjs");

const MAX_BODY_BYTES = 64 * 1024;
const nonRevealPayload = (value) => redactContactPiiDeep(value);
const RATE_LIMIT = Math.max(10, Number(process.env.HUAMEI_ACQUISITION_SERVICE_RATE_LIMIT || 1200));
const SERVICE_KEY = String(process.env.HUAMEI_ACQUISITION_SERVICE_KEY || "");
const acquisitionClientConfig = parseAcquisitionClientsConfig(process.env.HUAMEI_ACQUISITION_CLIENTS_JSON);
const acquisitionClients = new Map(acquisitionClientConfig.clients.map((client) => [client.caller_id, client]));
const knowledgeReleaseTenantIds = registerKnowledgeReleaseTenants(
  configuredKnowledgeReleaseTenants(process.env, acquisitionClientConfig.clients)
);
const runtimeEnvironment = String(
  process.env.HUAMEI_RUNTIME_ENV || process.env.HUAMEI_DEPLOYMENT_ENV || process.env.NODE_ENV || "development"
).trim().toLowerCase();
const productionRuntime = ["prod", "production"].includes(runtimeEnvironment);
const acquisitionObservability = getObservability({
  service:process.env.HUAMEI_SERVICE_NAME || "huamei-acquisition",
  version:"2.1.0",
  environment:runtimeEnvironment
});
const requestSecurityStores = await createRequestSecurityStores({ env:process.env });
const rateLimitStore = requestSecurityStores.fixedWindowStore;
const idempotencyStore = requestSecurityStores.idempotencyStore;
const productionReadiness = productionRuntime
  ? createProductionReadiness({
      env:process.env,
      postgres:getPostgresClient({ env:process.env }),
      redis:requestSecurityStores.redis
    })
  : null;
let productionInitialized = !productionRuntime;
let startupReadiness = productionRuntime ? null : {
  ok:true,
  status:"not_required",
  environment:runtimeEnvironment,
  checked_at:new Date().toISOString()
};
let knowledgeRefreshTimer = null;

const productionNotReady = (report) => {
  const error = new Error("Acquisition service production dependencies are not ready");
  error.code = "PRODUCTION_DEPENDENCIES_NOT_READY";
  error.report = report;
  return error;
};

export async function initializeAcquisitionServiceRuntime() {
  if (!productionRuntime) return startupReadiness;
  productionReadiness.assert({ production:true });
  const report = await productionReadiness.health();
  if (!report.ok) throw productionNotReady(report);
  await initializeKnowledgeReleasePolicy(knowledgeReleaseTenantIds);
  const domain = await getAcquisitionDomainStatus();
  // A fresh production database has no active knowledge release yet. Keep the
  // authenticated governance control plane reachable so three reviewers can
  // create/review/bind/activate the first release, while /ready and every
  // conversation endpoint remain fail-closed until the data plane is ready.
  const externalDependencies = domain.status === "ok"
    ? await probeProductionExternalDependencies({ domain })
    : { ok:false, status:"not_ready", checks:{ knowledge_binding:{ ok:false, status:"not_ready" } } };
  startupReadiness = {
    ...report,
    ok:report.ok === true && domain.status === "ok" && externalDependencies.ok === true,
    status:domain.status === "ok" && externalDependencies.ok === true ? "ready" : "control_plane_only",
    acquisition_domain:{ status:domain.status },
    external_dependencies:externalDependencies
  };
  productionInitialized = true;
  return startupReadiness;
}

export const evaluateAcquisitionDataPlaneReadiness = ({ production = productionRuntime, domain, externalDependencies } = {}) => {
  if (!production) return { ok:true, status:"not_required" };
  const domainReady = domain?.status === "ok";
  const externalReady = externalDependencies?.ok === true;
  return {
    ok:domainReady && externalReady,
    status:domainReady && externalReady ? "ready" : "not_ready",
    checks:{
      acquisition_domain:{ ok:domainReady, status:domain?.status || "not_ready" },
      external_dependencies:{ ok:externalReady, status:externalDependencies?.status || "not_ready" }
    }
  };
};

const getInfrastructureReadiness = () => productionRuntime
  ? productionReadiness.health()
  : Promise.resolve(startupReadiness);

export async function closeAcquisitionServiceRuntime() {
  if (knowledgeRefreshTimer) clearInterval(knowledgeRefreshTimer);
  knowledgeRefreshTimer = null;
  if (!productionRuntime) return;
  await Promise.allSettled([closePostgresClient(), closeRedisClient()]);
}

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
};

const isLoopbackAddress = (value) => ["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"].includes(String(value || ""));
const requestIdFor = (request) => {
  const active = getRequestContext();
  if (active?.requestId) return active.requestId;
  const supplied = String(request.headers["x-request-id"] || "").trim();
  return supplied && supplied.length <= 128 ? supplied : `req_${randomUUID()}`;
};
const routeTemplateForRequest = (request) => {
  let pathname;
  try { pathname = new URL(request.url || "/", "http://acquisition.invalid").pathname; }
  catch { return "__unmatched__"; }
  const templates = [
    [/^\/v1\/channels\/[^/]+\/inbound$/, "/v1/channels/:channel/inbound"],
    [/^\/v1\/conversations\/feedback$/, "/v1/conversations/feedback"],
    [/^\/v1\/feedback\/bad-cases$/, "/v1/feedback/bad-cases"],
    [/^\/v1\/feedback\/bad-cases\/[^/]+\/review$/, "/v1/feedback/bad-cases/:id/review"],
    [/^\/v1\/runs\/[^/]+$/, "/v1/runs/:id"],
    [/^\/v1\/handovers\/[^/]+(?:\/claim|\/complete|\/contact-reveal)?$/,
      pathname.endsWith("/claim")
        ? "/v1/handovers/:id/claim"
        : pathname.endsWith("/complete")
          ? "/v1/handovers/:id/complete"
          : pathname.endsWith("/contact-reveal")
            ? "/v1/handovers/:id/contact-reveal"
            : "/v1/handovers/:id"],
    [/^\/v1\/knowledge\/releases\/[^/]+(?:\/reviews|\/receipt|\/publish|\/activate|\/index)?$/, pathname.replace(/\/v1\/knowledge\/releases\/[^/]+/, "/v1/knowledge/releases/:id")],
    [/^\/v1\/privacy\/requests\/[^/]+\/execution\/(?:prepare|approve)$/, pathname.endsWith("/prepare") ? "/v1/privacy/requests/:id/execution/prepare" : "/v1/privacy/requests/:id/execution/approve"],
    [/^\/v1\/privacy\/requests\/[^/]+\/execution$/, "/v1/privacy/requests/:id/execution"],
    [/^\/v1\/privacy\/requests\/[^/]+(?:\/transition)?$/, pathname.endsWith("/transition") ? "/v1/privacy/requests/:id/transition" : "/v1/privacy/requests/:id"]
  ];
  return templates.find(([pattern]) => pattern.test(pathname))?.[1] || pathname;
};
const jsonHeaders = (requestId, extra = {}) => ({
  "Content-Type":"application/json; charset=utf-8",
  "Cache-Control":"no-store",
  "X-Content-Type-Options":"nosniff",
  "X-Request-Id":requestId,
  ...extra
});
const sendJson = (response, requestId, status, payload, extra = {}) => {
  response.writeHead(status, jsonHeaders(requestId, extra));
  response.end(JSON.stringify(payload));
};
const sendError = (response, requestId, status, code, message, details = [], extra = {}) => sendJson(response, requestId, status, {
  error:{ code, message, ...(details.length ? { details } : {}) }, request_id:requestId
}, extra);
const readJsonBody = async (request) => {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("请求体不能超过64KB");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("请求体不是有效JSON");
    error.code = "INVALID_JSON";
    throw error;
  }
};
const authenticatedCaller = (request, host) => {
  const suppliedCallerId = String(request.headers["x-caller-id"] || "").trim().slice(0, 128);
  const suppliedSecret = String(request.headers["x-service-key"] || "");
  if (acquisitionClientConfig.configured) {
    if (!acquisitionClientConfig.valid || !suppliedCallerId) return null;
    const client = acquisitionClients.get(suppliedCallerId);
    if (!client || !safeEqual(suppliedSecret, client.secret)) return null;
    return {
      caller_id:client.caller_id,
      tenant_ids:client.tenant_ids,
      permissions:client.permissions,
      service_key_verified:true,
      development_compatibility:false
    };
  }
  if (!productionRuntime && isLoopbackAddress(host) && isLoopbackAddress(request.socket.remoteAddress)) {
    const callerId = /^[a-z0-9][a-z0-9_.:@/-]{1,127}$/i.test(suppliedCallerId)
      ? suppliedCallerId
      : "development_loopback";
    return { caller_id:callerId, tenant_ids:["*"], permissions:["*"], development_compatibility:true, service_key_verified:false };
  }
  if (!productionRuntime && SERVICE_KEY.length >= 24 && safeEqual(suppliedSecret, SERVICE_KEY)) {
    const callerId = /^[a-z0-9][a-z0-9_.:@/-]{1,127}$/i.test(suppliedCallerId)
      ? suppliedCallerId
      : "legacy_service_client";
    return { caller_id:callerId, tenant_ids:["*"], permissions:["*"], development_compatibility:true, service_key_verified:true };
  }
  return null;
};
const hasPermission = (principal, permission) => principal.permissions.includes("*") || principal.permissions.includes(permission);
const authorizationError = (code, message, status = 403, details = []) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};
const requirePermission = (principal, permission) => {
  if (!hasPermission(principal, permission)) {
    throw authorizationError("INSUFFICIENT_PERMISSION", "当前调用方无权执行该操作", 403, [{ permission }]);
  }
};
const tenantValuesFrom = (request, url, payload = {}) => [
  { field:"query.tenant_id", value:url.searchParams.get("tenant_id") },
  { field:"header.x-tenant-id", value:request.headers["x-tenant-id"] },
  { field:"body.tenant_id", value:payload?.tenant_id },
  { field:"body.tenantId", value:payload?.tenantId },
  { field:"body.context.tenant_id", value:payload?.context?.tenant_id },
  { field:"body.context.tenantId", value:payload?.context?.tenantId }
].filter((item) => String(item.value || "").trim());
const bindTenant = (principal, request, url, payload = {}) => {
  const supplied = tenantValuesFrom(request, url, payload).map((item) => {
    try { return { ...item, normalized:normalizeTenantId(item.value) }; }
    catch (error) {
      error.status = 400;
      throw error;
    }
  });
  const distinct = [...new Set(supplied.map((item) => item.normalized))];
  if (distinct.length > 1) {
    throw authorizationError(
      "TENANT_CONTEXT_MISMATCH",
      "请求中的租户信息不一致",
      403,
      supplied.map((item) => ({ field:item.field, message:"必须与已绑定租户一致" }))
    );
  }
  const wildcard = principal.tenant_ids.includes("*");
  let tenantId = distinct[0] || "";
  if (!tenantId) {
    const defaultTenantId = normalizeTenantId();
    if (wildcard || principal.tenant_ids.includes(defaultTenantId)) tenantId = defaultTenantId;
    else if (principal.tenant_ids.length === 1) tenantId = principal.tenant_ids[0];
    else throw authorizationError("TENANT_CONTEXT_REQUIRED", "该调用方可访问多个租户，请明确指定租户", 400);
  }
  if (!wildcard && !principal.tenant_ids.includes(tenantId)) {
    throw authorizationError("TENANT_ACCESS_DENIED", "当前调用方无权访问该租户", 403);
  }
  return tenantId;
};
const consumeRateLimit = (principal) => rateLimitStore.consume(
  scopedKey("acquisition", principal.caller_id),
  { limit:RATE_LIMIT, windowMs:60_000 }
);

export function createAcquisitionServiceServer(options = {}) {
  const host = options.host || process.env.HUAMEI_ACQUISITION_SERVICE_HOST || "127.0.0.1";
  const oidcVerifier = options.oidcVerifier || getOidcVerifier({ env:process.env });
  const observability = options.observability || acquisitionObservability;
  const metricsToken = String(options.metricsToken ?? process.env.HUAMEI_METRICS_TOKEN ?? "").trim();
  const observabilityReadiness = options.readiness || (async () => {
    const [domain, infrastructure] = await Promise.all([
      getAcquisitionDomainStatus(),
      getInfrastructureReadiness()
    ]);
    const externalDependencies = productionRuntime
      ? await probeProductionExternalDependencies({ domain })
      : { ok:true, status:"not_required" };
    return {
      ok:domain.status === "ok" && infrastructure?.ok === true && externalDependencies.ok === true,
      checks:{
        acquisition_domain:{ ok:domain.status === "ok", status:domain.status },
        infrastructure:{ ok:infrastructure?.ok === true, status:infrastructure?.status },
        external_dependencies:{ ok:externalDependencies.ok === true, status:externalDependencies.status }
      }
    };
  });
  const observabilityHandler = productionRuntime || metricsToken
    ? createObservabilityHttpHandler({
        observability,
        token:metricsToken,
        environment:runtimeEnvironment,
        service:observability.service,
        readiness:observabilityReadiness
      })
    : null;
  if (productionRuntime && !productionInitialized) {
    throw productionNotReady(startupReadiness || { status:"startup_preflight_required" });
  }
  if (acquisitionClientConfig.configured && !acquisitionClientConfig.valid) {
    const error = new Error("售前智能体调用方配置无效");
    error.code = "ACQUISITION_CLIENT_CONFIG_INVALID";
    error.details = acquisitionClientConfig.errors;
    throw error;
  }
  if (!isLoopbackAddress(host) && !acquisitionClientConfig.valid && SERVICE_KEY.length < 24) {
    throw new Error("售前智能体服务对非本机地址监听时，必须配置HUAMEI_ACQUISITION_CLIENTS_JSON调用方白名单");
  }
  const applicationHandler = (request, response) => {
    const requestId = requestIdFor(request);
    let observabilityPath = "";
    try { observabilityPath = new URL(request.url || "/", "http://acquisition.invalid").pathname; } catch {}
    if (observabilityHandler && ["/healthz", "/readyz", "/metrics"].includes(observabilityPath)) {
      return observabilityHandler(request, response);
    }
    void (async () => {
    let url;
    try { url = new URL(request.url, `http://${request.headers.host || host}`); }
    catch { sendError(response, requestId, 400, "INVALID_URL", "请求地址无效"); return; }

    if (request.method === "GET" && url.pathname === "/health") {
      // Keep legacy diagnostics only for a true loopback-to-loopback probe.
      // A non-loopback deployment exposes a deliberately minimal liveness body.
      const localProbe = isLoopbackAddress(host) && isLoopbackAddress(request.socket.remoteAddress);
      if (localProbe) {
        try {
          const status = await getAcquisitionDomainStatus();
          sendJson(response, requestId, 200, { ...status, channels:ACQUISITION_CHANNELS });
        } catch {
          sendJson(response, requestId, 200, { status:"degraded", service:"huamei-acquisition-agent", version:"2.1.0", channels:ACQUISITION_CHANNELS, time:new Date().toISOString() });
        }
      } else {
        sendJson(response, requestId, 200, { status:"ok", service:"huamei-acquisition-agent", version:"2.1.0", time:new Date().toISOString() });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/openapi.json") {
      sendJson(response, requestId, 200, createAcquisitionServiceOpenApi(`${url.protocol}//${url.host}`));
      return;
    }
    const principal = authenticatedCaller(request, host);
    if (!principal) {
      sendError(response, requestId, 401, "UNAUTHORIZED", "缺少或提供了无效的X-Service-Key");
      return;
    }
    const permit = (permission) => {
      try { requirePermission(principal, permission); return true; }
      catch (error) {
        sendError(response, requestId, error.status || 403, error.code || "FORBIDDEN", error.message, error.details || []);
        return false;
      }
    };
    const resolveTenant = (payload = {}) => {
      try { return bindTenant(principal, request, url, payload); }
      catch (error) {
        sendError(response, requestId, error.status || 403, error.code || "TENANT_ACCESS_DENIED", error.message, error.details || []);
        return null;
      }
    };
    const resolveHumanIdentity = async (tenantId, requiredRoles = [], requiredAllRoles = []) => {
      try {
        const bearer = String(request.headers.authorization || "").trim();
        let identity;
        if (!bearer && request.headers["x-huamei-external-admin-signature"]
          && requiredRoles.length === 1 && ["operations.agent","feedback:manage"].includes(requiredRoles[0])) {
          identity = verifyExternalTestManagementIdentity({
            env:process.env,
            authenticatedCaller:principal,
            remoteAddress:request.socket.remoteAddress,
            headers:request.headers,
            tenantId,
            method:request.method,
            pathname:url.pathname
          });
        } else if (!bearer
          && request.headers["x-huamei-local-admin-signature"]
          && requiredRoles.length === 1
          && ["operations.agent","feedback:manage"].includes(requiredRoles[0])) {
          identity = verifyLocalManagementIdentity({
            env:process.env,
            serviceHost:host,
            remoteAddress:request.socket.remoteAddress,
            headers:request.headers,
            tenantId,
            method:request.method,
            pathname:url.pathname
          });
        } else {
          identity = await oidcVerifier.verifyAuthorizationHeader(request.headers.authorization, {
            tenantId
          });
        }
        identity=authorizeManagementPrincipal(await applyManagementAccount(identity,tenantId,{required:productionRuntime}),{tenantId,requiredRoles,requiredAllRoles});
        identity={...identity,roles:identity.effectiveRoles};
        const identityRoles = new Set(identity.roles);
        const missingRoles = requiredAllRoles.filter((role) => !identityRoles.has(role));
        if (missingRoles.length) {
          throw authorizationError(
            "OIDC_ROLE_FORBIDDEN",
            "当前实名账号缺少查看联系方式所需的独立权限",
            403,
            missingRoles.map((role) => ({ role }))
          );
        }
        return identity;
      } catch (error) {
        sendError(
          response,
          requestId,
          error.status || 401,
          error.code || "OIDC_AUTHENTICATION_FAILED",
          error.status === 403 ? "当前实名账号无权执行该操作" : "需要有效的企业实名身份",
          error.details || []
        );
        return null;
      }
    };
    if (request.method === "GET" && url.pathname === "/ready") {
      if (!permit("service:read")) return;
      const tenantId = resolveTenant();
      if (!tenantId) return;
      try {
        const [status, infrastructure] = await Promise.all([
          getAcquisitionDomainStatus(tenantId),
          getInfrastructureReadiness()
        ]);
        const externalDependencies = productionRuntime
          ? await probeProductionExternalDependencies({ domain:status })
          : { ok:true, status:"not_required" };
        const ready = status.status === "ok" && infrastructure.ok === true && externalDependencies.ok === true;
        sendJson(response, requestId, ready ? 200 : 503, {
          ...status,
          status:ready ? "ready" : "not_ready",
          service:"huamei-acquisition-agent",
          version:"2.1.0",
          channels:ACQUISITION_CHANNELS,
          request_security:{
            backend:requestSecurityStores.backend,
            rate_limit_driver:rateLimitStore.driver,
            idempotency_driver:idempotencyStore.driver
          },
          infrastructure,
          external_dependencies:externalDependencies,
          time:new Date().toISOString()
        });
      } catch (error) {
        sendJson(response, requestId, 503, {
          status:"not_ready",
          service:"huamei-acquisition-agent",
          version:"2.1.0",
          error:{ code:error.code || "READINESS_CHECK_FAILED", message:"Dependency readiness check failed" },
          time:new Date().toISOString()
        });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/channels") {
      if (!permit("service:read")) return;
      sendJson(response, requestId, 200, { data:ACQUISITION_CHANNELS, request_id:requestId });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/handovers") {
      if (!permit("operations:read")) return;
      const tenantId = resolveTenant();
      if (!tenantId) return;
      sendJson(response, requestId, 200, { data:nonRevealPayload(await listHandovers({ tenant_id:tenantId, status:url.searchParams.get("status") || "", limit:url.searchParams.get("limit") })), request_id:requestId });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/operations/tasks") {
      if (!permit("operations:read")) return;
      const tenantId = resolveTenant();
      if (!tenantId) return;
      sendJson(response, requestId, 200, { data:nonRevealPayload(await listOperationTasks({ tenant_id:tenantId, status:url.searchParams.get("status") || "", limit:url.searchParams.get("limit") })), request_id:requestId });
      return;
    }
    const taskCompleteMatch = url.pathname.match(/^\/v1\/operations\/tasks\/([A-Za-z0-9_.:-]{1,160})\/complete$/i);
    if (request.method === "POST" && taskCompleteMatch) {
      if (!permit("operations:write")) return;
      let taskPayload;
      try {
        taskPayload = await readJsonBody(request);
      } catch (error) {
        sendError(response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.message);
        return;
      }
      const tenantId = resolveTenant(taskPayload);
      if (!tenantId) return;
      const identity = await resolveHumanIdentity(tenantId, ["operations.agent"]);
      if (!identity) return;
      try {
        const completed = await completeAcquisitionTask({
          tenant_id:tenantId,
          task_id:taskCompleteMatch[1],
          customer_id:taskPayload.customer_id,
          actor:identity.subject
        });
        sendJson(response, requestId, 200, {
          data:{ task:completed.task, replayed:completed.replayed === true },
          request_id:requestId
        });
      } catch (error) {
        const status = Number(error.status) || 400;
        sendError(response, requestId, status, error.code || "TASK_COMPLETION_FAILED", error.message || "任务完成失败", error.details || []);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/operations/metrics") {
      if (!permit("operations:read")) return;
      const tenantId = resolveTenant();
      if (!tenantId) return;
      sendJson(response, requestId, 200, { data:await getOperationsMetrics(tenantId), request_id:requestId });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/conversations/feedback") {
      if (!permit("conversation:write")) return;
      let feedbackPayload;
      try { feedbackPayload = await readJsonBody(request); }
      catch (error) {
        sendError(response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.message);
        return;
      }
      const tenantId = resolveTenant(feedbackPayload);
      if (!tenantId) return;
      try {
        const created = createConversationFeedback({
          ...feedbackPayload,
          tenant_id:tenantId,
          channel:feedbackPayload.channel || "web"
        });
        sendJson(response, requestId, created.replayed ? 200 : 201, {
          data:created.feedback,
          meta:{ replayed:created.replayed === true },
          request_id:requestId
        });
      } catch (error) {
        sendError(response, requestId, Number(error.status) || 400, error.code || "FEEDBACK_CREATE_FAILED", error.message || "反馈暂时无法记录");
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/feedback/bad-cases") {
      if (!permit("operations:read")) return;
      const tenantId = resolveTenant();
      if (!tenantId) return;
      sendJson(response, requestId, 200, {
        data:listBadCaseFeedback({
          tenant_id:tenantId,
          status:url.searchParams.get("status") || "",
          limit:url.searchParams.get("limit")
        }),
        request_id:requestId
      });
      return;
    }
    const feedbackReviewMatch = url.pathname.match(/^\/v1\/feedback\/bad-cases\/(fb_[a-f0-9-]+)\/review$/i);
    if (request.method === "POST" && feedbackReviewMatch) {
      if (!permit("operations:write")) return;
      let reviewPayload;
      try { reviewPayload = await readJsonBody(request); }
      catch (error) {
        sendError(response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.message);
        return;
      }
      const tenantId = resolveTenant(reviewPayload);
      if (!tenantId) return;
      const identity = await resolveHumanIdentity(tenantId, ["feedback:manage"]);
      if (!identity) return;
      const idempotencyKey = String(request.headers["idempotency-key"] || "").trim();
      if (idempotencyKey.length < 8 || idempotencyKey.length > 160) {
        sendError(response, requestId, 400, "IDEMPOTENCY_KEY_REQUIRED", "处理Bad Case必须提供8–160字符的一次性Idempotency-Key");
        return;
      }
      try {
        const reviewed = reviewConversationFeedback({
          tenant_id:tenantId,
          feedback_id:feedbackReviewMatch[1],
          actor:identity.subject,
          status:reviewPayload.status,
          note:reviewPayload.note,
          idempotency_key:idempotencyKey
        });
        if (!reviewed) sendError(response, requestId, 404, "FEEDBACK_NOT_FOUND", "未找到指定Bad Case");
        else sendJson(response, requestId, 200, {
          data:reviewed.feedback,
          meta:{ replayed:reviewed.replayed === true },
          request_id:requestId
        });
      } catch (error) {
        sendError(response, requestId, Number(error.status) || 400, error.code || "FEEDBACK_REVIEW_FAILED", error.message || "Bad Case处理失败");
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/knowledge/admission") {
      if (!permit("knowledge:read")) return;
      const tenantId = resolveTenant();
      if (!tenantId) return;
      await ensureKnowledgeReleasePolicyFresh(tenantId);
      const knowledge = getHuameiKnowledgeStatus(tenantId);
      const requestedVersion = String(url.searchParams.get("package_version") || "").trim();
      const admission = requestedVersion && requestedVersion !== knowledge.version
        ? { ...knowledge.admission, ready:false, error:"KNOWLEDGE_PACKAGE_VERSION_MISMATCH" }
        : knowledge.admission;
      sendJson(response, requestId, 200, { data:admission, request_id:requestId });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/knowledge/releases") {
      if (!permit("knowledge:read")) return;
      const tenantId = resolveTenant();
      if (!tenantId) return;
      await ensureKnowledgeReleasePolicyFresh(tenantId);
      sendJson(response, requestId, 200, { data:await listKnowledgeReleases(tenantId), request_id:requestId });
      return;
    }
    const reviewScopeMatch = url.pathname.match(/^\/v1\/knowledge\/releases\/(krel_[A-Za-z0-9._:-]+)\/review-scope$/);
    const reviewMatch = url.pathname.match(/^\/v1\/knowledge\/releases\/(krel_[A-Za-z0-9._:-]+)\/reviews\/(business|medical|compliance)$/);
    const receiptMatch = url.pathname.match(/^\/v1\/knowledge\/releases\/(krel_[A-Za-z0-9._:-]+)\/receipt$/);
    const indexMatch = url.pathname.match(/^\/v1\/knowledge\/releases\/(krel_[A-Za-z0-9._:-]+)\/index$/);
    const activationMatch = url.pathname.match(/^\/v1\/knowledge\/releases\/(krel_[A-Za-z0-9._:-]+)\/activate$/);
    const createDraftRequest = request.method === "POST" && url.pathname === "/v1/knowledge/releases/drafts";
    const formalKnowledgeRequest = createDraftRequest
      || (request.method === "GET" && (reviewScopeMatch || receiptMatch))
      || (request.method === "POST" && (reviewMatch || indexMatch || activationMatch));
    if (formalKnowledgeRequest) {
      if (!permit(request.method === "GET" && reviewScopeMatch ? "knowledge:read" : "knowledge:release")) return;
      let operationPayload = {};
      if (request.method === "POST") {
        try { operationPayload = await readJsonBody(request); }
        catch (error) {
          sendError(response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.message);
          return;
        }
      }
      const tenantId = resolveTenant(operationPayload);
      if (!tenantId) return;
      const requiredRoles = createDraftRequest
        ? ["knowledge.release_manager"]
        : reviewMatch
          ? [`knowledge.${reviewMatch[2]}_reviewer`]
          : receiptMatch || indexMatch
            ? ["knowledge.index_manager"]
            : activationMatch
              ? ["knowledge.publisher"]
              : [
                  "knowledge.release_manager",
                  "knowledge.business_reviewer",
                  "knowledge.medical_reviewer",
                  "knowledge.compliance_reviewer",
                  "knowledge.index_manager",
                  "knowledge.publisher"
                ];
      const identity = await resolveHumanIdentity(tenantId, requiredRoles);
      if (!identity) return;
      try {
        if (createDraftRequest) {
          const release = await createKnowledgeReleaseDraft({ ...operationPayload, tenant_id:tenantId }, identity);
          sendJson(response, requestId, 201, { data:release, request_id:requestId });
          return;
        }
        const releaseId = reviewScopeMatch?.[1] || reviewMatch?.[1] || receiptMatch?.[1] || indexMatch?.[1] || activationMatch?.[1];
        if (reviewScopeMatch) {
          sendJson(response, requestId, 200, { data:await getKnowledgeReviewScope(tenantId, releaseId), request_id:requestId });
          return;
        }
        if (reviewMatch) {
          const review = await submitKnowledgeReview({
            ...operationPayload,
            tenant_id:tenantId,
            release_id:releaseId,
            review_type:reviewMatch[2]
          }, identity);
          sendJson(response, requestId, 201, { data:review, request_id:requestId });
          return;
        }
        if (receiptMatch) {
          sendJson(response, requestId, 200, { data:await getKnowledgeReleaseReceipt(tenantId, releaseId), request_id:requestId });
          return;
        }
        if (indexMatch) {
          const release = await attachKnowledgeIndex({ ...operationPayload, tenant_id:tenantId, release_id:releaseId }, identity);
          sendJson(response, requestId, 200, { data:release, request_id:requestId });
          return;
        }
        const release = await activateKnowledgeRelease({ tenant_id:tenantId, release_id:releaseId }, identity);
        sendJson(response, requestId, 200, { data:release, request_id:requestId });
        return;
      } catch (error) {
        const conflict = ["23505", "55000", "KNOWLEDGE_RELEASE_NOT_READY"].includes(error.code);
        const notFound = ["P0002", "KNOWLEDGE_RELEASE_NOT_FOUND"].includes(error.code);
        const forbidden = /FORBIDDEN/.test(String(error.code || ""));
        sendError(
          response,
          requestId,
          error.status || (notFound ? 404 : forbidden ? 403 : conflict ? 409 : 400),
          error.code || "KNOWLEDGE_WORKFLOW_INVALID",
          error.message,
          error.details || []
        );
        return;
      }
    }
    const handoverMatch = url.pathname.match(/^\/v1\/handovers\/(ho_[a-f0-9-]+)$/i);
    if (request.method === "GET" && handoverMatch) {
      if (!permit("operations:read")) return;
      const tenantId = resolveTenant();
      if (!tenantId) return;
      const handover = await getHandover(handoverMatch[1], tenantId);
      if (!handover) sendError(response, requestId, 404, "HANDOVER_NOT_FOUND", "未找到指定转人工任务");
      else sendJson(response, requestId, 200, { data:nonRevealPayload(handover), request_id:requestId });
      return;
    }
    const claimMatch = url.pathname.match(/^\/v1\/handovers\/(ho_[a-f0-9-]+)\/claim$/i);
    const completeMatch = url.pathname.match(/^\/v1\/handovers\/(ho_[a-f0-9-]+)\/complete$/i);
    const contactRevealMatch = url.pathname.match(/^\/v1\/handovers\/(ho_[a-f0-9-]+)\/contact-reveal$/i);
    if (request.method === "POST" && contactRevealMatch) {
      if (!permit("contact:reveal")) return;
      let operationPayload;
      try { operationPayload = await readJsonBody(request); }
      catch (error) {
        sendError(response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.message);
        return;
      }
      const forbiddenFields = ["assignee", "actor", "staff_id", "contact_reference", "mobile", "phone", "value"]
        .filter((field) => operationPayload[field] !== undefined && operationPayload[field] !== null);
      if (forbiddenFields.length) {
        sendError(
          response,
          requestId,
          400,
          "CONTACT_REVEAL_SCOPE_OVERRIDE_FORBIDDEN",
          "联系方式与操作人只能由已接管任务和实名身份确定",
          forbiddenFields.map((field) => ({ field }))
        );
        return;
      }
      const tenantId = resolveTenant(operationPayload);
      if (!tenantId) return;
      const identity = await resolveHumanIdentity(
        tenantId,
        ["operations.agent"],
        ["operations.agent", "contact:reveal"]
      );
      if (!identity) return;
      const revealRequestId = String(request.headers["idempotency-key"] || "").trim();
      if (revealRequestId.length < 8 || revealRequestId.length > 160) {
        sendError(response, requestId, 400, "IDEMPOTENCY_KEY_REQUIRED", "查看联系方式必须提供8–160字符的一次性Idempotency-Key");
        return;
      }
      try {
        const contact = await revealContactForClaimedHandover({
          tenantId,
          handoverId:contactRevealMatch[1],
          actor:identity.subject,
          authorizedPrincipal:identity,
          revealRequestId,
          requestId
        });
        sendJson(response, requestId, 200, {
          data:contact,
          meta:{ cacheable:false, browser_storage_allowed:false },
          request_id:requestId
        }, {
          Pragma:"no-cache",
          Expires:"0"
        });
      } catch (error) {
        const status = Number(error.status) || 503;
        sendError(
          response,
          requestId,
          status,
          error.code || "CONTACT_REVEAL_FAILED",
          status >= 500 ? "联系方式保险库暂时不可用" : error.message,
          status >= 500 ? [] : error.details || [],
          { Pragma:"no-cache", Expires:"0" }
        );
      }
      return;
    }
    const legacyKnowledgeWrite = request.method === "POST" && url.pathname === "/v1/knowledge/releases";
    const humanOperationsWrite = request.method === "POST"
      && (claimMatch || completeMatch || url.pathname === "/v1/operations/human-work");
    const operationsWrite = humanOperationsWrite || legacyKnowledgeWrite;
    if (operationsWrite) {
      const permission = legacyKnowledgeWrite ? "knowledge:release" : "operations:write";
      if (!permit(permission)) return;
      let operationPayload;
      try { operationPayload = await readJsonBody(request); }
      catch (error) { sendError(response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.message); return; }
      const tenantId = resolveTenant(operationPayload);
      if (!tenantId) return;
      let operationsIdentity = null;
      if (humanOperationsWrite) {
        operationsIdentity = await resolveHumanIdentity(tenantId, ["operations.agent"]);
        if (!operationsIdentity) return;
        const claimedActorFields = ["assignee", "actor", "staff_id"]
          .filter((field) => operationPayload[field] !== undefined && operationPayload[field] !== null)
          .filter((field) => String(operationPayload[field]).trim() !== operationsIdentity.subject);
        if (claimedActorFields.length) {
          sendError(
            response,
            requestId,
            400,
            "OPERATIONS_ACTOR_OVERRIDE_FORBIDDEN",
            "人工操作人由企业实名令牌确定，不能由请求正文指定",
            claimedActorFields.map((field) => ({ field }))
          );
          return;
        }
      }
      let completionCacheKey = "";
      let completionClaim = null;
      try {
        if((claimMatch||completeMatch)&&operationsIdentity.departmentIds?.length&&!operationsIdentity.departmentIds.includes("*")){
          const item=await getHandover((claimMatch||completeMatch)[1],tenantId);
          if(!item||!operationsIdentity.departmentIds.includes(item.department))throw authorizationError("HANDOVER_DEPARTMENT_FORBIDDEN","接待事项不在当前授权科室范围",403);
        }
        if (claimMatch) {
          const handover = await claimHandover(claimMatch[1], { tenant_id:tenantId, assignee:operationsIdentity.subject });
          if (!handover) sendError(response, requestId, 404, "HANDOVER_NOT_FOUND", "未找到指定转人工任务");
          else sendJson(response, requestId, 200, { data:nonRevealPayload(handover), request_id:requestId });
          return;
        }
        if (completeMatch) {
          const completionScopeOverrides = ["conversation_id", "handover_id", "work_type", "occurred_at"]
            .filter((field) => operationPayload[field] !== undefined && operationPayload[field] !== null);
          if (completionScopeOverrides.length) {
            sendError(
              response,
              requestId,
              400,
              "HANDOVER_COMPLETION_SCOPE_OVERRIDE_FORBIDDEN",
              "会话、接管任务和工时类型由服务端已接管任务确定",
              completionScopeOverrides.map((field) => ({ field }))
            );
            return;
          }
          const idempotencyKey = String(request.headers["idempotency-key"] || "").trim();
          if (idempotencyKey.length < 8 || idempotencyKey.length > 160) {
            sendError(response, requestId, 400, "IDEMPOTENCY_KEY_REQUIRED", "完结接管必须提供8–160字符的Idempotency-Key");
            return;
          }
          completionCacheKey = scopedKey(
            "handover-completion",
            tenantId,
            operationsIdentity.subject,
            completeMatch[1],
            idempotencyKey
          );
          const completionHash = canonicalPayloadHash({
            operation:"handover.complete_with_work",
            handover_id:completeMatch[1],
            actor:operationsIdentity.subject,
            resolution:operationPayload.resolution,
            minutes:operationPayload.minutes,
            notes:operationPayload.notes
          });
          completionClaim = await idempotencyStore.claim(completionCacheKey, completionHash);
          if (completionClaim.status === "conflict") {
            sendError(response, requestId, 409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "同一幂等键不能用于不同的完结结果或工时");
            return;
          }
          if (completionClaim.status === "pending") {
            sendJson(response, requestId, 409, {
              error:{ code:"IDEMPOTENCY_IN_PROGRESS", message:"相同完结请求正在处理中，请稍后重试" },
              request_id:requestId
            }, { "Retry-After":"1" });
            return;
          }
          if (completionClaim.status === "replay") {
            sendJson(response, requestId, 200, {
              ...completionClaim.value,
              request_id:requestId,
              meta:{ ...(completionClaim.value?.meta || {}), replayed:true }
            }, { "X-Idempotent-Replay":"true" });
            return;
          }
          const completion = await completeHandoverWithWork(completeMatch[1], {
            tenant_id:tenantId,
            actor:operationsIdentity.subject,
            resolution:operationPayload.resolution,
            minutes:operationPayload.minutes,
            notes:operationPayload.notes
          });
          if (!completion) {
            await idempotencyStore.release(completionCacheKey, completionClaim.token);
            completionCacheKey = "";
            completionClaim = null;
            sendError(response, requestId, 404, "HANDOVER_NOT_FOUND", "未找到指定转人工任务");
          } else {
            const outbound = {
              data:nonRevealPayload(completion),
              meta:{ replayed:completion.replayed === true, atomic:true },
              request_id:requestId
            };
            const completed = await idempotencyStore.complete(completionCacheKey, outbound, completionClaim.token);
            if (!completed) {
              sendJson(response, requestId, 409, {
                error:{ code:"IDEMPOTENCY_CLAIM_LOST", message:"完结已安全提交，请使用相同幂等键重试以读取结果" },
                request_id:requestId
              }, { "Retry-After":"1" });
              return;
            }
            sendJson(response, requestId, 200, outbound);
          }
          return;
        }
        if (url.pathname === "/v1/operations/human-work") {
          sendJson(response, requestId, 201, {
            data:nonRevealPayload(await recordHumanWork({
              ...operationPayload,
              tenant_id:tenantId,
              staff_id:operationsIdentity.subject
            })),
            request_id:requestId
          });
          return;
        }
        if (productionRuntime) {
          sendError(response, requestId, 410, "KNOWLEDGE_LEGACY_PUBLISH_FORBIDDEN", "正式环境必须使用草稿、三次实名审核、索引绑定和激活流程");
          return;
        }
        const release = await publishKnowledgeRelease({ ...operationPayload, tenant_id:tenantId }, principal.caller_id);
        sendJson(response, requestId, 201, { data:release, request_id:requestId });
        return;
      } catch (error) {
        if (completionCacheKey && completionClaim?.token) {
          try { await idempotencyStore.release(completionCacheKey, completionClaim.token); } catch {}
        }
        const conflict = [
          "HANDOVER_ALREADY_CLOSED",
          "HANDOVER_ALREADY_CLAIMED",
          "HANDOVER_NOT_CLAIMED",
          "HANDOVER_ASSIGNEE_MISMATCH",
          "HANDOVER_COMPLETION_WORK_MISSING",
          "HANDOVER_COMPLETION_PAYLOAD_MISMATCH"
        ].includes(error.code);
        const dependencyFailure = /POSTGRES|REDIS|ECONN|TIMEOUT|DEPENDENCY/i.test(String(error.code || error.message || ""));
        const status = Number(error.status) || (conflict ? 409 : dependencyFailure ? 503 : 400);
        sendError(
          response,
          requestId,
          status,
          conflict ? error.code : dependencyFailure ? "DEPENDENCY_UNAVAILABLE" : error.code || "OPERATION_INVALID",
          dependencyFailure ? "运营数据服务暂时不可用" : error.message,
          dependencyFailure ? [] : error.details || []
        );
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/runs") {
      if (!permit("runs:read")) return;
      const tenantId = resolveTenant();
      if (!tenantId) return;
      sendJson(response, requestId, 200, { data:await listRunsAsync(url.searchParams.get("limit"), tenantId, "A-01"), request_id:requestId });
      return;
    }
    const runMatch = url.pathname.match(/^\/v1\/runs\/(run_[a-f0-9-]+)$/i);
    if (request.method === "GET" && runMatch) {
      if (!permit("runs:read")) return;
      const tenantId = resolveTenant();
      if (!tenantId) return;
      const run = await getRunAsync(runMatch[1], tenantId);
      if (!run || run.audit?.tenant_id !== tenantId) sendError(response, requestId, 404, "RUN_NOT_FOUND", "未找到指定运行记录");
      else sendJson(response, requestId, 200, { data:run, request_id:requestId });
      return;
    }
    const privacyRequestMatch = url.pathname.match(/^\/v1\/privacy\/requests\/(dsr_[A-Za-z0-9._:-]+)$/);
    const privacyTransitionMatch = url.pathname.match(/^\/v1\/privacy\/requests\/(dsr_[A-Za-z0-9._:-]+)\/transition$/);
    const privacyExecutionMatch = url.pathname.match(/^\/v1\/privacy\/requests\/(dsr_[A-Za-z0-9._:-]+)\/execution$/);
    const privacyExecutionPrepareMatch = url.pathname.match(/^\/v1\/privacy\/requests\/(dsr_[A-Za-z0-9._:-]+)\/execution\/prepare$/);
    const privacyExecutionApproveMatch = url.pathname.match(/^\/v1\/privacy\/requests\/(dsr_[A-Za-z0-9._:-]+)\/execution\/approve$/);
    const privacyCollection = url.pathname === "/v1/privacy/requests";
    const privacyRequestRoute = privacyCollection || privacyRequestMatch || privacyTransitionMatch
      || privacyExecutionMatch || privacyExecutionPrepareMatch || privacyExecutionApproveMatch;
    if (privacyRequestRoute) {
      const createRequest = privacyCollection && request.method === "POST";
      const listRequests = privacyCollection && request.method === "GET";
      const getRequest = Boolean(privacyRequestMatch) && request.method === "GET";
      const transitionRequest = Boolean(privacyTransitionMatch) && request.method === "POST";
      const getExecution = Boolean(privacyExecutionMatch) && request.method === "GET";
      const prepareExecution = Boolean(privacyExecutionPrepareMatch) && request.method === "POST";
      const approveExecution = Boolean(privacyExecutionApproveMatch) && request.method === "POST";
      if (!createRequest && !listRequests && !getRequest && !transitionRequest
          && !getExecution && !prepareExecution && !approveExecution) {
        sendError(response, requestId, 405, "METHOD_NOT_ALLOWED", "该个人信息权利接口不支持当前请求方法");
        return;
      }
      const permission = createRequest
        ? "privacy:request"
        : transitionRequest || prepareExecution || approveExecution
          ? "privacy:process"
          : "privacy:read";
      if (!permit(permission)) return;
      let privacyPayload = {};
      if (request.method === "POST") {
        try { privacyPayload = await readJsonBody(request); }
        catch (error) {
          sendError(response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.message);
          return;
        }
      }
      const tenantId = resolveTenant(privacyPayload);
      if (!tenantId) return;
      try {
        if (createRequest) {
          const rate = await consumeRateLimit(principal);
          if (!rate.allowed) {
            sendJson(response, requestId, 429, {
              error:{ code:"RATE_LIMITED", message:"请求较多，请稍后再试" }, request_id:requestId
            }, { "Retry-After":"60" });
            return;
          }
          const created = await createPrivacyRightsRequest(
            { ...privacyPayload, tenant_id:tenantId },
            { actor:principal.caller_id, source:`service:${principal.caller_id}` }
          );
          sendJson(response, requestId, 202, { data:created, request_id:requestId });
          return;
        }
        const requiredRoles = prepareExecution
          ? ["privacy.processor"]
          : approveExecution
            ? ["privacy.approver"]
            : ["privacy.processor", "privacy.approver"];
        const identity = await resolveHumanIdentity(tenantId, requiredRoles);
        if (!identity) return;
        if (listRequests) {
          const data = await listPrivacyRightsRequests(tenantId, {
            status:url.searchParams.get("status") || "",
            limit:url.searchParams.get("limit")
          });
          sendJson(response, requestId, 200, { data, request_id:requestId });
          return;
        }
        const matchedRequestId = privacyRequestMatch?.[1] || privacyTransitionMatch?.[1]
          || privacyExecutionMatch?.[1] || privacyExecutionPrepareMatch?.[1]
          || privacyExecutionApproveMatch?.[1];
        if (getRequest) {
          const data = await getPrivacyRightsRequest(tenantId, matchedRequestId);
          if (!data) sendError(response, requestId, 404, "PRIVACY_REQUEST_NOT_FOUND", "未找到个人信息权利请求");
          else sendJson(response, requestId, 200, { data, request_id:requestId });
          return;
        }
        if (getExecution) {
          const data = await getPrivacyRightsExecution(tenantId, matchedRequestId);
          if (!data) sendError(response, requestId, 404, "PRIVACY_EXECUTION_NOT_FOUND", "该请求尚未准备执行方案");
          else sendJson(response, requestId, 200, { data, request_id:requestId });
          return;
        }
        if (prepareExecution) {
          const data = await preparePrivacyRightsExecution({
            tenant_id:tenantId,
            request_id:matchedRequestId
          }, identity);
          sendJson(response, requestId, 201, { data, request_id:requestId });
          return;
        }
        if (approveExecution) {
          const data = await approvePrivacyRightsExecution({
            tenant_id:tenantId,
            request_id:matchedRequestId
          }, identity);
          sendJson(response, requestId, 200, { data, request_id:requestId });
          return;
        }
        const data = await transitionPrivacyRightsRequest({
          ...privacyPayload,
          tenant_id:tenantId,
          request_id:matchedRequestId
        }, identity);
        sendJson(response, requestId, 200, { data, request_id:requestId });
        return;
      } catch (error) {
        const dependencyFailure = /POSTGRES|REDIS|ECONN|TIMEOUT|DEPENDENCY/i.test(String(error.code || error.message || ""));
        sendError(
          response,
          requestId,
          error.status || (dependencyFailure ? 503 : 400),
          dependencyFailure ? "DEPENDENCY_UNAVAILABLE" : error.code || "PRIVACY_REQUEST_INVALID",
          dependencyFailure ? "个人信息权利请求服务暂时不可用" : error.message,
          dependencyFailure ? [] : error.details || []
        );
        return;
      }
    }
    const channelMatch = url.pathname.match(/^\/v1\/channels\/([^/]+)\/inbound$/);
    const unifiedReply = url.pathname === "/v1/conversations/reply";
    if (request.method !== "POST" || (!channelMatch && !unifiedReply)) {
      sendError(response, requestId, 404, "ENDPOINT_NOT_FOUND", "未找到指定售前智能体服务端点");
      return;
    }
    if (!permit("conversation:write")) return;
    let rate;
    try { rate = await consumeRateLimit(principal); }
    catch {
      sendError(response, requestId, 503, "RATE_LIMIT_STORE_UNAVAILABLE", "请求协调服务暂时不可用");
      return;
    }
    const rateHeaders = { "X-RateLimit-Limit":String(RATE_LIMIT), "X-RateLimit-Remaining":String(rate.remaining), "X-RateLimit-Reset":rate.resetAt };
    if (!rate.allowed) {
      sendJson(response, requestId, 429, { error:{ code:"RATE_LIMITED", message:"渠道请求较多，请稍后再试" }, request_id:requestId }, { ...rateHeaders, "Retry-After":"60" });
      return;
    }
    let payload;
    try { payload = await readJsonBody(request); }
    catch (error) {
      sendError(response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.message);
      return;
    }
    const tenantId = resolveTenant(payload);
    if (!tenantId) return;
    const forbiddenFormalLoadHeaders = [
      "x-huamei-formal-load-query",
      "x-huamei-formal-load-nonce",
      "x-huamei-formal-load-profile",
      "x-huamei-formal-load-ordinal",
      "x-huamei-formal-load-manifest-sha256"
    ].filter((name) => request.headers[name] !== undefined);
    if (forbiddenFormalLoadHeaders.length) {
      sendError(response, requestId, 400, "FORMAL_LOAD_TAXONOMY_UNSUPPORTED_INPUT", "正式容量请求只允许传递已批准的entry ID");
      return;
    }
    const formalLoadEntryId = String(request.headers[FORMAL_LOAD_TAXONOMY_HEADER] || "").trim();
    let formalLoadTaxonomyEntry = null;
    if (formalLoadEntryId) {
      if (!permit(FORMAL_LOAD_TAXONOMY_PERMISSION)) return;
      try {
        formalLoadTaxonomyEntry = await resolveFormalLoadTaxonomyEntry(formalLoadEntryId, { env:process.env });
        if (formalLoadTaxonomyEntry.tenantId !== tenantId) {
          sendError(response, requestId, 403, "FORMAL_LOAD_TAXONOMY_TENANT_MISMATCH", "正式容量entry不属于当前租户");
          return;
        }
      } catch (error) {
        observability.recordFormalLoadTaxonomy?.({
          outcome:"rejected",
          manifestSha256:process.env.HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256,
          signerId:"unverified"
        });
        sendError(response, requestId, error.status || 503, error.code || "FORMAL_LOAD_TAXONOMY_REJECTED", "正式容量taxonomy entry未通过批准清单校验");
        return;
      }
    }
    if (productionRuntime) {
      await ensureKnowledgeReleasePolicyFresh(tenantId);
      const domain = await getAcquisitionDomainStatus(tenantId);
      const externalDependencies = domain.status === "ok"
        ? await probeProductionExternalDependencies({ domain })
        : { ok:false, status:"not_ready" };
      const dataPlane = evaluateAcquisitionDataPlaneReadiness({ production:true, domain, externalDependencies });
      if (!dataPlane.ok) {
        sendError(
          response,
          requestId,
          503,
          "ACQUISITION_DATA_PLANE_NOT_READY",
          "售前智能体尚未完成正式知识发布或模型依赖验证，请转人工处理"
        );
        return;
      }
    }
    const idempotencyKey = String(request.headers["idempotency-key"] || "").trim().slice(0, 160);
    let cacheKey = "";
    let claim = null;
    try {
      const channel = channelMatch?.[1] || payload.channel || "api";
      const envelope = normalizeChannelInbound(channel, { ...payload, tenant_id:tenantId });
      const caller = principal.caller_id;
      const operation = unifiedReply ? "conversations.reply" : "channels.inbound";
      cacheKey = idempotencyKey ? scopedKey(
        "acquisition",
        envelope.tenant_id,
        caller,
        channel,
        envelope.conversation_id,
        operation,
        idempotencyKey
      ) : "";
      const payloadHash = cacheKey ? canonicalPayloadHash({
        operation,
        channel,
        payload,
        ...(formalLoadTaxonomyEntry ? { formal_load_entry_id:formalLoadTaxonomyEntry.entryId } : {})
      }) : "";
      if (cacheKey) {
        claim = await idempotencyStore.claim(cacheKey, payloadHash);
        if (claim.status === "conflict") {
          sendError(response, requestId, 409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "同一幂等键不能用于不同的请求内容");
          return;
        }
        if (claim.status === "pending") {
          sendJson(response, requestId, 409, { error:{ code:"IDEMPOTENCY_IN_PROGRESS", message:"相同请求正在处理中，请稍后重试" }, request_id:requestId }, { ...rateHeaders, "Retry-After":"1" });
          return;
        }
        if (claim.status === "replay") {
          const override = await acquisitionHandoverDeliveryOverride(envelope, null, { requestId });
          const replay = override ? (unifiedReply ? override : formatChannelOutbound(channel, override)) : claim.value;
          sendJson(response, requestId, 200, { ...replay, request_id:requestId }, { ...rateHeaders, "X-Idempotent-Replay":"true" });
          return;
        }
      }
      const result = await processAcquisitionEnvelope(envelope, {
        requestId,
        caller,
        ...(formalLoadTaxonomyEntry ? { formalLoadTaxonomyEntry } : {})
      });
      if (formalLoadTaxonomyEntry) {
        const applied = result.guardrails?.formal_load_taxonomy?.entry_id === formalLoadTaxonomyEntry.entryId
          && result.guardrails?.graphrag_query_sha256 === formalLoadTaxonomyEntry.querySha256;
        observability.recordFormalLoadTaxonomy?.({
          outcome:applied ? "applied" : "rejected",
          manifestSha256:formalLoadTaxonomyEntry.manifestSha256,
          signerId:formalLoadTaxonomyEntry.signerId
        });
        if (!applied) {
          if (cacheKey && claim?.token) {
            try { await idempotencyStore.release(cacheKey, claim.token); } catch {}
          }
          sendError(response, requestId, 503, "FORMAL_LOAD_TAXONOMY_NOT_APPLIED", "正式容量taxonomy entry未进入已验证GraphRAG调用");
          return;
        }
      }
      const outbound = unifiedReply ? result : formatChannelOutbound(channel, result);
      if (cacheKey && claim?.token) {
        const completed = await idempotencyStore.complete(cacheKey, outbound, claim.token);
        if (!completed) {
          sendJson(response, requestId, 409, { error:{ code:"IDEMPOTENCY_CLAIM_LOST", message:"请求处理权已过期，请使用相同幂等键重试" }, request_id:requestId }, { ...rateHeaders, "Retry-After":"1" });
          return;
        }
      }
      const override = await acquisitionHandoverDeliveryOverride(envelope, result, { requestId });
      sendJson(response, requestId, 200, override ? (unifiedReply ? override : formatChannelOutbound(channel, override)) : outbound, rateHeaders);
    } catch (error) {
      if (cacheKey && claim?.token) {
        try { await idempotencyStore.release(cacheKey, claim.token); } catch {}
      }
      const conversationConflictMessages = {
        CONVERSATION_MESSAGE_ID_REUSED:"同一message.id不能用于不同的消息内容",
        CONVERSATION_SEQUENCE_BUSY:"同一会话中更早的消息仍在处理中，请稍后重试当前消息",
        CONVERSATION_PREDECESSOR_FAILED:"同一会话中更早的消息处理超时，请先重发上一条消息",
        CONVERSATION_RECEIPT_FAILED_REPLAY_REQUIRED:"该消息此前处理超时，请使用相同message.id重新发送"
      };
      if (conversationConflictMessages[error.code]) {
        sendJson(response, requestId, 409, {
          error:{ code:error.code, message:conversationConflictMessages[error.code] },
          request_id:requestId
        }, {
          ...rateHeaders,
          ...(error.retryable ? { "Retry-After":String(error.retry_after_seconds || 1) } : {})
        });
        return;
      }
      const validation = ["VALIDATION_ERROR", "UNSUPPORTED_CHANNEL", "INVALID_TENANT_ID"].includes(error.code);
      const dependencyFailure = /POSTGRES|REDIS|ECONN|TIMEOUT|DEPENDENCY|STORE_UNAVAILABLE/i.test(String(error.code || error.message || ""));
      sendError(
        response,
        requestId,
        validation ? 400 : dependencyFailure ? 503 : 500,
        validation ? error.code : dependencyFailure ? "DEPENDENCY_UNAVAILABLE" : "ACQUISITION_AGENT_ERROR",
        validation ? error.message : dependencyFailure ? "售前智能体依赖暂时不可用" : "售前智能体暂时不可用",
        validation ? error.details || [] : []
      );
    }
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const dependencyFailure = /POSTGRES|REDIS|ECONN|TIMEOUT|DEPENDENCY/i.test(String(error.code || error.message || ""));
      sendError(
        response,
        requestId,
        dependencyFailure ? 503 : 500,
        dependencyFailure ? "DEPENDENCY_UNAVAILABLE" : "ACQUISITION_SERVICE_ERROR",
        dependencyFailure ? "售前智能体依赖暂时不可用" : "售前智能体暂时不可用"
      );
    });
  };
  const server = createServer(createObservedHttpHandler(applicationHandler, {
    observability,
    environment:runtimeEnvironment,
    service:observability.service,
    logger:observability.logger,
    routeResolver:routeTemplateForRequest
  }));
  // Keep pooled service-to-service sockets alive across sustained bursts. Node's
  // five-second default can close sockets between waves of a 500-client test.
  server.keepAliveTimeout = Math.max(10_000, Number(process.env.HUAMEI_ACQUISITION_KEEP_ALIVE_TIMEOUT_MS || 65_000));
  server.headersTimeout = Math.max(server.keepAliveTimeout + 1_000, Number(process.env.HUAMEI_ACQUISITION_HEADERS_TIMEOUT_MS || 70_000));
  server.requestTimeout = Math.max(5_000, Number(process.env.HUAMEI_ACQUISITION_REQUEST_TIMEOUT_MS || 30_000));
  server.maxRequestsPerSocket = Math.max(100, Number(process.env.HUAMEI_ACQUISITION_MAX_REQUESTS_PER_SOCKET || 1_000));
  return server;
}

export async function startAcquisitionService(options = {}) {
  const host = options.host || process.env.HUAMEI_ACQUISITION_SERVICE_HOST || "127.0.0.1";
  const port = Number(options.port ?? process.env.HUAMEI_ACQUISITION_SERVICE_PORT ?? 4180);
  await initializeAcquisitionServiceRuntime();
  const server = createAcquisitionServiceServer({
    host,
    metricsToken:options.metricsToken,
    observability:options.observability
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (productionRuntime && !knowledgeRefreshTimer) {
    const refreshIntervalMs = Math.max(1_000, Number(process.env.HUAMEI_KNOWLEDGE_RELEASE_REFRESH_MS || 5_000));
    knowledgeRefreshTimer = setInterval(() => {
      refreshKnowledgeReleasePolicy().catch((error) => {
        console.error(`知识发布缓存刷新失败：${error.code || error.message}`);
      });
    }, refreshIntervalMs);
    knowledgeRefreshTimer.unref?.();
    server.once("close", () => {
      if (knowledgeRefreshTimer) clearInterval(knowledgeRefreshTimer);
      knowledgeRefreshTimer = null;
    });
  }
  console.log(`售前智能体独立服务已启动：http://${host}:${address.port}`);
  console.log(`渠道列表：http://${host}:${address.port}/v1/channels`);
  return server;
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));
if (isEntryPoint) {
  const server = await startAcquisitionService();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await flushAcquisitionSessions(); } catch (error) {
      console.error(`会话刷新失败：${error.code || error.message}`);
    }
    server.close(async () => {
      await closeAcquisitionServiceRuntime();
      process.exit(0);
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
