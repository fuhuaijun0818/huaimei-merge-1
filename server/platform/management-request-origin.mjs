const productionEnvironment = (env) => ["prod", "production"].includes(String(
  env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "development"
).trim().toLowerCase());

const originError = () => Object.assign(
  new Error("Management browser request origin is not allowed"),
  { code:"MANAGEMENT_CSRF_ORIGIN_FORBIDDEN", status:403 }
);

export function assertManagementRequestOrigin(request, env = process.env) {
  if (!productionEnvironment(env) && env.HUAMEI_EXTERNAL_TEST_MODE !== "true") return;
  const expectedOrigin = String(env.HUAMEI_ADMIN_ORIGIN || (env.HUAMEI_ALLOWED_ORIGINS || "").split(",")[0] || "").trim().replace(/\/$/, "");
  const origin = String(request?.headers?.origin || "").trim().replace(/\/$/, "");
  const fetchSite = String(request?.headers?.["sec-fetch-site"] || "").trim().toLowerCase();
  const browserRequest = Boolean(origin || fetchSite);
  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(String(request?.method || "GET").toUpperCase());
  const crossOriginFetch = ["cross-site", "same-site"].includes(fetchSite);
  // A top-level navigation legitimately arrives as Sec-Fetch-Site:none and no
  // Origin. Allow that only for safe methods. Mutations from a browser must
  // carry both the exact configured Origin and same-origin Fetch Metadata.
  if ((origin && origin !== expectedOrigin)
    || crossOriginFetch
    || (browserRequest && unsafeMethod && (origin !== expectedOrigin || fetchSite !== "same-origin"))) {
    throw originError();
  }
}
