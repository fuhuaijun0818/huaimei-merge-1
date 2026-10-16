import { applyManagementAccount, listManagementAccounts, saveManagementAccount } from "./platform/management-accounts.mjs";
import { listKnowledgePublications, createKnowledgePublication, mutateKnowledgePublication } from "./knowledge-publication.mjs";
import { memberRepeatCheckConfiguration } from "./integrations/member-repeatcheck-client.mjs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { AGENT_DEFINITIONS, getRun, invokeAgentAsync, listRuns, routeAgent, validateInvocation } from "./agent-runtime.mjs";
import { callAcquisitionAdminOperation, callAcquisitionChannel, callAcquisitionLegacyInvocation, getAcquisitionServiceRun, getAcquisitionServiceStatus, listAcquisitionServiceChannels, listAcquisitionServiceRuns, submitAcquisitionConversationFeedback } from "./acquisition-service-client.mjs";
import {
  acquisitionCustomerSnapshot, getCapturedLeadReferenceForSession, upsertAcquisitionLead
} from "./lead-store.mjs";
import { revealContactForClaimedAppointment } from "./contact-vault.mjs";
import { appointmentDateRecommendations } from "./appointment-time.mjs";
import {
  claimAppointmentIntake, createAppointmentIntake, createInternalScheduleSlot,
  getAppointmentIntake, listAppointmentIntakes, listInternalScheduleSlots,
  resolveAppointmentIntake, changeCustomerAppointment
} from "./appointment-intake-store.mjs";
import { getLlmStatus } from "./llm-client.mjs";
import { publicKnowledgeMediaDenial, resolvePublicKnowledgeMedia } from "./knowledge-media.mjs";
import { getKnowledgeGovernanceOverview } from "./knowledge-governance-overview.mjs";
import {
  completeKnowledgeIntakeAsset, createKnowledgeIntakeDocument,
  listKnowledgeIntakeDocuments, prepareKnowledgeIntakeAsset,
  saveKnowledgeIntakeAssetContent, getKnowledgeIntakeDocument,
  updateKnowledgeIntakeDocument, recordKnowledgeIntakeConfirmation, submitKnowledgeIntakeDocument
} from "./knowledge-intake-store.mjs";
import { ensureKnowledgeReleasePolicyFresh } from "./knowledge-release-policy.mjs";
import { createOpenApiDocument } from "./openapi.mjs";
import {
  cancelPhysicianAvatarJob, completePhysicianAvatarAsset, createPhysicianAvatarJob, deletePhysicianAvatarJob,
  getPhysicianAvatarJob, getPhysicianAvatarRuntimeStatus, getPhysicianAvatarWorkMedia,
  listPhysicianAvatarJobs, preparePhysicianAvatarAsset, reconcileMiniMaxCallback,
  savePhysicianAvatarAssetContent, verifyMiniMaxCallbackToken
} from "./physician-avatar-runtime.mjs";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { normalizeTenantId } from "./platform/tenant-context.mjs";
import {
  canonicalPayloadHash,
  createRequestSecurityStores,
  resolvePublicSession,
  scopedKey
} from "./platform/request-security.mjs";
import { getPostgresClient } from "./platform/postgres.mjs";
import { createProductionReadiness } from "./platform/production-readiness.mjs";
import { appendAuditEvent } from "./persistence/postgres-helpers.mjs";
import { appendLocalConversationMessage, readLocalConversationRecord } from "./local-conversation-store.mjs";
import { getHandover } from "./acquisition-operations-store.mjs";
import {
  authorizeManagementPrincipal,
  createManagementAuthorizer,
  MANAGEMENT_ROLES
} from "./platform/management-authorization.mjs";
import {
  PHASE_ONE_BUSINESS_ROLES,
  PHASE_ONE_CAPABILITIES, hasPhaseOneCapability,
  normalizePhaseOneBusinessRole,
  phaseOneTechnicalRolesFor
} from "./platform/phase-one-role-policy.mjs";
import { assertManagementRequestOrigin } from "./platform/management-request-origin.mjs";
import { createRequestContext } from "./observability/index.mjs";
import {
  getManagementDomainOverlay,
  replaceManagementDomainOverlay
} from "./management-domain-store.mjs";

export const DEMO_API_KEY = "hm_local_demo_key_2026";
const API_KEY = process.env.HUAMEI_API_KEY || DEMO_API_KEY;
const RATE_LIMIT = Math.max(10, Number(process.env.HUAMEI_API_RATE_LIMIT || 60));
const PUBLIC_WEB_RATE_LIMIT = Math.max(5, Number(process.env.HUAMEI_PUBLIC_WEB_RATE_LIMIT || 20));
// 流式答复的片段间隔：让客户能看到“生成中”的过程。接入真实模型后该值只作为
// 兜底节流，token 到达即推送。
const PUBLIC_CHAT_STREAM_PACING_MS = Math.max(0, Math.min(Number(process.env.HUAMEI_CHAT_STREAM_PACING_MS || 60), 1_000));
const MAX_BODY_BYTES = 64 * 1024;
// The management overlay contains only operator-maintained records and source
// overrides, never the full knowledge package. A dedicated cap lets a real
// catalog edit complete without weakening public API request limits.
const MAX_MANAGEMENT_OVERLAY_BODY_BYTES = 512 * 1024;
const PUBLIC_TENANT_ID = normalizeTenantId(
  process.env.HUAMEI_PUBLIC_TENANT_ID || process.env.HUAMEI_DEFAULT_TENANT_ID || "huamei-shanghai"
);
const runtimeEnvironment = String(
  process.env.HUAMEI_RUNTIME_ENV || process.env.HUAMEI_DEPLOYMENT_ENV || process.env.NODE_ENV || "development"
).trim().toLowerCase();
const productionRuntime = ["prod", "production"].includes(runtimeEnvironment);
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
const managementAuthorizer = createManagementAuthorizer({ env:process.env });
let startupReadiness = productionRuntime ? null : {
  ok:true,
  status:"not_required",
  environment:runtimeEnvironment,
  checked_at:new Date().toISOString()
};
const authenticatedAdminRequests = new WeakSet();
const managedAccountPrincipals = new WeakMap();

const readinessFailure = (report) => {
  const error = new Error("Gateway production dependencies are not ready");
  error.code = "PRODUCTION_DEPENDENCIES_NOT_READY";
  error.report = report;
  return error;
};

export async function initializeApiRuntime() {
  if (!productionRuntime) return startupReadiness;
  productionReadiness.assert({ production:true });
  const report = await productionReadiness.health();
  if (!report.ok) throw readinessFailure(report);
  startupReadiness = report;
  return report;
}

export async function getApiInfrastructureReadiness() {
  if (!productionRuntime) return startupReadiness;
  return productionReadiness.health();
}

export async function closeApiRuntime() {
  if (productionReadiness) await productionReadiness.close();
}

// Production management HTML is expected to sit behind a supported external
// OIDC authorization-code/PKCE proxy. The proxy keeps its browser session in
// Redis and injects the verified access token on every upstream request; Node
// still verifies that token and never trusts proxy identity headers alone.
export async function authenticateManagementSurfaceRequest(request) {
  if (!productionRuntime) return null;
  assertManagementRequestOrigin(request);
  return managementAuthorizer.authorize(request, {
    requiredAnyCapabilities:[
      PHASE_ONE_CAPABILITIES.platformManage,
      PHASE_ONE_CAPABILITIES.conversationsReadAssigned
    ],
    tenantId:PUBLIC_TENANT_ID,
    tenantField:"token.tenant_ids"
  });
}

// Only the HTTP server can place the original IncomingMessage in this WeakSet
// after validating Basic credentials. Deliberately do not derive this trust
// from a request header: every header is controlled by the remote caller.
export const markAdminRequestAuthenticated = (request, principal=null) => {
  if(principal) managedAccountPrincipals.set(request,principal);
  if (request && typeof request === "object") authenticatedAdminRequests.add(request);
};

const defaultOrigins = ["http://127.0.0.1:4173", "http://localhost:4173", "http://127.0.0.1:4174", "http://localhost:4174"];
const configuredOrigins = String(process.env.HUAMEI_ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : defaultOrigins);

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
};

const requestIdFor = (request) => {
  return createRequestContext({
    headers:request.headers,
    service:"huamei-web-gateway"
  }).requestId;
};

const corsHeaders = (request) => {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials":"true",
    "Access-Control-Expose-Headers": "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Idempotent-Replay, Retry-After",
    Vary: "Origin"
  };
};

const commonHeaders = (request, requestId) => ({
  ...corsHeaders(request),
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Request-Id": requestId
});

const sendJson = (request, response, requestId, status, payload, extraHeaders = {}) => {
  response.writeHead(status, { ...commonHeaders(request, requestId), ...extraHeaders });
  response.end(JSON.stringify(payload, null, 2));
};

const sendError = (request, response, requestId, status, code, message, details = [], extraHeaders = {}) => {
  sendJson(request, response, requestId, status, { error: { code, message, ...(details.length ? { details } : {}) }, request_id: requestId }, extraHeaders);
};

const readJsonBody = async (request, maxBytes = MAX_BODY_BYTES) => {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("BODY_TOO_LARGE");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("INVALID_JSON");
    error.code = "INVALID_JSON";
    throw error;
  }
};

const readBinaryBody = async (request, maxBytes) => {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("BODY_TOO_LARGE");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const authenticate = (request) => safeEqual(request.headers["x-api-key"], API_KEY);
const isLoopbackRequest = (request) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(request.socket.remoteAddress || ""));
const isLoopbackServer = ["127.0.0.1", "localhost", "::1"].includes(String(process.env.HUAMEI_HOST || "127.0.0.1"));
const externalTestRuntime = String(process.env.HUAMEI_EXTERNAL_TEST_MODE || "false").toLowerCase() === "true";
const isLocalManagementRequest = (request) => authenticatedAdminRequests.has(request)
  || (!externalTestRuntime && isLoopbackServer && isLoopbackRequest(request));
// 本地开发身份只能从服务端环境读取，绝不能信任浏览器伪造的用户标识请求头。
const localUserId = () => {
  const configured = String(process.env.HUAMEI_LOCAL_ADMIN_SUBJECT || "admin-xuning").trim();
  return /^[a-z0-9][a-z0-9_.:@/-]{2,127}$/i.test(configured) ? configured : "admin-xuning";
};

const authorizeManagementRequest = async (request, requirements = {}) => {
  assertManagementRequestOrigin(request);
  if (!productionRuntime) {
    if (!isLocalManagementRequest(request)) {
      const error = new Error("该接口仅允许本机管理端访问");
      error.code = "LOCAL_ONLY";
      error.status = 403;
      throw error;
    }
    if(managedAccountPrincipals.has(request)) return authorizeManagementPrincipal(await applyManagementAccount(managedAccountPrincipals.get(request),PUBLIC_TENANT_ID,{required:true}),requirements);
    const configuredRole = normalizePhaseOneBusinessRole(
      process.env.HUAMEI_LOCAL_MANAGEMENT_ROLE || PHASE_ONE_BUSINESS_ROLES.administrator
    );
    if (!configuredRole) {
      const error = new Error("HUAMEI_LOCAL_MANAGEMENT_ROLE must be 管理员 or 售前人员");
      error.code = "LOCAL_MANAGEMENT_ROLE_INVALID";
      error.status = 503;
      throw error;
    }
    const subject = localUserId();
    return {
      ...authorizeManagementPrincipal({
        subject,
        displayName:subject,
        roles:["development:admin", configuredRole, ...phaseOneTechnicalRolesFor(configuredRole)],
        phaseOneRole:configuredRole,
        tenantIds:[requirements.tenantId ? normalizeTenantId(requirements.tenantId) : PUBLIC_TENANT_ID],
        departmentIds:["*"],
        issuer:"urn:huamei:local-management"
      }, requirements),
      developmentCompatibility:true
    };
  }
  assertManagementRequestOrigin(request);
  const verified=await managementAuthorizer.authorize(request, {tenantId:requirements.tenantId});
  return authorizeManagementPrincipal(await applyManagementAccount(verified,verified.tenantId,{required:true}),requirements);
};

const managementDepartmentScope = (principal) => principal?.developmentCompatibility
  ? ["*"]
  : Array.isArray(principal?.departmentIds) ? principal.departmentIds : [];

const assertManagementPayloadTenant = (payload, principal) => {
  const supplied = payload?.tenant_id ?? payload?.tenantId;
  if (supplied === undefined || supplied === null || String(supplied).trim() === "") return;
  let tenantId;
  try { tenantId = normalizeTenantId(supplied); }
  catch (cause) {
    cause.status = 400;
    throw cause;
  }
  if (tenantId !== principal.tenantId) {
    const error = new Error("OIDC identity is not authorized for the request body tenant");
    error.code = "OIDC_TENANT_FORBIDDEN";
    error.status = 403;
    throw error;
  }
};

const recordManagementAccess = async ({
  principal,
  requestId,
  request,
  action,
  resourceType,
  resourceId = "",
  outcome = "success"
}) => {
  if (!productionRuntime) return;
  const database = getPostgresClient({ env:process.env });
  try {
    await database.tenantTransaction(principal.tenantId, (client) => appendAuditEvent(client, {
      tenantId:principal.tenantId,
      eventId:`audit_management_${randomUUID()}`,
      actorType:"human",
      actorId:principal.subject,
      action,
      resourceType,
      resourceId:resourceId || requestId,
      requestId,
      outcome,
      details:{ method:request.method, route:new URL(request.url, "http://management.local").pathname }
    }));
  } catch {
    const error = new Error("管理访问审计暂时不可用");
    error.code = "MANAGEMENT_AUDIT_UNAVAILABLE";
    error.status = 503;
    throw error;
  }
};

