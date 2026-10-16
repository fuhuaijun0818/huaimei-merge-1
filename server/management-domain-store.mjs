import { createJsonStateStore } from "./platform/json-state-store.mjs";

// The browser bundle carries the reviewed source baseline (knowledge, product,
// price-evidence and physician imports). The server only persists the operator
// overlay, so a normal customer or task update never copies the 7,127-unit
// knowledge package through the browser or turns it into a local mock dataset.
const SCHEMA = "huamei.management-domain-overlay.v1";
const DYNAMIC_COLLECTIONS = Object.freeze([
  "managementUsers", "managementRoles", "customers", "tasks", "conversations",
  "journeys", "agents", "connectors", "audit", "handovers", "configurationRecords"
]);
const OVERRIDE_COLLECTIONS = Object.freeze([
  "productOverrides", "physicianOverrides", "knowledgeOverrides"
]);
const ALLOWED_FIELDS = new Set(["currentRole", ...DYNAMIC_COLLECTIONS, ...OVERRIDE_COLLECTIONS]);
const COLLECTION_LIMITS = Object.freeze({
  managementUsers:5_000,
  managementRoles:1_000,
  customers:100_000,
  tasks:200_000,
  conversations:100_000,
  journeys:10_000,
  agents:1_000,
  connectors:1_000,
  audit:200_000,
  handovers:100_000,
  configurationRecords:10_000,
  productOverrides:5_000,
  physicianOverrides:5_000,
  knowledgeOverrides:20_000
});
const MAX_TEXT_LENGTH = 20_000;
const MAX_DEPTH = 16;
const MAX_IDEMPOTENCY_RECORDS = 500;

const clone = (value) => JSON.parse(JSON.stringify(value));
const emptyOverlay = () => ({
  currentRole:"管理者",
  managementUsers:[],
  managementRoles:[],
  customers:[],
  tasks:[],
  conversations:[],
  journeys:[],
  agents:[],
  connectors:[],
  audit:[],
  handovers:[],
  configurationRecords:[],
  productOverrides:[],
  physicianOverrides:[],
  knowledgeOverrides:[]
});

const stateStore = createJsonStateStore({
  envName:"HUAMEI_MANAGEMENT_DOMAIN_STORE_FILE",
  defaultFile:".local-data/management-domain-overlay.json",
  initialState:{ schema:SCHEMA, version:1, tenants:{} }
});

const operationError = (code, message, status = 400, details = []) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};

const cleanValue = (value, field = "overlay", depth = 0) => {
  if (depth > MAX_DEPTH) throw operationError("MANAGEMENT_STATE_TOO_DEEP", "管理数据层级不能超过16层", 400, [{ field }]);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw operationError("MANAGEMENT_STATE_INVALID", "管理数据包含无效数值", 400, [{ field }]);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_TEXT_LENGTH) throw operationError("MANAGEMENT_TEXT_TOO_LONG", "单个字段不能超过20000个字符", 400, [{ field }]);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500_000) throw operationError("MANAGEMENT_ARRAY_TOO_LARGE", "数组数据量超出允许范围", 400, [{ field }]);
    return value.map((item, index) => cleanValue(item, `${field}[${index}]`, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 500) throw operationError("MANAGEMENT_OBJECT_TOO_LARGE", "单条记录字段数超出允许范围", 400, [{ field }]);
    return Object.fromEntries(entries.map(([key, item]) => {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
        throw operationError("MANAGEMENT_FIELD_INVALID", "管理数据包含不支持的字段名", 400, [{ field:`${field}.${key}` }]);
      }
      return [key, cleanValue(item, `${field}.${key}`, depth + 1)];
    }));
  }
  throw operationError("MANAGEMENT_STATE_INVALID", "管理数据包含不支持的字段类型", 400, [{ field }]);
};

const normalizeCollection = (name, value) => {
  if (!Array.isArray(value)) throw operationError("MANAGEMENT_COLLECTION_INVALID", `${name}必须是数组`, 400, [{ field:name }]);
  if (value.length > COLLECTION_LIMITS[name]) {
    throw operationError("MANAGEMENT_COLLECTION_TOO_LARGE", `${name}超过单租户允许的数据量`, 413, [{ field:name, limit:COLLECTION_LIMITS[name] }]);
  }
  const records = value.map((item, index) => cleanValue(item, `${name}[${index}]`));
  const ids = new Set();
  for (const record of records) {
    const id = String(record?.id || "").trim();
    if (!id || id.length > 160) throw operationError("MANAGEMENT_RECORD_ID_REQUIRED", `${name}中的记录必须具有有效id`, 400, [{ field:name }]);
    if (ids.has(id)) throw operationError("MANAGEMENT_RECORD_ID_DUPLICATE", `${name}中存在重复id`, 409, [{ field:name, id }]);
    ids.add(id);
  }
  return records;
};

