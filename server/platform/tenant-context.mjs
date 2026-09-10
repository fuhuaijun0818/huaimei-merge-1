export const DEFAULT_TENANT_ID = String(process.env.HUAMEI_DEFAULT_TENANT_ID || "huamei-shanghai")
  .trim()
  .toLowerCase();

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export function normalizeTenantId(value, fallback = DEFAULT_TENANT_ID) {
  const normalized = String(value || fallback || "").trim().toLowerCase();
  if (!TENANT_ID_PATTERN.test(normalized)) {
    const error = new Error("tenant_id格式无效，仅支持3–64位小写字母、数字、下划线或连字符");
    error.code = "INVALID_TENANT_ID";
    error.details = [{ field:"tenant_id", message:"请输入有效租户编号" }];
    throw error;
  }
  return normalized;
}

export function tenantIdFromPayload(payload = {}) {
  return normalizeTenantId(
    payload.tenant_id
      || payload.tenantId
      || payload.context?.tenant_id
      || payload.context?.tenantId
  );
}

export function tenantScopedKey(tenantId, ...parts) {
  return [normalizeTenantId(tenantId), ...parts.map((part) => String(part || ""))].join(":");
}

export function getTenantContextStatus() {
  return {
    default_tenant_id:DEFAULT_TENANT_ID,
    tenant_id_required_on_external_calls:true,
    backward_compatibility:"missing tenant_id maps to the configured default tenant"
  };
}