const sendManagementAuthorizationError = (request, response, requestId, error) => {
  sendError(
    request,
    response,
    requestId,
    error.status || 401,
    error.code || "OIDC_AUTHORIZATION_FAILED",
    error.status === 503 ? "管理端身份服务暂时不可用" : (error.message || "管理端身份或权限校验失败"),
    error.details || [],
    error.status === 401 ? { "WWW-Authenticate":'Bearer realm="Huamei Admin"' } : {}
  );
};

// 售前工作台不应取得整份运营覆盖层（人员、智能体、医院数据、审计与知识
// 覆盖项）。当前一期在同一个前端应用中运行，因此先在 BFF 边界裁剪成
// “已进入聊天的客户 + 会话 + 话术”工作集；后续渠道 IM 的实时收件箱会替代
// 这一兼容读取路径。
const presalesOverlayView = (record = {}, principal) => {
  const overlay = record?.overlay || {};
  const conversations = (Array.isArray(overlay.conversations) ? overlay.conversations : []).filter(item=>item.assignee===principal.subject && (principal.departmentIds.includes("*")||principal.departmentIds.includes(item.department)));
  const customerIds = new Set(conversations.map((item) => String(item?.customerId || "")).filter(Boolean));
  const visibleCustomers = (Array.isArray(overlay.customers) ? overlay.customers : [])
    .filter((item) => customerIds.has(String(item?.id || "")));
  const visibleTasks = (Array.isArray(overlay.tasks) ? overlay.tasks : [])
    .filter((item) => customerIds.has(String(item?.customerId || "")));
  const templates = (Array.isArray(overlay.configurationRecords) ? overlay.configurationRecords : [])
    .filter((item) => item?.kind === "message_template" && item?.presalesVisible !== false);
  // 会话接待需要展示当前售前的昵称和工号，但不需要暴露管理员、组织、
  // 权限或审计资料。只下发已启用售前人员的最小展示字段。
  const presalesRoster = (Array.isArray(overlay.managementUsers) ? overlay.managementUsers : [])
    .filter((item) => item?.status === "启用" && (item?.roleId === "R-PRESALES" || item?.role === "售前人员"))
    .map((item) => ({
      id:String(item.id || ""),
      name:String(item.name || ""),
      nickname:String(item.nickname || item.name || ""),
      staffId:String(item.staffId || item.account || ""),
      account:String(item.account || ""),
      role:"售前人员",
      status:"启用"
    }));
  return {
    ...record,
    updated_by:null,
    overlay:{
      currentRole:"售前人员",
      managementUsers:presalesRoster,
      managementRoles:[],
      customers:visibleCustomers,
      tasks:visibleTasks,
      conversations,
      journeys:[],
      agents:[],
      connectors:[],
      audit:[],
      handovers:[],
      configurationRecords:templates,
      productOverrides:[],
      physicianOverrides:[],
      knowledgeOverrides:[]
    }
  };
};

const sendMedia = (request, response, media, options = {}) => {
  const range = request.headers.range;
  const common = {
    "Content-Type":media.mime,
    "Accept-Ranges":"bytes",
    "Cache-Control":options.cacheControl || "private, max-age=3600",
    "X-Content-Type-Options":"nosniff",
    ...(options.contentDisposition ? { "Content-Disposition":options.contentDisposition } : {})
  };
  if (!range) {
    response.writeHead(200, { ...common, "Content-Length":String(media.size) });
    createReadStream(media.path).pipe(response);
    return;
  }
  const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) { response.writeHead(416, { "Content-Range":`bytes */${media.size}` }); response.end(); return; }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), media.size - 1) : media.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= media.size) { response.writeHead(416, { "Content-Range":`bytes */${media.size}` }); response.end(); return; }
  response.writeHead(206, { ...common, "Content-Length":String(end - start + 1), "Content-Range":`bytes ${start}-${end}/${media.size}` });
  createReadStream(media.path, { start, end }).pipe(response);
};

const consumeRateLimit = (request) => rateLimitStore.consume(
  scopedKey("authenticated", request.headers["x-api-key"] || request.socket.remoteAddress || "anonymous"),
  { limit:RATE_LIMIT, windowMs:60_000 }
);

const consumePublicRateLimit = ({ tenantId, operation, session }) => rateLimitStore.consume(
  scopedKey("public", tenantId, operation, session.rateIdentity),
  { limit:PUBLIC_WEB_RATE_LIMIT, windowMs:60_000 }
);

const resolvePublicTenant = (request, payload = {}) => {
  const supplied = [
    { field:"header.x-tenant-id", value:request.headers["x-tenant-id"] },
    { field:"body.tenant_id", value:payload.tenant_id },
    { field:"body.tenantId", value:payload.tenantId },
    { field:"body.context.tenant_id", value:payload.context?.tenant_id },
    { field:"body.context.tenantId", value:payload.context?.tenantId }
  ].filter((item) => String(item.value || "").trim());
  for (const item of supplied) {
    const tenantId = normalizeTenantId(item.value);
    if (tenantId !== PUBLIC_TENANT_ID) {
      const error = new Error("公网页面已绑定固定租户，请求不能覆盖tenant_id");
      error.code = "TENANT_ACCESS_DENIED";
      error.status = 403;
      error.details = [{ field:item.field, message:"必须与网关已绑定租户一致" }];
      throw error;
    }
  }
  return PUBLIC_TENANT_ID;
};