const normalizeOverlay = (raw = {}) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw operationError("MANAGEMENT_OVERLAY_INVALID", "管理数据必须是对象", 400);
  }
  const unknown = Object.keys(raw).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) {
    throw operationError("MANAGEMENT_OVERLAY_FIELD_FORBIDDEN", "请求不能写入未授权的管理字段", 400, unknown.map((field) => ({ field })));
  }
  const normalized = emptyOverlay();
  normalized.currentRole = String(raw.currentRole || "管理者").trim().slice(0, 80) || "管理者";
  for (const field of [...DYNAMIC_COLLECTIONS, ...OVERRIDE_COLLECTIONS]) {
    normalized[field] = normalizeCollection(field, raw[field] || []);
  }
  return normalized;
};

const tenantRecord = (root, tenantId) => {
  const existing = root.tenants?.[tenantId];
  if (existing && existing.schema === SCHEMA) return existing;
  return {
    schema:SCHEMA,
    revision:0,
    overlay:emptyOverlay(),
    updated_at:null,
    updated_by:null,
    idempotency:{}
  };
};

const assertTenantId = (tenantId) => {
  const normalized = String(tenantId || "").trim();
  // Development tenants are seeded as e.g. `team_alpha`; accept underscores
  // alongside the established alphanumeric and hyphen form. The value remains
  // strictly bounded and cannot contain path separators or whitespace.
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(normalized)) {
    throw operationError("MANAGEMENT_TENANT_INVALID", "租户标识不合法", 400);
  }
  return normalized;
};

export function getManagementDomainOverlay({ tenantId }) {
  const normalizedTenant = assertTenantId(tenantId);
  const root = stateStore.load();
  const record = tenantRecord(root, normalizedTenant);
  return {
    schema:SCHEMA,
    tenant_id:normalizedTenant,
    revision:Number(record.revision) || 0,
    updated_at:record.updated_at || null,
    updated_by:record.updated_by || null,
    overlay:normalizeOverlay(record.overlay || emptyOverlay()),
    storage:stateStore.status()
  };
}

export function replaceManagementDomainOverlay({ tenantId, expectedRevision, overlay, actor, idempotencyKey }) {
  const normalizedTenant = assertTenantId(tenantId);
  const normalizedOverlay = normalizeOverlay(overlay);
  const revision = Number(expectedRevision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw operationError("MANAGEMENT_REVISION_REQUIRED", "保存管理数据必须提供当前revision", 400, [{ field:"revision" }]);
  }
  const key = String(idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 128) {
    throw operationError("IDEMPOTENCY_KEY_REQUIRED", "管理数据写操作必须提供8–128字符的Idempotency-Key", 400, [{ field:"Idempotency-Key" }]);
  }
  const actorId = String(actor || "").trim().slice(0, 160) || "local-admin";
  const root = stateStore.load();
  const record = tenantRecord(root, normalizedTenant);
  const replay = record.idempotency?.[key];
  if (replay) return { ...clone(replay), replayed:true };
  if (Number(record.revision) !== revision) {
    throw operationError("MANAGEMENT_REVISION_CONFLICT", "后台数据已被其他操作更新，请刷新后重试", 409, [{ expected_revision:revision, actual_revision:Number(record.revision) || 0 }]);
  }
  const now = new Date().toISOString();
  const result = {
    schema:SCHEMA,
    tenant_id:normalizedTenant,
    revision:revision + 1,
    updated_at:now,
    updated_by:actorId,
    overlay:normalizedOverlay,
    storage:stateStore.status()
  };
  const idempotency = { ...(record.idempotency || {}), [key]:result };
  const retainedEntries = Object.entries(idempotency).slice(-MAX_IDEMPOTENCY_RECORDS);
  root.tenants = {
    ...(root.tenants || {}),
    [normalizedTenant]:{
      schema:SCHEMA,
      revision:result.revision,
      overlay:normalizedOverlay,
      updated_at:now,
      updated_by:actorId,
      idempotency:Object.fromEntries(retainedEntries)
    }
  };
  root.schema = SCHEMA;
  root.version = 1;
  stateStore.save(root);
  return { ...clone(result), replayed:false };
}

export function getManagementDomainStoreStatus() {
  return { schema:SCHEMA, ...stateStore.status() };
}
