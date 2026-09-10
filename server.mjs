import { createAdminSessions, readLoginBody } from "./server/platform/admin-browser-session.mjs";
import { authenticateManagedBasic, applyManagementAccount } from "./server/platform/management-accounts.mjs";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
try {
  process.loadEnvFile(join(root, ".env.local"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const port = Number(process.env.PORT || 4173);
const host = process.env.HUAMEI_HOST || "127.0.0.1";
const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(host);
const externalTestMode = String(process.env.HUAMEI_EXTERNAL_TEST_MODE || "false").toLowerCase() === "true";
const productionRuntime = ["prod", "production"].includes(String(
  process.env.HUAMEI_RUNTIME_ENV || process.env.HUAMEI_DEPLOYMENT_ENV || process.env.NODE_ENV || "development"
).trim().toLowerCase());
const externalOidcProxyMode = productionRuntime
  && String(process.env.HUAMEI_ADMIN_BROWSER_AUTH_MODE || "").trim() === "external_oidc_pkce_proxy";
const externalTestAllowsMiniMaxReal = externalTestMode
  && String(process.env.HUAMEI_EXTERNAL_TEST_ALLOW_MINIMAX_REAL || "false").toLowerCase() === "true";
// A temporary public tunnel defaults to simulation. Real H3 access requires a
// second, external-test-only opt-in in addition to the provider's existing
// master switch, API key and user allowlist. This assignment must precede
// runtime imports because the provider freezes feature flags on evaluation.
if (externalTestMode && !externalTestAllowsMiniMaxReal) process.env.MINIMAX_REAL_CALL_ENABLED = "false";
const {
  closeApiRuntime,
  DEMO_API_KEY,
  handleApiRequest,
  authenticateManagementSurfaceRequest,
  initializeApiRuntime,
  markAdminRequestAuthenticated
} = await import("./server/api-router.mjs");
const { startPhysicianAvatarWorker } = await import("./server/physician-avatar-runtime.mjs");
const configuredApiKey = process.env.HUAMEI_API_KEY || "";
const adminUsername = String(process.env.HUAMEI_ADMIN_USERNAME || "").trim();
const adminPassword = String(process.env.HUAMEI_ADMIN_PASSWORD || "");
const browserSessionAuth = !productionRuntime && (process.env.HUAMEI_ADMIN_SESSION_AUTH === 'true' || isLoopback && process.env.HUAMEI_LOCAL_REQUIRE_AUTH === 'true');
if (browserSessionAuth && (!adminUsername || adminPassword.length < 8)) throw new Error('后台会话登录需要配置有效的管理员账号及至少8位密码');
const adminSessions = createAdminSessions();
const sessionOrigins = new Set(isLoopback ? [`http://127.0.0.1:${port}`,`http://localhost:${port}`,`http://[::1]:${port}`] : String(process.env.HUAMEI_ALLOWED_ORIGINS||'').split(',').map(v=>v.trim()).filter(v=>v.startsWith('https://')));
if(browserSessionAuth && !sessionOrigins.size) throw new Error('后台会话登录需要配置 HTTPS 管理域名');
const authJson = (response,status,data)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(data));};
const previewUsername = String(process.env.HUAMEI_PREVIEW_USERNAME || "").trim();
const previewPassword = String(process.env.HUAMEI_PREVIEW_PASSWORD || "");
if ((!isLoopback || externalTestMode) && (configuredApiKey.length < 24 || configuredApiKey === DEMO_API_KEY)) {
  throw new Error("非本机地址或临时外测模式启动时必须通过HUAMEI_API_KEY设置长度不少于24位的非演示密钥");
}
if ((!isLoopback || externalTestMode) && !externalOidcProxyMode && (!adminUsername || adminUsername.includes(":") || adminPassword.length < 8)) {
  throw new Error("非本机地址或临时外测模式启动时必须配置HUAMEI_ADMIN_USERNAME与长度不少于8位的HUAMEI_ADMIN_PASSWORD");
}
if (externalTestMode && (!previewUsername || previewUsername.includes(":") || previewPassword.length < 16)) {
  throw new Error("临时外测模式必须配置独立的HUAMEI_PREVIEW_USERNAME与长度不少于16位的HUAMEI_PREVIEW_PASSWORD");
}
if (externalTestMode && previewUsername === adminUsername && previewPassword === adminPassword) {
  throw new Error("临时外测账号不得与管理后台账号复用");
}
const advisorRoot = join(root, "apps", "acquisition-advisor", "dist", "client");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4"
};

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
};