export async function handleApiRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (!url.pathname.startsWith("/api/")) return false;
  const requestId = requestIdFor(request);
  const origin = request.headers.origin;

  if (request.method === "OPTIONS") {
    if (origin && !allowedOrigins.has(origin)) {
      sendError(request, response, requestId, 403, "ORIGIN_NOT_ALLOWED", "该浏览器Origin未在允许列表中");
      return true;
    }
    response.writeHead(204, {
      ...corsHeaders(request),
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key, X-Request-Id, X-Client-Id, X-Huamei-User-Id, X-Huamei-Session-Token, X-Session-Token, Idempotency-Key, Authorization",
      "Access-Control-Max-Age": "600",
      "X-Request-Id": requestId
    });
    response.end();
    return true;
  }

  if (origin && !allowedOrigins.has(origin)) {
    sendError(request, response, requestId, 403, "ORIGIN_NOT_ALLOWED", "该浏览器Origin未在允许列表中");
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(request, response, requestId, 200, {
      status:"ok",
      service:"huamei-web-gateway",
      version:"2.1.0",
      ...(process.env.HUAMEI_TEST_INSTANCE_ID ? { test_instance_id:process.env.HUAMEI_TEST_INSTANCE_ID } : {}),
      time:new Date().toISOString()
    });
    return true;
  }

  // 任何形状的资料链接都在这里收口：可交付的按素材返回，其余给出说明原因的
  // 404/410，而不是漏到需要 API Key 的路由上报“缺少 X-API-Key”（A-025 AC4）。
  const publicKnowledgeMediaMatch = url.pathname.match(/^\/api\/public\/knowledge-media\/([^/]+)$/i);
  if (request.method === "GET" && publicKnowledgeMediaMatch) {
    const media = resolvePublicKnowledgeMedia(publicKnowledgeMediaMatch[1]);
    if (!media) {
      // 已撤回/已过期的素材给出可区分的原因，其余一律不暴露存在性（A-025 AC4）。
      const denial = publicKnowledgeMediaDenial(publicKnowledgeMediaMatch[1]);
      if (denial) {
        sendError(request, response, requestId, denial.status, denial.code, denial.message);
        return true;
      }
      sendError(request, response, requestId, 404, "PUBLIC_MEDIA_NOT_FOUND", "未找到可公开发送的资料图片");
      return true;
    }
    sendMedia(request, response, media, { cacheControl:"public, max-age=3600", contentDisposition:"inline" });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/ready") {
    if (!authenticate(request)) {
      sendError(request, response, requestId, 401, "UNAUTHORIZED", "详细就绪状态仅允许内网或已鉴权调用方访问");
      return true;
    }
    const [acquisitionService, llm, infrastructure] = await Promise.all([
      getAcquisitionServiceStatus(),
      Promise.resolve(getLlmStatus()),
      getApiInfrastructureReadiness()
    ]);
    const acquisitionReady = acquisitionService.reachable === true && acquisitionService.status !== "degraded";
    const ready = acquisitionReady && infrastructure.ok === true;
    sendJson(request, response, requestId, ready ? 200 : 503, {
      status:ready ? "ready" : "not_ready",
      service:"huamei-web-gateway",
      version:"2.1.0",
      checks:{
        acquisition_service:acquisitionService,
        llm:{ enabled:llm.enabled, configured:llm.configured, provider:llm.provider, model:llm.model, mode:llm.mode },
        request_security:{
          backend:requestSecurityStores.backend,
          rate_limit_driver:rateLimitStore.driver,
          idempotency_driver:idempotencyStore.driver
        },
        infrastructure
      },
      time:new Date().toISOString()
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/openapi.json") {
    sendJson(request, response, requestId, 200, createOpenApiDocument(`${url.protocol}//${url.host}`));
    return true;
  }

  // Local management data is server-owned even in the self-contained phase.
  // This endpoint deliberately persists only the operator overlay; the large
  // knowledge import remains a controlled, read-only source baseline inside
  // the application bundle and is never re-posted on every customer update.
  if (url.pathname === "/api/admin/management/domain-overlay") {
    const read = request.method === "GET";
    const write = request.method === "PUT";
    if (!read && !write) {
      sendError(request, response, requestId, 405, "METHOD_NOT_ALLOWED", "该管理端点仅支持读取或保存", [], { Allow:"GET, PUT" });
      return true;
    }
    let payload = {};
    if (write) {
      try { payload = await readJsonBody(request, MAX_MANAGEMENT_OVERLAY_BODY_BYTES); }
      catch (error) {
        const tooLarge = error.code === "BODY_TOO_LARGE";
        sendError(request, response, requestId, tooLarge ? 413 : 400, tooLarge ? "BODY_TOO_LARGE" : "INVALID_JSON", tooLarge ? "单次管理保存不能超过512KB" : "请求体不是有效JSON");
        return true;
      }
      const identityOverrideFields = ["tenant_id", "tenantId", "actor", "actor_id", "actorId", "subject"]
        .filter((field) => payload[field] !== undefined);
      if (identityOverrideFields.length) {
        sendError(request, response, requestId, 400, "ADMIN_IDENTITY_OVERRIDE_FORBIDDEN", "租户与操作人只能来自已验证的管理身份", identityOverrideFields.map((field) => ({ field })));
        return true;
      }
    }
    const requestedTenant = url.searchParams.get("tenant_id") || PUBLIC_TENANT_ID;
    const idempotencyKey = String(request.headers["idempotency-key"] || "").trim();
    if (write && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
      sendError(request, response, requestId, 400, "IDEMPOTENCY_KEY_REQUIRED", "管理数据写操作必须提供8–128字符的Idempotency-Key");
      return true;
    }
    let principal;
    try {
      principal = await authorizeManagementRequest(request, {
        // 写入整份运营覆盖层属于平台运营权限；售前只能读取经 BFF 裁剪后的
        // 客户会话工作集，不能把浏览器中的任意数据回写为全局配置。
        ...(write
          ? { requiredCapabilities:[PHASE_ONE_CAPABILITIES.platformManage] }
          : { requiredAnyCapabilities:[PHASE_ONE_CAPABILITIES.platformManage, PHASE_ONE_CAPABILITIES.conversationsReadAssigned] }),
        tenantId:requestedTenant,
        tenantField:"query.tenant_id"
      });
      await recordManagementAccess({
        principal,
        requestId,
        request,
        action:write ? "management.domain_overlay.write" : "management.domain_overlay.read",
        resourceType:"management_domain_overlay",
        resourceId:principal.tenantId
      });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }
    try {
      if (read) {
        const record = getManagementDomainOverlay({ tenantId:principal.tenantId });
        const data = hasPhaseOneCapability(principal, PHASE_ONE_CAPABILITIES.superadminManage) ? record : principal.phaseOneRole === PHASE_ONE_BUSINESS_ROLES.presales ? presalesOverlayView(record, principal) : {...record,overlay:{...record.overlay,customers:[],conversations:[],tasks:[],knowledgeOverrides:[],managementUsers:[],managementRoles:[]}};
        sendJson(request, response, requestId, 200, { data, request_id:requestId });
        return true;
      }
      const previousOverlay=getManagementDomainOverlay({tenantId:principal.tenantId}).overlay;
      const protectedKeys=["customers","conversations","tasks","knowledgeOverrides","managementUsers","managementRoles"];
      if(protectedKeys.some(key=>JSON.stringify(payload.overlay?.[key]??[])!==JSON.stringify(previousOverlay?.[key]??[])))throw Object.assign(new Error("请使用对应业务模块办理客户、人员和知识操作"),{status:403,code:"MANAGEMENT_OVERLAY_BUSINESS_WRITE_FORBIDDEN"});
      const result = replaceManagementDomainOverlay({
        tenantId:principal.tenantId,
        expectedRevision:payload.revision,
        overlay:payload.overlay,
        actor:principal.subject,
        idempotencyKey
      });
      sendJson(request, response, requestId, result.replayed ? 200 : 201, {
        data:result,
        meta:{ replayed:result.replayed === true },
        request_id:requestId
      }, result.replayed ? { "X-Idempotent-Replay":"true" } : {});
    } catch (error) {
      const status = Number(error.status) || 400;
      sendError(request, response, requestId, status, error.code || "MANAGEMENT_DOMAIN_OPERATION_INVALID", error.message || "管理数据保存失败", error.details || []);
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/webhooks/minimax/video") {
    const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const suppliedToken = url.searchParams.get("token") || bearer;
    if (!verifyMiniMaxCallbackToken(suppliedToken)) {
      sendError(request, response, requestId, 401, "INVALID_CALLBACK_TOKEN", "MiniMax回调Token校验失败");
      return true;
    }
    let payload;
    try { payload = await readJsonBody(request); }
    catch { sendError(request, response, requestId, 400, "INVALID_JSON", "回调请求体不是有效JSON"); return true; }
    if (typeof payload.challenge === "string") {
      sendJson(request, response, requestId, 200, { challenge:payload.challenge });
      return true;
    }
    const providerTaskId = payload.task?.id || payload.task_id;
    if (!providerTaskId) { sendError(request, response, requestId, 400, "MISSING_PROVIDER_TASK_ID", "回调缺少供应商任务编号"); return true; }
    const job = await reconcileMiniMaxCallback(String(providerTaskId));
    sendJson(request, response, requestId, job ? 202 : 404, job ? { accepted:true, generationJobId:job.generationJobId, status:job.status } : { error:{ code:"JOB_NOT_FOUND", message:"未找到对应本地任务" }, request_id:requestId });
    return true;
  }

  if (url.pathname === "/api/admin/accounts") {
    try {
      const p=await authorizeManagementRequest(request,{tenantId:PUBLIC_TENANT_ID,requiredCapabilities:[PHASE_ONE_CAPABILITIES.usersManage]});
      if(request.method==='GET')sendJson(request,response,requestId,200,{data:await listManagementAccounts(p)});
      else if(request.method==='POST') {const input=await readJsonBody(request,32*1024);sendJson(request,response,requestId,200,{data:await saveManagementAccount(input,p)});}
      else sendError(request,response,requestId,405,'METHOD_NOT_ALLOWED','该接口支持读取与保存');
    }catch(e){sendError(request,response,requestId,e.status||503,e.code||'MANAGEMENT_ACCOUNTS_UNAVAILABLE',e.status?e.message:'人员权限服务暂时不可用');}
    return true;
  }
  if (url.pathname === "/api/admin/identity" && request.method === "GET") {
    try { const p=await authorizeManagementRequest(request,{tenantId:PUBLIC_TENANT_ID});
      sendJson(request,response,requestId,200,{data:{subject:p.subject,role:p.phaseOneRole,capabilities:p.phaseOneCapabilities,departments:p.departmentIds}});
    } catch(e) {sendManagementAuthorizationError(request,response,requestId,e);}
    return true;
  }
  if (url.pathname === "/api/admin/integrations/member-check" && request.method === "GET") {
    try { await authorizeManagementRequest(request,{tenantId:PUBLIC_TENANT_ID,requiredCapabilities:[PHASE_ONE_CAPABILITIES.integrationsManage]});
      sendJson(request,response,requestId,200,{data:memberRepeatCheckConfiguration()});
    } catch(e){sendManagementAuthorizationError(request,response,requestId,e);}
    return true;
  }
  if (url.pathname === "/api/admin/knowledge/publications" || url.pathname.startsWith("/api/admin/knowledge/publications/")) {
    try {
      const p=await authorizeManagementRequest(request,{tenantId:PUBLIC_TENANT_ID});
      const match=url.pathname.match(/^\/api\/admin\/knowledge\/publications\/(kpub_[a-f0-9-]+)\/(evaluate|activate|rollback|withdraw)$/);
      if(request.method==='GET' && !match && url.pathname==='/api/admin/knowledge/publications'){
        sendJson(request,response,requestId,200,{data:await listKnowledgePublications(p)});return true;
      }
      if(request.method!=='POST'||(!match&&url.pathname!=='/api/admin/knowledge/publications'))throw Object.assign(new Error('未找到发布操作'),{status:404,code:'API_NOT_FOUND'});
      const payload=await readJsonBody(request,1024*1024);
      if(['tenant_id','tenantId','actor','subject','permitted_departments','roles'].some(k=>Object.hasOwn(payload,k)))throw Object.assign(new Error('身份及科室范围只能来自服务端'),{status:400,code:'ADMIN_IDENTITY_OVERRIDE_FORBIDDEN'});
      const key=String(request.headers['idempotency-key']||'');
      if(key.length<8||key.length>128)throw Object.assign(new Error('发布写操作需要幂等标识'),{status:400,code:'IDEMPOTENCY_KEY_REQUIRED'});
      const input={...payload,idempotency_key:key};
      const data=match?await mutateKnowledgePublication(match[1],match[2],input,p):await createKnowledgePublication(input,p);
      sendJson(request,response,requestId,200,{data});
    }catch(e){sendError(request,response,requestId,e.status||503,e.code||'KNOWLEDGE_PUBLICATION_UNAVAILABLE',e.status?e.message:'发布服务暂时不可用');}
    return true;
  }

  if (url.pathname.startsWith("/api/admin/knowledge/intake/assets")) {
    const prepareAsset = request.method === "POST" && url.pathname === "/api/admin/knowledge/intake/assets/prepare";
    const uploadAssetMatch = url.pathname.match(/^\/api\/admin\/knowledge\/intake\/assets\/(kiasset_[a-f0-9-]+)\/content$/i);
    const completeAssetMatch = url.pathname.match(/^\/api\/admin\/knowledge\/intake\/assets\/(kiasset_[a-f0-9-]+)\/complete$/i);
    const supported = prepareAsset || (request.method === "PUT" && uploadAssetMatch) || (request.method === "POST" && completeAssetMatch);
    if (!supported) {
      sendError(request, response, requestId, 404, "API_NOT_FOUND", "未找到指定原始素材管理端点");
      return true;
    }
    const idempotencyKey = String(request.headers["idempotency-key"] || "").trim();
    if ((prepareAsset || completeAssetMatch) && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
      sendError(request, response, requestId, 400, "IDEMPOTENCY_KEY_REQUIRED", "原始素材准备与入库必须提供8–128字符的Idempotency-Key");
      return true;
    }
    let principal;
    try {
      principal = await authorizeManagementRequest(request, {
        requiredRoles:[MANAGEMENT_ROLES.knowledgeIntakeWrite],
        requiredCapabilities:[PHASE_ONE_CAPABILITIES.knowledgeManage],
        tenantId:PUBLIC_TENANT_ID,
        tenantField:"token.tenant_ids"
      });
      await recordManagementAccess({
        principal,
        requestId,
        request,
        action:prepareAsset ? "management.knowledge_intake.asset_prepare" : completeAssetMatch ? "management.knowledge_intake.asset_complete" : "management.knowledge_intake.asset_upload",
        resourceType:"knowledge_intake_asset",
        resourceId:uploadAssetMatch?.[1] || completeAssetMatch?.[1] || ""
      });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }
    try {
      if (prepareAsset || completeAssetMatch) {
        const payload = await readJsonBody(request);
        const identityFields = [
          ["body.tenant_id", payload.tenant_id], ["body.tenantId", payload.tenantId],
          ["body.actor", payload.actor], ["body.permitted_departments", payload.permitted_departments]
        ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "");
        if (identityFields.length) {
          sendError(request, response, requestId, 400, "ADMIN_IDENTITY_OVERRIDE_FORBIDDEN", "租户、操作人和科室权限只能来自已验证的管理身份", identityFields.map(([field]) => ({ field })));
          return true;
        }
        if (prepareAsset) {
          const created = await prepareKnowledgeIntakeAsset({
            ...payload,
            tenant_id:principal.tenantId,
            actor:principal.subject,
            permitted_departments:managementDepartmentScope(principal),
            idempotency_key:idempotencyKey
          });
          sendJson(request, response, requestId, created.replayed ? 200 : 201, { data:created.asset, meta:{ replayed:created.replayed }, request_id:requestId }, created.replayed ? { "X-Idempotent-Replay":"true" } : {});
          return true;
        }
        const completed = await completeKnowledgeIntakeAsset({
          tenant_id:principal.tenantId,
          asset_id:completeAssetMatch[1],
          actor:principal.subject,
          permitted_departments:managementDepartmentScope(principal),
          idempotency_key:idempotencyKey
        });
        if (!completed) sendError(request, response, requestId, 404, "KNOWLEDGE_ASSET_NOT_FOUND", "未找到指定原始素材");
        else sendJson(request, response, requestId, completed.replayed ? 200 : 201, { data:completed.document, meta:{ replayed:completed.replayed, duplicate:completed.duplicate === true }, request_id:requestId }, completed.replayed ? { "X-Idempotent-Replay":"true" } : {});
        return true;
      }
      const contentLength = Number(request.headers["content-length"] || 0);
      if (Number.isFinite(contentLength) && contentLength > 32 * 1024 * 1024) {
        sendError(request, response, requestId, 413, "KNOWLEDGE_ASSET_TOO_LARGE", "原始素材不能超过32MB");
        return true;
      }
      const asset = await saveKnowledgeIntakeAssetContent({
        tenant_id:principal.tenantId,
        asset_id:uploadAssetMatch[1],
        actor:principal.subject,
        permitted_departments:managementDepartmentScope(principal),
        buffer:await readBinaryBody(request, 32 * 1024 * 1024),
        mime:String(request.headers["content-type"] || "").split(";")[0].toLowerCase()
      });
      if (!asset) sendError(request, response, requestId, 404, "KNOWLEDGE_ASSET_NOT_FOUND", "未找到指定原始素材");
      else sendJson(request, response, requestId, 200, { data:asset, request_id:requestId });
    } catch (error) {
      sendError(request, response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : (Number(error.status) || 400), error.code || "KNOWLEDGE_ASSET_OPERATION_INVALID", error.code === "BODY_TOO_LARGE" ? "原始素材不能超过32MB" : (error.message || "原始素材处理未完成"), error.details || []);
    }
    return true;
  }

  if (url.pathname.startsWith("/api/admin/knowledge/intake/documents")) {
    const listDocuments = request.method === "GET" && url.pathname === "/api/admin/knowledge/intake/documents";
    const createDocument = request.method === "POST" && url.pathname === "/api/admin/knowledge/intake/documents";
    const documentMatch = url.pathname.match(/^\/api\/admin\/knowledge\/intake\/documents\/((?:kidoc|kiasset)_[a-zA-Z0-9-]+)(?:\/(confirmation|candidate))?$/);
    const readDocument = request.method === "GET" && documentMatch && !documentMatch[2];
    const mutateDocument = request.method === "POST" && documentMatch;
    const supported = listDocuments || createDocument || readDocument || mutateDocument;
    if (!supported) {
      sendError(request, response, requestId, 404, "API_NOT_FOUND", "未找到指定知识录入管理端点");
      return true;
    }
    let operationPayload = {};
    if (request.method === "POST") {
      try { operationPayload = await readJsonBody(request, 300 * 1024); }
      catch (error) {
        sendError(request, response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.code === "BODY_TOO_LARGE" ? "单次知识文本不能超过256KB" : "请求体不是有效JSON");
        return true;
      }
    }
    const identityFields = [
      ["query.tenant_id", url.searchParams.get("tenant_id")],
      ["header.x-tenant-id", request.headers["x-tenant-id"]],
      ["body.tenant_id", operationPayload.tenant_id],
      ["body.tenantId", operationPayload.tenantId],
      ["body.actor", operationPayload.actor],
      ["body.permitted_departments", operationPayload.permitted_departments]
    ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "");
    if (identityFields.length) {
      sendError(request, response, requestId, 400, "ADMIN_IDENTITY_OVERRIDE_FORBIDDEN", "租户、操作人和科室权限只能来自已验证的管理身份", identityFields.map(([field]) => ({ field })));
      return true;
    }
    const write = request.method === "POST";
    const idempotencyKey = String(request.headers["idempotency-key"] || "").trim();
    if (write && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
      sendError(request, response, requestId, 400, "IDEMPOTENCY_KEY_REQUIRED", "知识录入写操作必须提供8–128字符的Idempotency-Key");
      return true;
    }
    const requiredRole = (listDocuments || readDocument)
      ? MANAGEMENT_ROLES.knowledgeIntakeRead
      : MANAGEMENT_ROLES.knowledgeIntakeWrite;
    let principal;
    try {
      principal = await authorizeManagementRequest(request, {
        requiredRoles:[requiredRole],
        requiredCapabilities:[write ? PHASE_ONE_CAPABILITIES.knowledgeManage : PHASE_ONE_CAPABILITIES.knowledgeRead],
        tenantId:PUBLIC_TENANT_ID,
        tenantField:"token.tenant_ids"
      });
      await recordManagementAccess({
        principal,
        requestId,
        request,
        action:(listDocuments || readDocument) ? "management.knowledge_intake.read" : "management.knowledge_intake.write",
        resourceType:"knowledge_intake_document",
        resourceId:documentMatch?.[1] || ""
      });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }
    try {
      if (listDocuments) {
        const data = await listKnowledgeIntakeDocuments({
          tenant_id:principal.tenantId,
          permitted_departments:managementDepartmentScope(principal),
          department:url.searchParams.get("department") || "",
          status:url.searchParams.get("status") || "",
          content_type:url.searchParams.get("content_type") || "",
          public_scope:url.searchParams.get("public_scope") || "",
          q:url.searchParams.get("q") || "",
          valid_on:url.searchParams.get("valid_on") || "",
          limit:url.searchParams.get("limit")
        });
        sendJson(request, response, requestId, 200, { data, request_id:requestId });
        return true;
      }
      if (createDocument) {
        const created = await createKnowledgeIntakeDocument({
          ...operationPayload,
          tenant_id:principal.tenantId,
          actor:principal.subject,
          permitted_departments:managementDepartmentScope(principal),
          idempotency_key:idempotencyKey
        });
        sendJson(request, response, requestId, created.replayed ? 200 : 201, { data:created.document, meta:{ replayed:created.replayed, duplicate:created.duplicate === true }, request_id:requestId });
        return true;
      }
      const payload = { ...operationPayload, document_id:documentMatch[1], tenant_id:principal.tenantId,
        actor:principal.subject, permitted_departments:managementDepartmentScope(principal), idempotency_key:idempotencyKey };
      const operation = readDocument ? getKnowledgeIntakeDocument : documentMatch[2] === "confirmation" ? recordKnowledgeIntakeConfirmation
        : documentMatch[2] === "candidate" ? submitKnowledgeIntakeDocument : updateKnowledgeIntakeDocument;
      const result = await operation(payload);
      if (!result) sendError(request, response, requestId, 404, "KNOWLEDGE_DOCUMENT_NOT_FOUND", "未找到指定资料");
      else sendJson(request, response, requestId, 200, { data:readDocument ? result : result.document,
        meta:{ replayed:result.replayed === true }, request_id:requestId });
    } catch (error) {
      sendError(request, response, requestId, Number(error.status) || 400, error.code || "KNOWLEDGE_INTAKE_OPERATION_INVALID", error.message || "知识录入操作未完成", error.details || []);
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/knowledge/governance") {
    let managementPrincipal;
    try {
      managementPrincipal = await authorizeManagementRequest(request, {
        requiredRoles:[MANAGEMENT_ROLES.knowledgeRead],
        requiredCapabilities:[PHASE_ONE_CAPABILITIES.knowledgeRead],
        tenantId:url.searchParams.get("tenant_id") || PUBLIC_TENANT_ID,
        tenantField:"query.tenant_id"
      });
      await recordManagementAccess({
        principal:managementPrincipal,
        requestId,
        request,
        action:"management.knowledge_governance.read",
        resourceType:"knowledge_governance"
      });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }
    try {
      // The release list is cached per tenant. Refresh it through the
      // governance policy before rendering this management view so a newly
      // completed review or activation is visible without serving stale state.
      await ensureKnowledgeReleasePolicyFresh(managementPrincipal.tenantId);
      sendJson(request, response, requestId, 200, {
        data:getKnowledgeGovernanceOverview(managementPrincipal.tenantId),
        request_id:requestId
      });
    } catch (error) {
      sendError(request, response, requestId, 503, error.code || "KNOWLEDGE_GOVERNANCE_UNAVAILABLE", "知识治理状态暂时无法读取");
    }
    return true;
  }

  if (url.pathname.startsWith("/api/admin/appointment-intakes") || url.pathname.startsWith("/api/admin/schedule-slots")) {
    const listAppointments = request.method === "GET" && url.pathname === "/api/admin/appointment-intakes";
    const appointmentDetail = url.pathname.match(/^\/api\/admin\/appointment-intakes\/(apt_[a-f0-9-]+)$/i);
    const appointmentContact = url.pathname.match(/^\/api\/admin\/appointment-intakes\/(apt_[a-f0-9-]+)\/contact-reveal$/i);
    const claimAppointment = url.pathname.match(/^\/api\/admin\/appointment-intakes\/(apt_[a-f0-9-]+)\/claim$/i);
    const resolveAppointment = url.pathname.match(/^\/api\/admin\/appointment-intakes\/(apt_[a-f0-9-]+)\/resolve$/i);
    const listSlots = request.method === "GET" && url.pathname === "/api/admin/schedule-slots";
    const createSlot = request.method === "POST" && url.pathname === "/api/admin/schedule-slots";
    const supported = listAppointments
      || (request.method === "GET" && appointmentDetail)
      || (request.method === "POST" && (claimAppointment || resolveAppointment || createSlot || appointmentContact))
      || listSlots;
    if (!supported) {
      sendError(request, response, requestId, 404, "API_NOT_FOUND", "未找到指定预约或排班管理端点");
      return true;
    }
    let operationPayload = {};
    if (request.method === "POST") {
      try { operationPayload = await readJsonBody(request); }
      catch (error) {
        sendError(request, response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.code === "BODY_TOO_LARGE" ? "请求体不能超过64KB" : "请求体不是有效JSON");
        return true;
      }
    }
    const identityFields = [
      ["query.tenant_id", url.searchParams.get("tenant_id")],
      ["header.x-tenant-id", request.headers["x-tenant-id"]],
      ["body.tenant_id", operationPayload.tenant_id],
      ["body.tenantId", operationPayload.tenantId],
      ["body.actor", operationPayload.actor],
      ["body.assignee", operationPayload.assignee]
    ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "");
    if (identityFields.length) {
      sendError(request, response, requestId, 400, "ADMIN_IDENTITY_OVERRIDE_FORBIDDEN", "租户和操作人只能来自已验证的管理身份", identityFields.map(([field]) => ({ field })));
      return true;
    }
    const write = request.method === "POST";
    const idempotencyKey = String(request.headers["idempotency-key"] || "").trim();
    if (write && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
      sendError(request, response, requestId, 400, "IDEMPOTENCY_KEY_REQUIRED", "预约和排班写操作必须提供8–128字符的Idempotency-Key");
      return true;
    }
    const requiredRole = write
      ? (createSlot ? MANAGEMENT_ROLES.scheduleWrite : MANAGEMENT_ROLES.appointmentWrite)
      : (listSlots ? MANAGEMENT_ROLES.scheduleRead : MANAGEMENT_ROLES.appointmentRead);
    const requiredCapability = appointmentContact ? PHASE_ONE_CAPABILITIES.contactsRevealAssigned : createSlot || listSlots
      ? PHASE_ONE_CAPABILITIES.appointmentsManage
      : write
        ? PHASE_ONE_CAPABILITIES.appointmentsManageAssigned
        : PHASE_ONE_CAPABILITIES.appointmentsReadAssigned;
    let principal;
    try {
      principal = await authorizeManagementRequest(request, {
        requiredRoles:[requiredRole],
        ...(appointmentContact ? { requiredAllRoles:[requiredRole, MANAGEMENT_ROLES.contactReveal] } : {}),
        requiredCapabilities:[requiredCapability],
        tenantId:PUBLIC_TENANT_ID,
        tenantField:"token.tenant_ids"
      });
      if(!managementDepartmentScope(principal).includes("*"))throw Object.assign(new Error("到院登记尚未绑定权威科室，当前账号不能读取或处理未归属记录"),{status:403,code:"APPOINTMENT_DEPARTMENT_SCOPE_REQUIRED"});
      await recordManagementAccess({
        principal,
        requestId,
        request,
        action:createSlot ? "management.schedule.write"
          : listSlots ? "management.schedule.read"
            : write ? "management.appointment.write" : "management.appointment.read",
        resourceType:createSlot || listSlots ? "schedule_slot" : "appointment_intake",
        resourceId:appointmentDetail?.[1] || claimAppointment?.[1] || resolveAppointment?.[1] || ""
      });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }
    try {
      if (listAppointments) {
        sendJson(request, response, requestId, 200, { data:await listAppointmentIntakes({ tenant_id:principal.tenantId, actor:principal.subject, assigned_only:!hasPhaseOneCapability(principal, PHASE_ONE_CAPABILITIES.appointmentsManage), status:url.searchParams.get("status") || "", limit:url.searchParams.get("limit") }), request_id:requestId });
        return true;
      }
      if (appointmentDetail) {
        const intake = await getAppointmentIntake({ tenant_id:principal.tenantId, appointment_intake_id:appointmentDetail[1], actor:principal.subject, assigned_only:!hasPhaseOneCapability(principal, PHASE_ONE_CAPABILITIES.appointmentsManage) });
        if (!intake) sendError(request, response, requestId, 404, "APPOINTMENT_INTAKE_NOT_FOUND", "未找到指定预约事项");
        else sendJson(request, response, requestId, 200, { data:intake, request_id:requestId });
        return true;
      }
      if (listSlots) {
        sendJson(request, response, requestId, 200, { data:listInternalScheduleSlots({ tenant_id:principal.tenantId, status:url.searchParams.get("status") || "active", from:url.searchParams.get("from") || "", limit:url.searchParams.get("limit") }), request_id:requestId });
        return true;
      }
      if (createSlot) {
        const created = createInternalScheduleSlot({ ...operationPayload, tenant_id:principal.tenantId, actor:principal.subject, idempotency_key:idempotencyKey });
        sendJson(request, response, requestId, created.replayed ? 200 : 201, { data:created.slot, meta:{ replayed:created.replayed }, request_id:requestId });
        return true;
      }
      if (appointmentContact) {
        const contact = await revealContactForClaimedAppointment({ tenantId:principal.tenantId, appointmentId:appointmentContact[1], actor:principal.subject, authorizedPrincipal:principal, revealRequestId:idempotencyKey, requestId });
        sendJson(request, response, requestId, 200, { data:contact, request_id:requestId }, { "Cache-Control":"no-store, private", "Pragma":"no-cache" });
        return true;
      }
      if (claimAppointment) {
        const intake = await claimAppointmentIntake({ tenant_id:principal.tenantId, appointment_intake_id:claimAppointment[1], actor:principal.subject });
        if (!intake) sendError(request, response, requestId, 404, "APPOINTMENT_INTAKE_NOT_FOUND", "未找到指定预约事项");
        else sendJson(request, response, requestId, 200, { data:intake, request_id:requestId });
        return true;
      }
      const resolved = await resolveAppointmentIntake({
        ...operationPayload,
        tenant_id:principal.tenantId,
        appointment_intake_id:resolveAppointment[1],
        actor:principal.subject,
        idempotency_key:idempotencyKey
      });
      if (!resolved) sendError(request, response, requestId, 404, "APPOINTMENT_INTAKE_NOT_FOUND", "未找到指定预约事项");
      else sendJson(request, response, requestId, 200, { data:resolved.intake, meta:{ replayed:resolved.replayed }, request_id:requestId });
    } catch (error) {
      const businessError = /^APPOINTMENT_|^SCHEDULE_|^IDEMPOTENCY_|^CONTACT_REVEAL_|^HANDOVER_NOT_FOUND/.test(String(error.code || ""));
      const status = Number(error.status) || (businessError ? 400 : 503);
      sendError(request, response, requestId, status, businessError ? error.code : "APPOINTMENT_STORAGE_UNAVAILABLE", businessError ? error.message : "到院登记服务暂不可用，请稍后重试。", businessError ? error.details || [] : []);
    }
    return true;
  }

  // A-023 AC2：人工顾问把消息发回客户会话（后台 → 客户，落在同一条会话记录里）。
  const handoverReplyMatch = url.pathname.match(/^\/api\/admin\/acquisition\/handovers\/(ho_[a-f0-9-]+)\/reply$/i);
  if (request.method === "POST" && handoverReplyMatch) {
    const humanIdempotencyKey = String(request.headers["idempotency-key"] || "").trim();
    if (humanIdempotencyKey.length < 8 || humanIdempotencyKey.length > 128) {
      sendError(request, response, requestId, 400, "IDEMPOTENCY_KEY_REQUIRED", "发送人工消息必须提供8–128字符的Idempotency-Key");
      return true;
    }
    let humanPayload;
    try {
      humanPayload = await readJsonBody(request);
    } catch (error) {
      sendError(request, response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", "请求体不是有效JSON");
      return true;
    }
    const humanText = String(humanPayload?.text || "").trim();
    if (!humanText || humanText.length > 1000) {
      sendError(request, response, requestId, 400, "VALIDATION_ERROR", "人工消息不能为空且不能超过1000字符");
      return true;
    }
    let humanPrincipal;
    try {
      humanPrincipal = await authorizeManagementRequest(request, {
        requiredRoles:[MANAGEMENT_ROLES.operationsAgent],
        requiredCapabilities:[PHASE_ONE_CAPABILITIES.conversationsTakeover],
        tenantId:PUBLIC_TENANT_ID,
        tenantField:"token.tenant_ids"
      });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }
    // 接管任务由智能体服务进程写入，getHandover 会重新读盘，保证跨进程可见。
    const humanHandover = getHandover(handoverReplyMatch[1], PUBLIC_TENANT_ID);
    if (!humanHandover) {
      sendError(request, response, requestId, 404, "HANDOVER_NOT_FOUND", "未找到指定接管任务");
      return true;
    }
    if (humanHandover.status !== "active") {
      sendError(request, response, requestId, 409, "HANDOVER_NOT_CLAIMED", "只有已接管的人工会话可以发送消息");
      return true;
    }
    if (String(humanHandover.assignee || "") !== String(humanPrincipal.subject || "")) {
      sendError(request, response, requestId, 403, "HANDOVER_ASSIGNMENT_FORBIDDEN", "只有当前接管人可以发送消息");
      return true;
    }
    const humanMessage = appendLocalConversationMessage({
      tenant:humanHandover.tenant_id,
      channel:humanHandover.channel,
      conversationId:humanHandover.conversation_id,
      from:"human",
      text:humanText,
      messageId:`human-${humanIdempotencyKey}`
    });
    sendJson(request, response, requestId, 200, { message:humanMessage, handover_id:humanHandover.id });
    return true;
  }

  if (url.pathname.startsWith("/api/admin/acquisition/")) {
    const listRoute = request.method === "GET" && url.pathname === "/api/admin/acquisition/handovers";
    const listBadCasesRoute = request.method === "GET" && url.pathname === "/api/admin/acquisition/bad-cases";
    const detailMatch = url.pathname.match(/^\/api\/admin\/acquisition\/handovers\/(ho_[a-f0-9-]+)$/i);
    const claimMatch = url.pathname.match(/^\/api\/admin\/acquisition\/handovers\/(ho_[a-f0-9-]+)\/claim$/i);
    const completeMatch = url.pathname.match(/^\/api\/admin\/acquisition\/handovers\/(ho_[a-f0-9-]+)\/complete$/i);
    const contactRevealMatch = url.pathname.match(/^\/api\/admin\/acquisition\/handovers\/(ho_[a-f0-9-]+)\/contact-reveal$/i);
    const badCaseReviewMatch = url.pathname.match(/^\/api\/admin\/acquisition\/bad-cases\/(fb_[a-f0-9-]+)\/review$/i);
    const humanWorkRoute = request.method === "POST" && url.pathname === "/api/admin/acquisition/human-work";
    const supported = listRoute
      || listBadCasesRoute
      || (request.method === "GET" && detailMatch)
      || (request.method === "POST" && (claimMatch || completeMatch || contactRevealMatch || badCaseReviewMatch))
      || humanWorkRoute;
    if (!supported) {
      sendError(request, response, requestId, 404, "API_NOT_FOUND", "未找到指定人工接管管理端点");
      return true;
    }

    let operationPayload = {};
    if (request.method === "POST") {
      try { operationPayload = await readJsonBody(request); }
      catch (error) {
        const tooLarge = error.code === "BODY_TOO_LARGE";
        sendError(request, response, requestId, tooLarge ? 413 : 400, tooLarge ? "BODY_TOO_LARGE" : "INVALID_JSON", tooLarge ? "请求体不能超过64KB" : "请求体不是有效JSON");
        return true;
      }
    }
    const callerControlledIdentityFields = [
      ["query.tenant_id", url.searchParams.get("tenant_id")],
      ["header.x-tenant-id", request.headers["x-tenant-id"]],
      ["body.tenant_id", operationPayload.tenant_id],
      ["body.tenantId", operationPayload.tenantId],
      ["body.assignee", operationPayload.assignee],
      ["body.actor", operationPayload.actor],
      ["body.staff_id", operationPayload.staff_id]
    ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "");
    if (callerControlledIdentityFields.length) {
      sendError(
        request,
        response,
        requestId,
        400,
        "ADMIN_IDENTITY_OVERRIDE_FORBIDDEN",
        "租户和操作人只能来自已验证的OIDC令牌",
        callerControlledIdentityFields.map(([field]) => ({ field }))
      );
      return true;
    }
    const adminIdempotencyKey = String(request.headers["idempotency-key"] || "").trim();
    if ((completeMatch || contactRevealMatch || badCaseReviewMatch) && (adminIdempotencyKey.length < 8 || adminIdempotencyKey.length > 128)) {
      sendError(
        request,
        response,
        requestId,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        contactRevealMatch
          ? "查看联系方式必须提供8–128字符的一次性Idempotency-Key"
          : badCaseReviewMatch
            ? "处理Bad Case必须提供8–128字符的Idempotency-Key"
            : "完结接管必须提供8–128字符的Idempotency-Key"
      );
      return true;
    }

    const requiredCapability = contactRevealMatch
      ? PHASE_ONE_CAPABILITIES.contactsRevealAssigned
      : (listBadCasesRoute || badCaseReviewMatch)
        ? PHASE_ONE_CAPABILITIES.feedbackManage
        : claimMatch
          ? PHASE_ONE_CAPABILITIES.conversationsTakeover
          : (completeMatch || humanWorkRoute)
            ? PHASE_ONE_CAPABILITIES.conversationsComplete
            : PHASE_ONE_CAPABILITIES.conversationsReadAssigned;
    let principal;
    try {
      principal = await authorizeManagementRequest(request, {
        requiredRoles:[listBadCasesRoute || badCaseReviewMatch ? "feedback:manage" : MANAGEMENT_ROLES.operationsAgent],
        requiredCapabilities:[requiredCapability],
        ...(contactRevealMatch ? {
          requiredAllRoles:[MANAGEMENT_ROLES.operationsAgent, MANAGEMENT_ROLES.contactReveal]
        } : {}),
        tenantId:PUBLIC_TENANT_ID,
        tenantField:"token.tenant_ids"
      });
      if((listBadCasesRoute||badCaseReviewMatch)&&!principal.departmentIds.includes("*"))throw Object.assign(new Error("未归属科室的反馈仅向机构范围质检开放"),{status:403,code:"FEEDBACK_DEPARTMENT_SCOPE_REQUIRED"});
      await recordManagementAccess({
        principal,
        requestId,
        request,
        action:contactRevealMatch
          ? "management.contact.reveal_authorized"
          : listBadCasesRoute
            ? "management.conversation_feedback.read"
            : badCaseReviewMatch
              ? "management.conversation_feedback.write"
          : request.method === "GET"
            ? "management.handover.read"
            : "management.handover.write",
        resourceType:humanWorkRoute ? "human_work" : (listBadCasesRoute || badCaseReviewMatch ? "conversation_feedback" : "handover"),
        resourceId:detailMatch?.[1] || claimMatch?.[1] || completeMatch?.[1] || contactRevealMatch?.[1] || badCaseReviewMatch?.[1] || "",
        outcome:contactRevealMatch ? "authorized" : "success"
      });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }

    const operation = listRoute
      ? "handovers.list"
      : listBadCasesRoute
        ? "feedback.bad-cases.list"
      : detailMatch
        ? "handovers.get"
        : claimMatch
          ? "handovers.claim"
          : completeMatch
            ? "handovers.complete"
            : contactRevealMatch
              ? "handovers.contact-reveal"
              : badCaseReviewMatch
                ? "feedback.bad-cases.review"
                : "human-work.create";
    try {
      const result = await callAcquisitionAdminOperation({
        operation,
        handoverId:detailMatch?.[1] || claimMatch?.[1] || completeMatch?.[1] || contactRevealMatch?.[1] || badCaseReviewMatch?.[1] || "",
        tenantId:principal.tenantId,
        authorization:request.headers.authorization,
        developmentSubject:productionRuntime ? "" : principal.subject,
        payload:operationPayload,
        query:{ status:url.searchParams.get("status"), limit:url.searchParams.get("limit") },
        requestId,
        idempotencyKey:adminIdempotencyKey.slice(0, 128)
      });
      if(listRoute && !hasPhaseOneCapability(principal, PHASE_ONE_CAPABILITIES.conversationsReadAll)){result.data=(result.data||[]).filter(item=>(!item.assignee||item.assignee===principal.subject)&&(principal.departmentIds.includes("*")||principal.departmentIds.includes(item.department))).map(item=>item.assignee?item:{id:item.id,status:item.status,created_at:item.created_at,assignee:null}); if(result.meta)result.meta={total:result.data.length};}
      if(detailMatch && result.data && !hasPhaseOneCapability(principal, PHASE_ONE_CAPABILITIES.conversationsReadAll) && (result.data.assignee!==principal.subject || !(principal.departmentIds.includes("*")||principal.departmentIds.includes(result.data.department))))throw Object.assign(new Error("会话不属于当前接待人或科室"),{status:403,code:"HANDOVER_ASSIGNMENT_FORBIDDEN"});
      sendJson(
        request,
        response,
        requestId,
        humanWorkRoute ? 201 : 200,
        result,
        contactRevealMatch ? { Pragma:"no-cache", Expires:"0" } : {}
      );
    } catch (error) {
      const status = Number(error.status) || (/CONFLICT|ALREADY|MISMATCH|NOT_CLAIMED/.test(String(error.code || "")) ? 409 : 502);
      sendError(
        request,
        response,
        requestId,
        status,
        error.code || "ACQUISITION_ADMIN_UPSTREAM_FAILED",
        status >= 500 ? "人工接管服务暂时不可用" : error.message,
        status >= 500 ? [] : error.details || []
      );
    }
    return true;
  }

  if (url.pathname.startsWith("/api/local/physician-avatar")) {
    let managementPrincipal;
    try {
      const writeOperation = !["GET", "HEAD"].includes(request.method);
      managementPrincipal = await authorizeManagementRequest(request, {
        requiredRoles:[writeOperation ? MANAGEMENT_ROLES.avatarWrite : MANAGEMENT_ROLES.avatarRead],
        requiredCapabilities:[PHASE_ONE_CAPABILITIES.hospitalDataManage],
        tenantId:url.searchParams.get("tenant_id") || PUBLIC_TENANT_ID,
        tenantField:"query.tenant_id"
      });
      await recordManagementAccess({
        principal:managementPrincipal,
        requestId,
        request,
        action:writeOperation ? "management.physician_avatar.write" : "management.physician_avatar.read",
        resourceType:"physician_avatar"
      });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }
    // The same OIDC subject can be authorized for several tenants. Scope all
    // avatar runtime objects by both tenant and subject to prevent cross-tenant
    // reads when the operator switches tenant context.
    const userId = productionRuntime
      ? `${managementPrincipal.tenantId}:${managementPrincipal.subject}`
      : managementPrincipal.subject;
    try {
      if (request.method === "GET" && url.pathname === "/api/local/physician-avatar/status") {
        sendJson(request, response, requestId, 200, { data:await getPhysicianAvatarRuntimeStatus(userId), request_id:requestId });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/local/physician-avatar/jobs") {
        sendJson(request, response, requestId, 200, { data:await listPhysicianAvatarJobs({ userId, physicianId:url.searchParams.get("physician_id") || "", limit:url.searchParams.get("limit") || 50 }), request_id:requestId });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/local/physician-avatar/jobs") {
        const payload = await readJsonBody(request);
        assertManagementPayloadTenant(payload, managementPrincipal);
        const result = await createPhysicianAvatarJob(payload, { userId, idempotencyKey:request.headers["idempotency-key"] });
        sendJson(request, response, requestId, result.replayed ? 200 : 202, { data:result.job, meta:{ replayed:result.replayed, asynchronous:true }, request_id:requestId }, result.replayed ? { "X-Idempotent-Replay":"true" } : {});
        return true;
      }
      const jobMatch = url.pathname.match(/^\/api\/local\/physician-avatar\/jobs\/([^/]+)$/);
      if (request.method === "GET" && jobMatch) {
        const physicianId = url.searchParams.get("physician_id") || "";
        if (!physicianId) { sendError(request, response, requestId, 400, "MISSING_PHYSICIAN_SCOPE", "查看任务必须指定医师作用域"); return true; }
        const job = await getPhysicianAvatarJob(jobMatch[1], userId, physicianId);
        if (!job) sendError(request, response, requestId, 404, "JOB_NOT_FOUND", "未找到生成任务");
        else sendJson(request, response, requestId, 200, { data:job, request_id:requestId });
        return true;
      }
      if (request.method === "DELETE" && jobMatch) {
        const physicianId = url.searchParams.get("physician_id") || "";
        if (!physicianId) { sendError(request, response, requestId, 400, "MISSING_PHYSICIAN_SCOPE", "删除任务必须指定医师作用域"); return true; }
        const deleted = await deletePhysicianAvatarJob(jobMatch[1], userId, physicianId);
        if (!deleted) sendError(request, response, requestId, 404, "JOB_NOT_FOUND", "未找到生成任务");
        else sendJson(request, response, requestId, deleted.cleanupStatus === "completed" ? 200 : 202, { data:deleted, request_id:requestId });
        return true;
      }
      const cancelMatch = url.pathname.match(/^\/api\/local\/physician-avatar\/jobs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const physicianId = url.searchParams.get("physician_id") || "";
        if (!physicianId) { sendError(request, response, requestId, 400, "MISSING_PHYSICIAN_SCOPE", "取消任务必须指定医师作用域"); return true; }
        const job = await cancelPhysicianAvatarJob(cancelMatch[1], userId, physicianId);
        if (!job) sendError(request, response, requestId, 404, "JOB_NOT_FOUND", "未找到生成任务");
        else sendJson(request, response, requestId, 200, { data:job, request_id:requestId });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/local/physician-avatar/assets/prepare") {
        const payload = await readJsonBody(request);
        assertManagementPayloadTenant(payload, managementPrincipal);
        sendJson(request, response, requestId, 201, { data:await preparePhysicianAvatarAsset(payload, userId), request_id:requestId });
        return true;
      }
      const assetContentMatch = url.pathname.match(/^\/api\/local\/physician-avatar\/assets\/([^/]+)\/content$/);
      if (request.method === "PUT" && assetContentMatch) {
        const contentLength = Number(request.headers["content-length"] || 0);
        if (!Number.isInteger(contentLength) || contentLength <= 0 || contentLength > 30*1024*1024) { sendError(request, response, requestId, 413, "INVALID_UPLOAD_SIZE", "素材上传大小必须在1字节至30MB之间"); return true; }
        const buffer = await readBinaryBody(request, 30*1024*1024);
        const asset = await savePhysicianAvatarAssetContent(assetContentMatch[1], userId, buffer, String(request.headers["content-type"] || "").split(";")[0].toLowerCase());
        sendJson(request, response, requestId, 200, { data:asset, request_id:requestId });
        return true;
      }
      const assetCompleteMatch = url.pathname.match(/^\/api\/local\/physician-avatar\/assets\/([^/]+)\/complete$/);
      if (request.method === "POST" && assetCompleteMatch) {
        sendJson(request, response, requestId, 200, { data:await completePhysicianAvatarAsset(assetCompleteMatch[1], userId), request_id:requestId });
        return true;
      }
      const workMediaMatch = url.pathname.match(/^\/api\/local\/physician-avatar\/works\/([^/]+)\/(video|cover)$/);
      if (request.method === "GET" && workMediaMatch) {
        const physicianId = url.searchParams.get("physician_id") || "";
        if (!physicianId) { sendError(request, response, requestId, 400, "MISSING_PHYSICIAN_SCOPE", "读取作品媒体必须指定医师作用域"); return true; }
        const media = await getPhysicianAvatarWorkMedia(workMediaMatch[1], userId, workMediaMatch[2], physicianId);
        if (!media) sendError(request, response, requestId, 404, "MEDIA_NOT_FOUND", "未找到已归档媒体文件");
        else sendMedia(request, response, media);
        return true;
      }
    } catch (error) {
      const isValidation = ["VALIDATION_ERROR","INVALID_REFERENCE_ASSET","INVALID_ASSET_METADATA","INVALID_ASSET_STATE","ASSET_MIME_MISMATCH","ASSET_SIZE_MISMATCH","ASSET_SIGNATURE_MISMATCH","ASSET_VERIFICATION_FAILED","DAILY_REAL_JOB_LIMIT"].includes(error.code);
      const isConflict = ["JOB_NOT_TERMINAL","JOB_BUSY","DELETE_REFERENCE_CONFLICT","DELETE_ASSOCIATION_CONFLICT","UNSAFE_DELETE_PATH","IDEMPOTENCY_PAYLOAD_MISMATCH"].includes(error.code);
      const tooLarge = error.code === "BODY_TOO_LARGE";
      const explicitStatus = Number(error.status);
      const status = explicitStatus || (tooLarge ? 413 : isConflict ? 409 : isValidation ? 400 : 500);
      sendError(request, response, requestId, status, error.code || "PHYSICIAN_AVATAR_ERROR", status < 500 ? error.message : "AI分身服务暂时不可用", error.details || []);
      return true;
    }
    sendError(request, response, requestId, 404, "API_NOT_FOUND", "未找到指定AI分身端点");
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/public/acquisition-chat") {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      const tooLarge = error.code === "BODY_TOO_LARGE";
      sendError(request, response, requestId, tooLarge ? 413 : 400, tooLarge ? "BODY_TOO_LARGE" : "INVALID_JSON", tooLarge ? "请求体不能超过64KB" : "请求体不是有效JSON");
      return true;
    }
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!message || message.length > 1000) {
      sendError(request, response, requestId, 400, "VALIDATION_ERROR", "咨询内容不能为空且不能超过1000字符", [{ field:"message", message:"请输入1–1000字符" }]);
      return true;
    }
    let tenantId;
    let session;
    try {
      tenantId = resolvePublicTenant(request, payload);
      session = resolvePublicSession(request, payload, tenantId);
    } catch (error) {
      sendError(request, response, requestId, error.status || 400, error.code || "INVALID_SESSION", error.message || "会话凭证校验失败", error.details || []);
      return true;
    }
    let rate;
    try { rate = await consumePublicRateLimit({ tenantId, operation:"chat", session }); }
    catch {
      sendError(request, response, requestId, 503, "RATE_LIMIT_STORE_UNAVAILABLE", "咨询服务暂时不可用，请稍后再试");
      return true;
    }
    const rateHeaders = {
      "X-RateLimit-Limit":String(PUBLIC_WEB_RATE_LIMIT),
      "X-RateLimit-Remaining":String(rate.remaining),
      "X-RateLimit-Reset":rate.resetAt,
      "Set-Cookie":session.setCookie
    };
    if (!rate.allowed) {
      sendJson(request, response, requestId, 429, { error:{ code:"RATE_LIMITED", message:"咨询请求较多，请稍后再试" }, request_id:requestId }, { ...rateHeaders, "Retry-After":"60" });
      return true;
    }
    try {
      const result = await callAcquisitionChannel("web", {
        tenant_id:tenantId,
        message,
        session_id:session.sessionId,
        interests:Array.isArray(payload.interests) ? payload.interests.slice(0, 3) : []
      }, { requestId, caller:"huamei_web_gateway", idempotencyKey:String(request.headers["idempotency-key"] || "").trim() });
      sendJson(request, response, requestId, 200, {
        ...result,
        session_id:session.sessionId,
        session_token:session.sessionToken,
        session_expires_at:session.expiresAt,
        request_id:requestId
      }, rateHeaders);
    } catch (error) {
      const validation = ["VALIDATION_ERROR", "UNSUPPORTED_CHANNEL"].includes(error.code);
      const conflict = error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH";
      sendError(request, response, requestId, conflict ? 409 : validation ? 400 : 503, conflict || validation ? error.code : "ACQUISITION_SERVICE_UNAVAILABLE", conflict || validation ? error.message : "售前智能体服务暂时不可用，请稍后再试", error.details || [], rateHeaders);
    }
    return true;
  }

  // A-005：真实流式答复。按片段推送 delta，最终由 final 回执提交；带 since_seq
  // 支持断线重连时只补发缺失片段，重复片段由运行号+序号在客户端去重。
  if (request.method === "POST" && url.pathname === "/api/public/acquisition-chat/stream") {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      const tooLarge = error.code === "BODY_TOO_LARGE";
      sendError(request, response, requestId, tooLarge ? 413 : 400, tooLarge ? "BODY_TOO_LARGE" : "INVALID_JSON", tooLarge ? "请求体不能超过64KB" : "请求体不是有效JSON");
      return true;
    }
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!message || message.length > 1000) {
      sendError(request, response, requestId, 400, "VALIDATION_ERROR", "咨询内容不能为空且不能超过1000字符", [{ field:"message", message:"请输入1–1000字符" }]);
      return true;
    }
    let tenantId;
    let session;
    try {
      tenantId = resolvePublicTenant(request, payload);
      session = resolvePublicSession(request, payload, tenantId);
    } catch (error) {
      sendError(request, response, requestId, error.status || 400, error.code || "INVALID_SESSION", error.message || "会话凭证校验失败", error.details || []);
      return true;
    }
    let rate;
    try { rate = await consumePublicRateLimit({ tenantId, operation:"chat", session }); }
    catch {
      sendError(request, response, requestId, 503, "RATE_LIMIT_STORE_UNAVAILABLE", "咨询服务暂时不可用，请稍后再试");
      return true;
    }
    const rateHeaders = {
      "X-RateLimit-Limit":String(PUBLIC_WEB_RATE_LIMIT),
      "X-RateLimit-Remaining":String(rate.remaining),
      "X-RateLimit-Reset":rate.resetAt,
      "Set-Cookie":session.setCookie
    };
    if (!rate.allowed) {
      sendJson(request, response, requestId, 429, { error:{ code:"RATE_LIMITED", message:"咨询请求较多，请稍后再试" }, request_id:requestId }, { ...rateHeaders, "Retry-After":"60" });
      return true;
    }
    try {
      const result = await callAcquisitionChannel("web", {
        tenant_id:tenantId,
        message,
        session_id:session.sessionId,
        interests:Array.isArray(payload.interests) ? payload.interests.slice(0, 3) : []
      }, { requestId, caller:"huamei_web_gateway", idempotencyKey:String(request.headers["idempotency-key"] || "").trim().slice(0, 160) });
      const receipt = {
        ...result,
        session_id:session.sessionId,
        session_token:session.sessionToken,
        session_expires_at:session.expiresAt,
        request_id:requestId
      };
      const runId = String(result.run_id || `run_${requestId}`);
      const suppressed = result.delivery?.suppress_ai === true;
      const segments = suppressed
        ? []
        : (Array.isArray(result.reply_segments) && result.reply_segments.length
          ? result.reply_segments.map((item) => String(item || "")).filter(Boolean)
          : [String(result.reply || "")].filter(Boolean));
      const sinceSeq = Math.max(0, Number(payload.since_seq) || 0);
      response.writeHead(200, {
        ...commonHeaders(request, requestId),
        ...rateHeaders,
        "Content-Type":"text/event-stream; charset=utf-8",
        "Cache-Control":"no-store",
        "Connection":"keep-alive",
        "X-Accel-Buffering":"no"
      });
      const writeEvent = (event, data) => {
        if (response.writableEnded) return;
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      writeEvent("open", { run_id:runId, request_id:requestId, total:segments.length, since_seq:sinceSeq, suppressed });
      let lastSeq = sinceSeq;
      for (let index = 0; index < segments.length; index += 1) {
        const seq = index + 1;
        if (seq <= sinceSeq) continue;
        // 请求体读完后 request.destroyed 会变成 true，这里只判断响应侧是否还活着。
        if (response.writableEnded || response.destroyed || request.aborted) break;
        writeEvent("delta", { run_id:runId, seq, index, text:segments[index], total:segments.length });
        lastSeq = seq;
        // 片段之间留出间隔，客户才能看到“生成中”的过程；模型接入后可换成真实 token 流。
        await new Promise((resolve) => setTimeout(resolve, PUBLIC_CHAT_STREAM_PACING_MS));
      }
      writeEvent("final", { ...receipt, stream:{ run_id:runId, last_seq:lastSeq, committed:true, suppressed } });
      response.end();
    } catch (error) {
      const validation = ["VALIDATION_ERROR", "UNSUPPORTED_CHANNEL"].includes(error.code);
      const conflict = error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH";
      const status = conflict ? 409 : validation ? 400 : 503;
      const code = conflict || validation ? error.code : "ACQUISITION_SERVICE_UNAVAILABLE";
      const text = conflict || validation ? error.message : "售前智能体服务暂时不可用，请稍后再试";
      if (response.headersSent) {
        if (!response.writableEnded) {
          response.write(`event: error\ndata: ${JSON.stringify({ code, message:text, request_id:requestId })}\n\n`);
          response.end();
        }
      } else {
        sendError(request, response, requestId, status, code, text, error.details || [], rateHeaders);
      }
    }
    return true;
  }

  // 客户刷新或重新打开页面时，带着自己的会话凭证回读服务端确认过的消息顺序。
  if (request.method === "POST" && url.pathname === "/api/public/acquisition-conversation") {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      const tooLarge = error.code === "BODY_TOO_LARGE";
      sendError(request, response, requestId, tooLarge ? 413 : 400, tooLarge ? "BODY_TOO_LARGE" : "INVALID_JSON", tooLarge ? "请求体不能超过64KB" : "请求体不是有效JSON");
      return true;
    }
    let tenantId;
    let session;
    try {
      tenantId = resolvePublicTenant(request, payload);
      session = resolvePublicSession(request, payload, tenantId);
    } catch (error) {
      sendError(request, response, requestId, error.status || 400, error.code || "INVALID_SESSION", error.message || "会话凭证校验失败", error.details || []);
      return true;
    }
    const record = readLocalConversationRecord(tenantId, "web", session.sessionId);
    const limit = Math.min(Math.max(Number(payload?.limit) || 100, 1), 200);
    const messages = (record?.messages || []).slice(-limit).map((item) => ({
      id:item.id,
      role:item.from === "customer" ? "customer" : item.from,
      text:item.text,
      at:item.at
    }));
    sendJson(request, response, requestId, 200, {
      session_id:session.sessionId,
      session_token:session.sessionToken,
      session_expires_at:session.expiresAt,
      conversation_id:session.sessionId,
      projects:record?.projects || [],
      capabilities:{
        customer_upload:{
          enabled:String(process.env.HUAMEI_CUSTOMER_UPLOAD_ENABLED || "false").toLowerCase() === "true",
          accepted_types:["image/jpeg", "image/png", "image/webp", "application/pdf"],
          max_image_bytes:64 * 1024 * 1024,
          max_pdf_bytes:32 * 1024 * 1024
        }
      },
      messages,
      request_id:requestId
    }, { "Set-Cookie":session.setCookie, "Cache-Control":"no-store" });
    return true;
  }

  // A-025 AC2：客户上传图片/资料（受开关控制；只落客户专属目录，绝不进公开知识库）。
  if (request.method === "POST" && url.pathname === "/api/public/acquisition-upload") {
    const uploadEnabled = String(process.env.HUAMEI_CUSTOMER_UPLOAD_ENABLED || "false").toLowerCase() === "true";
    const limits = {
      "image/jpeg": 64 * 1024 * 1024,
      "image/png": 64 * 1024 * 1024,
      "image/webp": 64 * 1024 * 1024,
      "application/pdf": 32 * 1024 * 1024
    };
    if (!uploadEnabled) {
      sendError(request, response, requestId, 403, "CUSTOMER_UPLOAD_DISABLED", "当前在线咨询暂不支持上传图片（图片通道未启用）");
      return true;
    }
    let uploadPayload;
    try {
      uploadPayload = await readJsonBody(request, 96 * 1024 * 1024);
    } catch (error) {
      sendError(request, response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", "上传内容不是有效JSON或超出体积上限");
      return true;
    }
    const mimeType = String(uploadPayload?.mime_type || "").toLowerCase().trim();
    const maxBytes = limits[mimeType];
    if (!maxBytes) {
      sendError(request, response, requestId, 415, "CUSTOMER_UPLOAD_TYPE_UNSUPPORTED", "仅支持 jpg、png、webp 图片或 pdf 资料", [{ field:"mime_type" }]);
      return true;
    }
    let buffer;
    try {
      buffer = Buffer.from(String(uploadPayload?.data_base64 || ""), "base64");
    } catch {
      buffer = Buffer.alloc(0);
    }
    if (!buffer.length) {
      sendError(request, response, requestId, 400, "CUSTOMER_UPLOAD_EMPTY", "上传内容为空");
      return true;
    }
    if (buffer.length > maxBytes) {
      sendError(request, response, requestId, 413, "CUSTOMER_UPLOAD_TOO_LARGE", "文件超出该类型的体积上限", [{ field:"data_base64", message:`上限 ${maxBytes} 字节` }]);
      return true;
    }
    let uploadTenant;
    let uploadSession;
    try {
      uploadTenant = resolvePublicTenant(request, uploadPayload);
      uploadSession = resolvePublicSession(request, uploadPayload, uploadTenant);
    } catch (error) {
      sendError(request, response, requestId, error.status || 400, error.code || "INVALID_SESSION", error.message || "会话凭证校验失败", error.details || []);
      return true;
    }
    const extension = mimeType === "application/pdf" ? "pdf" : mimeType.split("/")[1].replace("jpeg", "jpg");
    const uploadId = `upl_${randomUUID()}`;
    const safeSession = String(uploadSession.sessionId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const directory = resolvePath(process.cwd(), ".local-data", "customer-uploads", uploadTenant, safeSession);
    try {
      mkdirSync(directory, { recursive:true });
      writeFileSync(resolvePath(directory, `${uploadId}.${extension}`), buffer, { mode:0o600 });
    } catch {
      sendError(request, response, requestId, 503, "CUSTOMER_UPLOAD_STORAGE_UNAVAILABLE", "上传暂时无法保存，请稍后重试");
      return true;
    }
    sendJson(request, response, requestId, 200, {
      upload_id:uploadId,
      mime_type:mimeType,
      size_bytes:buffer.length,
      scope:"customer_only",
      note:"客户上传内容只保存在本机客户专属目录，不进入公开知识库与公开素材。",
      request_id:requestId
    }, { "Cache-Control":"no-store" });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/public/acquisition-feedback") {
    let payload;
    try { payload = await readJsonBody(request); }
    catch (error) {
      const tooLarge = error.code === "BODY_TOO_LARGE";
      sendError(request, response, requestId, tooLarge ? 413 : 400, tooLarge ? "BODY_TOO_LARGE" : "INVALID_JSON", tooLarge ? "请求体不能超过64KB" : "请求体不是有效JSON");
      return true;
    }
    const rating = typeof payload.rating === "string" ? payload.rating.trim().toLowerCase() : "";
    const replyId = typeof payload.reply_id === "string" ? payload.reply_id.trim() : "";
    if (!["up", "down"].includes(rating) || !replyId || replyId.length > 160 || !Array.isArray(payload.transcript)) {
      sendError(request, response, requestId, 400, "VALIDATION_ERROR", "反馈内容不完整，请稍后重试");
      return true;
    }
    let tenantId;
    let session;
    try {
      tenantId = resolvePublicTenant(request, payload);
      session = resolvePublicSession(request, payload, tenantId);
    } catch (error) {
      sendError(request, response, requestId, error.status || 400, error.code || "INVALID_SESSION", error.message || "会话凭证校验失败", error.details || []);
      return true;
    }
    let rate;
    try { rate = await consumePublicRateLimit({ tenantId, operation:"feedback", session }); }
    catch {
      sendError(request, response, requestId, 503, "RATE_LIMIT_STORE_UNAVAILABLE", "反馈暂时无法提交，请稍后重试");
      return true;
    }
    const rateHeaders = {
      "X-RateLimit-Limit":String(PUBLIC_WEB_RATE_LIMIT),
      "X-RateLimit-Remaining":String(rate.remaining),
      "X-RateLimit-Reset":rate.resetAt,
      "Set-Cookie":session.setCookie
    };
    if (!rate.allowed) {
      sendJson(request, response, requestId, 429, { error:{ code:"RATE_LIMITED", message:"反馈提交较频繁，请稍后再试" }, request_id:requestId }, { ...rateHeaders, "Retry-After":"60" });
      return true;
    }
    try {
      const result = await submitAcquisitionConversationFeedback({
        tenant_id:tenantId,
        channel:"web",
        conversation_id:session.sessionId,
        reply_id:replyId,
        rating,
        comment:typeof payload.comment === "string" ? payload.comment.slice(0, 300) : "",
        transcript:payload.transcript.slice(-24)
      }, { requestId, idempotencyKey:`feedback-${session.sessionId}-${replyId}-${rating}`.slice(0, 160) });
      sendJson(request, response, requestId, 200, {
        feedback:result.data || result.feedback || null,
        meta:result.meta || {},
        session_id:session.sessionId,
        session_token:session.sessionToken,
        session_expires_at:session.expiresAt,
        request_id:requestId
      }, rateHeaders);
    } catch (error) {
      const validation = ["FEEDBACK_CONTEXT_REQUIRED", "FEEDBACK_RATING_INVALID", "FEEDBACK_TRANSCRIPT_REQUIRED"].includes(error.code);
      sendError(request, response, requestId, validation ? 400 : 503, validation ? error.code : "ACQUISITION_SERVICE_UNAVAILABLE", validation ? error.message : "反馈暂时无法提交，请稍后重试", error.details || [], rateHeaders);
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/public/appointment-dates") {
    sendJson(request, response, requestId, 200, appointmentDateRecommendations());
    return true;
  }

  if (request.method === "POST" && (url.pathname === "/api/public/appointment-intakes" || /^\/api\/public\/appointment-intakes\/(?:current|apt_[a-f0-9-]+\/(?:reschedule|cancel))$/.test(url.pathname))) {
    let payload;
    try { payload = await readJsonBody(request); }
    catch (error) {
      sendError(request, response, requestId, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code || "INVALID_JSON", error.code === "BODY_TOO_LARGE" ? "请求体不能超过64KB" : "请求体不是有效JSON");
      return true;
    }
    let tenantId;
    let session;
    try {
      tenantId = resolvePublicTenant(request, payload);
      session = resolvePublicSession(request, payload, tenantId);
    } catch (error) {
      sendError(request, response, requestId, error.status || 400, error.code || "INVALID_SESSION", error.message || "会话凭证校验失败", error.details || []);
      return true;
    }
    let rate;
    try { rate = await consumePublicRateLimit({ tenantId, operation:"appointment_intake", session }); }
    catch {
      sendError(request, response, requestId, 503, "RATE_LIMIT_STORE_UNAVAILABLE", "预约申请暂时无法提交，请稍后再试");
      return true;
    }
    const rateHeaders = {
      "X-RateLimit-Limit":String(PUBLIC_WEB_RATE_LIMIT),
      "X-RateLimit-Remaining":String(rate.remaining),
      "X-RateLimit-Reset":rate.resetAt,
      "Set-Cookie":session.setCookie
    };
    if (!rate.allowed) {
      sendJson(request, response, requestId, 429, { error:{ code:"RATE_LIMITED", message:"提交请求较多，请稍后再试" }, request_id:requestId }, { ...rateHeaders, "Retry-After":"60" });
      return true;
    }
    try {
      const scope = { tenant_id:tenantId, channel:"web", conversation_id:session.sessionId };
      const customerView = (item) => item ? Object.fromEntries(["id", "status", "version", "branch", "projects", "doctor", "preferred_date", "preferred_time", "time_period", "time_precision", "time_preference", "appointment_no", "contact_status", "created_at", "updated_at"].map((key) => [key, item[key]])) : null;
      if (url.pathname.endsWith("/current")) {
        const { appointmentStateTransaction } = await import("./persistence/appointment-state-store.mjs");
        const current = await appointmentStateTransaction(scope, (state) => state.registrations.findLast((item) => item.status === "registered") || state.registrations.at(-1) || null);
        sendJson(request, response, requestId, 200, { intake:customerView(current), session_id:session.sessionId, session_token:session.sessionToken }, rateHeaders);
        return true;
      }
      const change = url.pathname.match(/\/(apt_[a-f0-9-]+)\/(reschedule|cancel)$/);
      if (change) {
        const result = await changeCustomerAppointment({ ...scope, appointment_intake_id:change[1], action:change[2],
          customer_confirmed:payload.customer_confirmed, expected_version:payload.expected_version,
          preferred_date:payload.preferred_date, preferred_time:payload.preferred_time, time_period:payload.time_period,
          idempotency_key:request.headers["idempotency-key"] });
        if (!result) sendError(request, response, requestId, 404, "APPOINTMENT_NOT_FOUND", "未找到当前咨询的到院登记。", [], rateHeaders);
        else sendJson(request, response, requestId, 200, { intake:customerView(result.intake), replayed:result.replayed,
          message:change[2] === "cancel" ? "到院登记已取消。" : `已更新您希望到院的时间：${result.intake.time_preference}。` }, rateHeaders);
        return true;
      }
      const capturedLead = await getCapturedLeadReferenceForSession({ tenant_id:tenantId, session_id:session.sessionId });
      const result = await createAppointmentIntake({
        tenant_id:tenantId,
        channel:"web",
        conversation_id:session.sessionId,
        source_action_id:payload.action_id,
        projects:Array.isArray(payload.projects) ? payload.projects.slice(0, 6) : [],
        doctor:payload.doctor,
        preferred_date:payload.preferred_date,
        preferred_time:payload.preferred_time,
        time_period:payload.time_period,
        branch:payload.branch,
        customer_confirmed:payload.customer_confirmed,
        idempotency_key:request.headers["idempotency-key"],
        internal_customer_reference:capturedLead?.customer_reference || null
      });
      sendJson(request, response, requestId, result.replayed ? 200 : 201, {
        request_id:requestId,
        status:"accepted",
        intake:customerView(result.intake),
        message:`已收到并登记您希望到院的时间：${result.intake.time_preference}。如需调整，您可以在这里修改或联系顾问。此记录不代表指定医生或接诊名额已锁定。`,
        session_id:session.sessionId,
        session_token:session.sessionToken,
        session_expires_at:session.expiresAt
      }, rateHeaders);
    } catch (error) {
      const validation = [
        "APPOINTMENT_SOURCE_INVALID", "APPOINTMENT_SUBJECT_REQUIRED",
        "APPOINTMENT_TIME_PREFERENCE_REQUIRED", "APPOINTMENT_CONTACT_REQUIRED"
      ].includes(error.code);
      sendError(
        request,
        response,
        requestId,
        validation ? 400 : Number(error.status) || 503,
        error.code || "APPOINTMENT_INTAKE_FAILED",
        error.code === "APPOINTMENT_CONTACT_REQUIRED"
          ? "请先保存本次咨询联系方式，再提交预约申请。"
          : (Number(error.status) >= 400 && Number(error.status) < 500) ? error.message : "到院登记暂时无法提交，请稍后再试",
        error.details || [],
        rateHeaders
      );
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/public/acquisition-lead") {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      const tooLarge = error.code === "BODY_TOO_LARGE";
      sendError(request, response, requestId, tooLarge ? 413 : 400, tooLarge ? "BODY_TOO_LARGE" : "INVALID_JSON", tooLarge ? "请求体不能超过64KB" : "请求体不是有效JSON");
      return true;
    }
    if (typeof payload.name === "string" && payload.name.trim().length > 40) {
      sendError(request, response, requestId, 400, "VALIDATION_ERROR", "称呼不能超过40个字符", [{ field:"name", message:"最多40个字符" }]);
      return true;
    }
    if (payload.messages && !Array.isArray(payload.messages)) {
      sendError(request, response, requestId, 400, "VALIDATION_ERROR", "messages必须是数组", [{ field:"messages", message:"格式不正确" }]);
      return true;
    }
    let tenantId;
    let session;
    try {
      tenantId = resolvePublicTenant(request, payload);
      session = resolvePublicSession(request, payload, tenantId);
    } catch (error) {
      sendError(request, response, requestId, error.status || 400, error.code || "INVALID_SESSION", error.message || "会话凭证校验失败", error.details || []);
      return true;
    }
    let rate;
    try { rate = await consumePublicRateLimit({ tenantId, operation:"lead", session }); }
    catch {
      sendError(request, response, requestId, 503, "RATE_LIMIT_STORE_UNAVAILABLE", "留资服务暂时不可用，请稍后再试");
      return true;
    }
    const rateHeaders = {
      "X-RateLimit-Limit":String(PUBLIC_WEB_RATE_LIMIT),
      "X-RateLimit-Remaining":String(rate.remaining),
      "X-RateLimit-Reset":rate.resetAt,
      "Set-Cookie":session.setCookie
    };
    if (!rate.allowed) {
      sendJson(request, response, requestId, 429, { error:{ code:"RATE_LIMITED", message:"提交请求较多，请稍后再试" }, request_id:requestId }, { ...rateHeaders, "Retry-After":"60" });
      return true;
    }
    try {
      const captured = await upsertAcquisitionLead({
        tenant_id:tenantId,
        mobile:payload.mobile,
        name:payload.name,
        service_consent:payload.service_consent,
        session_id:session.sessionId,
        interests:Array.isArray(payload.interests) ? payload.interests.slice(0, 10) : [],
        messages:Array.isArray(payload.messages) ? payload.messages.slice(-16) : []
      });
      sendJson(request, response, requestId, 200, {
        request_id:requestId,
        receipt_id:`lead_${randomUUID()}`,
        status:"accepted",
        identity:{ phone_verification_status:"pending_manual" },
        masked_mobile:captured.lead.customer.mobile,
        message:"已收到您的咨询信息，顾问将根据本次服务安排联系您，并在回电时人工核对手机号。",
        session_id:session.sessionId,
        session_token:session.sessionToken,
        session_expires_at:session.expiresAt
      }, rateHeaders);
    } catch (error) {
      const validationError = ["INVALID_MOBILE", "SERVICE_CONSENT_REQUIRED"].includes(error.code);
      const privacyConflict = ["PRIVACY_CONTACT_SUPPRESSED", "PRIVACY_CONTACT_SUBJECT_REQUIRED"].includes(error.code);
      sendError(
        request,
        response,
        requestId,
        privacyConflict ? 409 : validationError ? 400 : 500,
        privacyConflict || validationError ? error.code : "LEAD_CAPTURE_FAILED",
        privacyConflict
          ? "当前联系偏好不允许新建人工回访，您仍可继续在线咨询"
          : validationError ? error.message : "留资保存失败，请稍后再试",
        [],
        rateHeaders
      );
    }
    return true;
  }

  if (request.method === "GET" && (url.pathname === "/api/local/acquisition-customers" || !productionRuntime && url.pathname === "/api/local/conversation-events")) {
    let managementPrincipal;
    try {
      managementPrincipal = await authorizeManagementRequest(request, {
        requiredRoles:[MANAGEMENT_ROLES.customerRead],
        requiredAnyCapabilities:[PHASE_ONE_CAPABILITIES.customersReadAll, PHASE_ONE_CAPABILITIES.customersReadAssigned],
        tenantId:url.searchParams.get("tenant_id") || "",
        tenantField:"query.tenant_id"
      });
      await recordManagementAccess({ principal:managementPrincipal, requestId, request, action:"management.customer.read", resourceType:"customer_snapshot" });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }
    if(url.pathname === '/api/local/conversation-events') {
      response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no','Connection':'keep-alive'});
      response.write('retry: 2000\n\n');
      let closed=false,signature='',timer;
      const close=()=>{closed=true;clearTimeout(timer);clearTimeout(deadline);};
      const deadline=setTimeout(()=>{close();response.end();},30_000);
      response.on('close',close);
      const tick=async()=>{
        try {
          const data=await acquisitionCustomerSnapshot(managementPrincipal.tenantId,{operationalOnly:true,principal:managementPrincipal,includeLiveConversations:true});
          const next=createHash('sha256').update(JSON.stringify(data.conversations)).digest('hex');
          if(!closed&&next!==signature){signature=next;response.write('event: conversations\ndata: changed\n\n');}
        }catch{if(!closed){response.write('event: sync-error\ndata: unavailable\n\n');close();response.end();}}
        if(!closed)timer=setTimeout(tick,1000);
      };
      void tick();return true;
    }
    try {
      sendJson(request, response, requestId, 200, {
        data:await acquisitionCustomerSnapshot(managementPrincipal.tenantId, { operationalOnly:true, principal:managementPrincipal, includeLiveConversations:true }),
        request_id:requestId
      });
    } catch (error) {
      sendError(request, response, requestId, 400, error.code || "INVALID_TENANT_ID", error.message, error.details || []);
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/local/acquisition-agent/status") {
    let managementPrincipal;
    try {
      managementPrincipal = await authorizeManagementRequest(request, {
        requiredRoles:[MANAGEMENT_ROLES.serviceRead],
        requiredCapabilities:[PHASE_ONE_CAPABILITIES.platformManage],
        tenantId:url.searchParams.get("tenant_id") || "",
        tenantField:"query.tenant_id"
      });
      await recordManagementAccess({ principal:managementPrincipal, requestId, request, action:"management.service.read", resourceType:"acquisition_agent_status" });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }
    const acquisitionService = await getAcquisitionServiceStatus();
    sendJson(request, response, requestId, 200, {
      data:acquisitionService,
      request_id:requestId
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/local/acquisition-channels") {
    let managementPrincipal;
    try {
      managementPrincipal = await authorizeManagementRequest(request, {
        requiredRoles:[MANAGEMENT_ROLES.serviceRead],
        requiredAnyCapabilities:[PHASE_ONE_CAPABILITIES.platformManage, PHASE_ONE_CAPABILITIES.conversationsReadAssigned],
        tenantId:url.searchParams.get("tenant_id") || "",
        tenantField:"query.tenant_id"
      });
      await recordManagementAccess({
        principal:managementPrincipal,
        requestId,
        request,
        action:"management.acquisition_channels.read",
        resourceType:"acquisition_channel"
      });
    } catch (error) {
      sendManagementAuthorizationError(request, response, requestId, error);
      return true;
    }
    try {
      sendJson(request, response, requestId, 200, {
        data:await listAcquisitionServiceChannels(),
        request_id:requestId
      });
    } catch (error) {
      sendError(request, response, requestId, Number(error.status) || 503, error.code || "ACQUISITION_CHANNELS_UNAVAILABLE", "IM 通道状态暂时无法读取", error.details || []);
    }
    return true;
  }

  if (!authenticate(request)) {
    sendError(request, response, requestId, 401, "UNAUTHORIZED", "缺少或提供了无效的X-API-Key");
    return true;
  }

  let rate;
  try { rate = await consumeRateLimit(request); }
  catch {
    sendError(request, response, requestId, 503, "RATE_LIMIT_STORE_UNAVAILABLE", "请求协调服务暂时不可用");
    return true;
  }
  const rateHeaders = { "X-RateLimit-Limit": String(RATE_LIMIT), "X-RateLimit-Remaining": String(rate.remaining), "X-RateLimit-Reset": rate.resetAt };
  if (!rate.allowed) {
    sendJson(request, response, requestId, 429, { error: { code: "RATE_LIMITED", message: "已超过每分钟调用上限" }, request_id: requestId }, { ...rateHeaders, "Retry-After": "60" });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/agents") {
    const llm = getLlmStatus();
    sendJson(request, response, requestId, 200, { data: AGENT_DEFINITIONS, meta: { total: AGENT_DEFINITIONS.length, runtime: llm.mode, llm: { enabled: llm.enabled, configured: llm.configured, provider: llm.provider, model: llm.model } }, request_id: requestId }, rateHeaders);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/model/status") {
    sendJson(request, response, requestId, 200, { data: getLlmStatus(), request_id: requestId }, rateHeaders);
    return true;
  }

  const agentDetailMatch = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)$/);
  if (request.method === "GET" && agentDetailMatch) {
    const agent = AGENT_DEFINITIONS.find((item) => item.id === agentDetailMatch[1] || item.slug === agentDetailMatch[1]);
    if (!agent) sendError(request, response, requestId, 404, "AGENT_NOT_FOUND", "未找到指定AI员工");
    else sendJson(request, response, requestId, 200, { data: agent, request_id: requestId }, rateHeaders);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/runs") {
    let managementPrincipal = null;
    if (productionRuntime) {
      try {
        managementPrincipal = await authorizeManagementRequest(request, {
          requiredRoles:[MANAGEMENT_ROLES.runsRead],
          requiredCapabilities:[PHASE_ONE_CAPABILITIES.platformManage],
          tenantId:url.searchParams.get("tenant_id") || "",
          tenantField:"query.tenant_id"
        });
        await recordManagementAccess({ principal:managementPrincipal, requestId, request, action:"management.agent_run.list", resourceType:"agent_run" });
      } catch (error) {
        sendManagementAuthorizationError(request, response, requestId, error);
        return true;
      }
    }
    const limit = url.searchParams.get("limit");
    const tenantId = managementPrincipal?.tenantId || "";
    const localRuns = listRuns(limit).filter((item) => item.agent_id !== "A-01" && (!tenantId || item.tenant_id === tenantId));
    let acquisitionRuns = [];
    try { acquisitionRuns = await listAcquisitionServiceRuns(limit, tenantId || undefined); } catch {}
    const merged = [...localRuns, ...acquisitionRuns].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Math.min(Math.max(Number(limit) || 50, 1), 100));
    sendJson(request, response, requestId, 200, { data:merged, request_id: requestId }, rateHeaders);
    return true;
  }

  const runMatch = url.pathname.match(/^\/api\/v1\/runs\/(run_[a-f0-9-]+)$/i);
  if (request.method === "GET" && runMatch) {
    let managementPrincipal = null;
    if (productionRuntime) {
      try {
        managementPrincipal = await authorizeManagementRequest(request, {
          requiredRoles:[MANAGEMENT_ROLES.runsRead],
          requiredCapabilities:[PHASE_ONE_CAPABILITIES.platformManage],
          tenantId:url.searchParams.get("tenant_id") || "",
          tenantField:"query.tenant_id"
        });
        await recordManagementAccess({ principal:managementPrincipal, requestId, request, action:"management.agent_run.read", resourceType:"agent_run", resourceId:runMatch[1] });
      } catch (error) {
        sendManagementAuthorizationError(request, response, requestId, error);
        return true;
      }
    }
    const tenantId = managementPrincipal?.tenantId || "";
    let run = getRun(runMatch[1]);
    if (run && tenantId && run.audit?.tenant_id !== tenantId) run = null;
    if (!run) {
      try { run = await getAcquisitionServiceRun(runMatch[1], tenantId || undefined); } catch {}
    }
    if (!run) sendError(request, response, requestId, 404, "RUN_NOT_FOUND", "未找到指定运行记录");
    else sendJson(request, response, requestId, 200, { data: run, request_id: requestId }, rateHeaders);
    return true;
  }

  const invocationMatch = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)\/invoke$/);
  const isRouter = url.pathname === "/api/v1/router/invoke";
  const isComplianceAlias = url.pathname === "/api/v1/compliance/check";
  if (request.method === "POST" && (invocationMatch || isRouter || isComplianceAlias)) {
    const idempotencyKey = String(request.headers["idempotency-key"] || "").trim().slice(0, 128);
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      const tooLarge = error.code === "BODY_TOO_LARGE";
      sendError(request, response, requestId, tooLarge ? 413 : 400, tooLarge ? "BODY_TOO_LARGE" : "INVALID_JSON", tooLarge ? "请求体不能超过64KB" : "请求体不是有效JSON");
      return true;
    }
    const caller = String(request.headers["x-client-id"] || "api_client").slice(0, 128);
    const cacheKey = idempotencyKey ? scopedKey(
      "gateway",
      payload.tenant_id || "default",
      caller,
      url.pathname,
      idempotencyKey
    ) : "";
    const payloadHash = cacheKey ? canonicalPayloadHash({ path:url.pathname, payload }) : "";
    let claim = null;
    if (cacheKey) {
      try { claim = await idempotencyStore.claim(cacheKey, payloadHash); }
      catch {
        sendError(request, response, requestId, 503, "IDEMPOTENCY_STORE_UNAVAILABLE", "请求协调服务暂时不可用", [], rateHeaders);
        return true;
      }
      if (claim.status === "conflict") {
        sendError(request, response, requestId, 409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "同一幂等键不能用于不同的请求内容", [], rateHeaders);
        return true;
      }
      if (claim.status === "pending") {
        sendError(request, response, requestId, 409, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中，请稍后重试", [], { ...rateHeaders, "Retry-After":"1" });
        return true;
      }
      if (claim.status === "replay") {
        sendJson(request, response, requestId, 200, claim.value, { ...rateHeaders, "X-Idempotent-Replay":"true" });
        return true;
      }
    }
    const validationErrors = validateInvocation(payload);
    if (validationErrors.length) {
      if (cacheKey && claim?.token) {
        try { await idempotencyStore.release(cacheKey, claim.token); } catch {}
      }
      sendError(request, response, requestId, 400, "VALIDATION_ERROR", "请求参数校验失败", validationErrors);
      return true;
    }
    const metadata = { requestId, caller };
    let result;
    try {
      if (isRouter) {
        const selectedAgentId = routeAgent(payload);
        result = selectedAgentId === "A-01"
          ? await callAcquisitionLegacyInvocation(payload, { ...metadata, idempotencyKey })
          : await invokeAgentAsync(selectedAgentId, payload, metadata);
        result = { ...result, routing:{ selected_agent_id:selectedAgentId, reason:"lifecycle_intent_and_risk_rules", router_version:"2.0.0" } };
      } else {
        const requestedAgent = AGENT_DEFINITIONS.find((item) => item.id === invocationMatch?.[1] || item.slug === invocationMatch?.[1]);
        result = requestedAgent?.id === "A-01"
          ? await callAcquisitionLegacyInvocation(payload, { ...metadata, idempotencyKey })
          : await invokeAgentAsync(isComplianceAlias ? "A-06" : invocationMatch[1], payload, metadata);
      }
    } catch (error) {
      if (cacheKey && claim?.token) {
        try { await idempotencyStore.release(cacheKey, claim.token); } catch {}
      }
      if (["TENANT_ACCESS_DENIED", "TENANT_CONTEXT_MISMATCH", "INSUFFICIENT_PERMISSION"].includes(error.code)) {
        sendError(request, response, requestId, 403, error.code, error.message, error.details || [], rateHeaders);
        return true;
      }
      throw error;
    }
    if (!result) {
      if (cacheKey && claim?.token) {
        try { await idempotencyStore.release(cacheKey, claim.token); } catch {}
      }
      sendError(request, response, requestId, 404, "AGENT_NOT_FOUND", "未找到指定AI员工");
      return true;
    }
    if (cacheKey && claim?.token) {
      let completed;
      try { completed = await idempotencyStore.complete(cacheKey, result, claim.token); }
      catch {
        sendError(request, response, requestId, 503, "IDEMPOTENCY_STORE_UNAVAILABLE", "请求结果暂时无法确认，请使用相同幂等键重试", [], { ...rateHeaders, "Retry-After":"1" });
        return true;
      }
      if (!completed) {
        sendError(request, response, requestId, 409, "IDEMPOTENCY_CLAIM_LOST", "请求处理权已过期，请使用相同幂等键重试", [], { ...rateHeaders, "Retry-After":"1" });
        return true;
      }
    }
    sendJson(request, response, requestId, 200, result, rateHeaders);
    return true;
  }

  if (["POST", "PUT", "PATCH"].includes(request.method) && !invocationMatch && !isRouter && !isComplianceAlias) {
    sendError(request, response, requestId, 404, "API_NOT_FOUND", "未找到指定API端点");
    return true;
  }

  sendError(request, response, requestId, 404, "API_NOT_FOUND", "未找到指定API端点");
  return true;
}