const validBasicAuthorization = (request, username, password) => {
  const match = String(request.headers.authorization || "").match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return false;
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 1) return false;
  return safeEqual(decoded.slice(0, separator), username) && safeEqual(decoded.slice(separator + 1), password);
};

const validAdminAuthorization = (request) => isLoopback && !externalTestMode && process.env.HUAMEI_LOCAL_REQUIRE_AUTH !== 'true'
  ? true
  : validBasicAuthorization(request, adminUsername, adminPassword);

const validPreviewAuthorization = (request) => externalTestMode
  && validBasicAuthorization(request, previewUsername, previewPassword);

const staticHeaders = (filePath, cacheControl = "no-store") => ({
  "Content-Type": mime[extname(filePath).toLowerCase()] || "application/octet-stream",
  "Cache-Control": cacheControl,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "SAMEORIGIN"
});

const pathInside = (base, requested) => {
  const candidate = resolve(base, requested);
  const relation = relative(base, candidate);
  return relation && !relation.startsWith("..") && !isAbsolute(relation) ? candidate : null;
};

const regularFile = async (filePath) => {
  if (!filePath) return null;
  try {
    return (await stat(filePath)).isFile() ? filePath : null;
  } catch {
    return null;
  }
};

const sendFile = async (request, response, filePath, cacheControl = "no-store") => {
  const body = await readFile(filePath);
  response.writeHead(200, staticHeaders(filePath, cacheControl));
  response.end(request.method === "HEAD" ? undefined : body);
};

const sendNotFound = (response) => {
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end("Not Found");
};

const sendAdminChallenge = (response) => {
  response.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "WWW-Authenticate": productionRuntime ? 'Bearer realm="Huamei Admin"' : 'Basic realm="Beauty Admin", charset="UTF-8"',
    "X-Content-Type-Options": "nosniff"
  });
  response.end(productionRuntime ? "请通过企业SSO登录管理后台" : "请输入管理后台账号与密码");
};

const sendPreviewChallenge = (response) => {
  response.writeHead(401, {
    "Content-Type":"text/plain; charset=utf-8",
    "Cache-Control":"no-store",
    "WWW-Authenticate":'Basic realm="Beauty Preview", charset="UTF-8"',
    "X-Content-Type-Options":"nosniff"
  });
  response.end("请输入外部测试账号与密码");
};

const sendManagementRuntimeConfig = (request, response) => {
  // Non-secret capability declaration. Local development uses a server-backed
  // persistent overlay rather than browser demo data. Production remains fail
  // closed until the corresponding PostgreSQL-backed admin domains are ready.
  const document = {
    schema:"huamei.management-runtime.v1",
    browser_session_auth:browserSessionAuth,
    delivery_mode:productionRuntime ? "handover_only" : "local_server",
    demo_mutations_enabled:false,
    management_domain_enabled:!productionRuntime,
    // This is the only non-handover management page deliberately exposed in
    // production: it is a read-only, server-backed governance view.
    knowledge_governance_enabled:true,
    // Internal content intake is server-backed, department-scoped and kept
    // separate from customer-facing knowledge releases.
    knowledge_intake_enabled:true
  };
  const body = `window.__HUAMEI_MANAGEMENT_RUNTIME__=Object.freeze(${JSON.stringify(document)});\n`;
  response.writeHead(200, {
    "Content-Type":"text/javascript; charset=utf-8",
    "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff",
    "Referrer-Policy":"same-origin",
    "X-Frame-Options":"SAMEORIGIN"
  });
  response.end(request.method === "HEAD" ? undefined : body);
};

const isPreviewSurface = (pathname) => pathname === "/advisor"
  || pathname.startsWith("/advisor/")
  || pathname.startsWith("/assets/")
  || pathname === "/favicon.ico"
  || pathname === "/favicon-girl.svg"
  || pathname.startsWith("/api/public/")
  || pathname === "/api/v1/openapi.json";

// The management shell previously rendered before Basic authentication in the
// external-test deployment. Its follow-up API calls then had no authenticated
// admin context and were correctly rejected as local-only. Challenge before
// serving the shell and its module assets so browser fetches retain the admin
// credential for the same origin.
const isManagementSurface = (pathname) => pathname === "/"
  || pathname === "/index.html"
  || pathname === "/styles.css"
  || pathname === "/runtime-config.js"
  || pathname.startsWith("/src/");

const advisorFileFor = async (pathname) => {
  let relativePath = "";
  if (pathname === "/advisor" || pathname === "/advisor/") relativePath = "index.html";
  else if (pathname.startsWith("/advisor/")) relativePath = pathname.slice("/advisor/".length);
  // The current advisor bundle was built with root-absolute asset URLs. Keep
  // those exact generated files public while also supporting /advisor/*.
  else if (pathname === "/favicon-girl.svg" || pathname === "/favicon.ico" || pathname.startsWith("/assets/")) relativePath = pathname.slice(1);
  else return null;

  const candidate = pathInside(advisorRoot, relativePath);
  const file = await regularFile(candidate);
  if (file) return file;
  if (pathname === "/advisor" || pathname === "/advisor/" || (pathname.startsWith("/advisor/") && !extname(pathname))) {
    return regularFile(join(advisorRoot, "index.html"));
  }
  return null;
};

const managementFileFor = async (pathname) => {
  if (pathname === "/" || pathname === "/index.html") return regularFile(join(root, "index.html"));
  if (pathname === "/styles.css") return regularFile(join(root, "styles.css"));
  for (const prefix of ["/src/", "/assets/"]) {
    if (!pathname.startsWith(prefix)) continue;
    const base = join(root, prefix.slice(1, -1));
    return regularFile(pathInside(base, pathname.slice(prefix.length)));
  }
  return null;
};

// Production must prove PostgreSQL and Redis are reachable before opening the
// listening socket. Development keeps its process-local adapters.
await initializeApiRuntime();
startPhysicianAvatarWorker();

const gatewayServer = createServer(async (request, response) => {
  try {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`).pathname);
    } catch {
      sendNotFound(response);
      return;
    }
    let session = null;
    if (browserSessionAuth) {
      const secure = !isLoopback;
      const originAllowed = sessionOrigins.has(request.headers.origin);
      if(pathname === '/login' || pathname === '/auth/login.js') {
        if(!['GET','HEAD'].includes(request.method)) {authJson(response,405,{error:{message:'请求方式不支持'}});return;}
        await sendFile(request,response,join(root,'assets',pathname==='/login'?'admin-login.html':'admin-login.js'));return;
      }
      if(pathname.startsWith('/auth/')) {
        if(pathname==='/auth/session' && request.method==='GET') {
          session=adminSessions.read(request,{touch:false});
          if(session?.principal)try {const current=await applyManagementAccount(session.principal,process.env.HUAMEI_PUBLIC_TENANT_ID||'huamei-shanghai',{required:true});if(current.accountVersion!==session.principal.accountVersion)throw new Error('account changed');} catch {adminSessions.revoke(request);session=null;}
          authJson(response,session?200:401,{authenticated:Boolean(session)});return;
        }
        if(request.method!=='POST'){authJson(response,405,{error:{message:'请求方式不支持'}});return;}
        if(!originAllowed){authJson(response,403,{error:{message:'登录请求来源不受信任'}});return;}
        if(pathname==='/auth/logout'){adminSessions.revoke(request);response.setHeader('Set-Cookie',adminSessions.cookie('',secure));authJson(response,200,{ok:true});return;}
        if(pathname==='/auth/login') {
          if(!adminSessions.allowLogin(request)){response.setHeader('Retry-After','60');authJson(response,429,{error:{message:'尝试过于频繁，请一分钟后重试'}});return;}
          let input;try {input=await readLoginBody(request);}catch{authJson(response,400,{error:{message:'请输入有效的账号和密码'}});return;}
          let principal=null;
          const bootstrap=safeEqual(input.username,adminUsername)&&safeEqual(input.password,adminPassword);
          if(!bootstrap)try{principal=await authenticateManagedBasic({headers:{authorization:'Basic '+Buffer.from(input.username+':'+input.password).toString('base64')},socket:request.socket},process.env.HUAMEI_PUBLIC_TENANT_ID||'huamei-shanghai');}catch{authJson(response,503,{error:{message:'账号服务暂时不可用，请稍后重试'}});return;}
          if(!bootstrap&&!principal){authJson(response,401,{error:{message:'账号或密码错误，或账号已停用'}});return;}
          response.setHeader('Set-Cookie',adminSessions.cookie(adminSessions.issue(request,principal),secure));authJson(response,200,{ok:true});return;
        }
        sendNotFound(response);return;
      }
      session=adminSessions.read(request,{touch:isManagementSurface(pathname)||pathname.startsWith('/api/admin/')||pathname.startsWith('/api/local/')});
      if(session?.principal)try{const current=await applyManagementAccount(session.principal,process.env.HUAMEI_PUBLIC_TENANT_ID||'huamei-shanghai',{required:true});if(current.accountVersion!==session.principal.accountVersion)throw new Error('account changed');session.principal=current;}catch{adminSessions.revoke(request);session=null;}
      if(isManagementSurface(pathname)||pathname.startsWith('/api/admin/')||pathname.startsWith('/api/local/')) {
        if(!session){response.setHeader('Set-Cookie',adminSessions.cookie('',secure));if(pathname.startsWith('/api/'))authJson(response,401,{error:{code:'ADMIN_SESSION_REQUIRED',message:'登录已过期，请重新登录'}});else{response.writeHead(303,{Location:'/login?reason=required','Cache-Control':'no-store'});response.end();}return;}
        if(!['GET','HEAD','OPTIONS'].includes(request.method)&&!originAllowed){authJson(response,403,{error:{code:'AUTH_ORIGIN_REJECTED',message:'请求来源不受信任'}});return;}
      }
    }
    let adminAuthenticated = browserSessionAuth ? Boolean(session) : productionRuntime ? false : validAdminAuthorization(request);
    const managedPrincipal = browserSessionAuth ? session?.principal || null : !productionRuntime && !adminAuthenticated && !validPreviewAuthorization(request) && String(request.headers.authorization||"").startsWith("Basic ")
      ? await authenticateManagedBasic(request,process.env.HUAMEI_PUBLIC_TENANT_ID||"huamei-shanghai") : null;
    if(managedPrincipal)adminAuthenticated=true;
    if (productionRuntime && !pathname.startsWith("/api/")) {
      try {
        adminAuthenticated = Boolean(await authenticateManagementSurfaceRequest(request));
      } catch {
        adminAuthenticated = false;
      }
    }
    const previewAuthenticated = validPreviewAuthorization(request);
    if (externalTestMode && isPreviewSurface(pathname) && !previewAuthenticated && !adminAuthenticated) {
      sendPreviewChallenge(response);
      return;
    }
    if (externalTestMode && isManagementSurface(pathname) && !adminAuthenticated) {
      sendAdminChallenge(response);
      return;
    }
    // Basic credentials are only a development/external-preview compatibility
    // gate. Production management APIs establish identity from OIDC Bearer
    // tokens inside api-router and never inherit this edge authentication bit.
    if (adminAuthenticated && !productionRuntime) markAdminRequestAuthenticated(request,managedPrincipal);
    if (await handleApiRequest(request, response)) return;
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Method Not Allowed");
      return;
    }
    const advisorFile = await advisorFileFor(pathname);
    if (advisorFile) {
      await sendFile(request, response, advisorFile, extname(advisorFile) === ".html" ? "no-store" : "public, max-age=3600");
      return;
    }

    const managementFile = await managementFileFor(pathname);
    if (pathname === "/runtime-config.js") {
      if (!adminAuthenticated) {
        sendAdminChallenge(response);
        return;
      }
      sendManagementRuntimeConfig(request, response);
      return;
    }
    if (!managementFile) {
      sendNotFound(response);
      return;
    }
    if (!adminAuthenticated) {
      sendAdminChallenge(response);
      return;
    }
    await sendFile(request, response, managementFile);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" });
    response.end(productionRuntime ? "服务暂时不可用" : `本地服务错误：${error.message}`);
  }
});

gatewayServer.listen(port, host, () => {
  console.log(`时代之美 MVP 与 AI员工 API 已启动：http://${host}:${port}`);
  console.log(`OpenAPI：http://${host}:${port}/api/v1/openapi.json`);
  if (externalTestMode) {
    const miniMaxMode = externalTestAllowsMiniMaxReal && String(process.env.MINIMAX_REAL_CALL_ENABLED || "false").toLowerCase() === "true"
      ? "MiniMax真实生成已显式开放，仍受API密钥与用户白名单控制"
      : "MiniMax真实生成保持关闭";
    console.log(`临时外测模式已开启：访客预览与管理后台使用独立认证，${miniMaxMode}`);
  }
  console.log("医师AI分身后台轮询已启动；真实调用权限由服务端白名单与总开关控制");
});

let gatewayClosing = false;
const closeGateway = () => {
  if (gatewayClosing) return;
  gatewayClosing = true;
  gatewayServer.close(async () => {
    try { await closeApiRuntime(); } catch (error) {
      console.error(`网关依赖关闭失败：${error.code || error.message}`);
    }
    process.exit(0);
  });
};
process.once("SIGINT", closeGateway);
process.once("SIGTERM", closeGateway);
