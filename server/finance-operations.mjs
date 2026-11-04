import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildApprovedFinanceWorkbook } from "./finance-export.mjs";

const DEFAULT_STORE_FILE = resolve(process.cwd(), ".local-data", "finance", "operations.json");
const STORE_FILE = String(process.env.HUAMEI_FINANCE_STORE_FILE || "").trim();
const EVIDENCE_ROOT = String(process.env.HUAMEI_FINANCE_EVIDENCE_ROOT || "").trim();
const memoryMode = STORE_FILE === ":memory:";
const storeFile = memoryMode ? "" : resolve(STORE_FILE || DEFAULT_STORE_FILE);
const evidenceRoot = () => resolve(EVIDENCE_ROOT || join(process.cwd(), ".local-data", "finance", "evidence"));
const MAX_EVIDENCE_FILES = 3;
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
let memoryState = null;
let operationQueue = Promise.resolve();

const requestTypes = new Set(["expense", "payment", "procurement"]);
const requestTypeLabels = Object.freeze({ expense:"费用报销", payment:"付款申请", procurement:"采购申请" });
const text = (value, max = 120) => String(value || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const money = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100_000_000) {
    throw Object.assign(new Error("金额必须大于0且不超过1亿元"), { code:"FINANCE_AMOUNT_INVALID", status:400 });
  }
  return Math.round(number * 100) / 100;
};
const nowIso = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${randomUUID()}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const evidencePublic = (evidence = []) => evidence.map(({ storage_name, ...item }) => item);
const publicRequest = (record) => ({ ...clone(record), evidence:evidencePublic(record.evidence || []) });
const emptyTenant = () => ({ pettyCash:[], requests:[], events:[], revision:0 });
const emptyState = () => ({ schemaVersion:1, tenants:{} });
const readState = async () => {
  if (memoryMode) {
    memoryState ||= emptyState();
    return clone(memoryState);
  }
  try {
    const parsed = JSON.parse(await readFile(storeFile, "utf8"));
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.tenants || typeof parsed.tenants !== "object") throw new Error("invalid");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw Object.assign(new Error("财务数据文件无法读取，请检查本地数据服务"), { code:"FINANCE_STORE_INVALID", status:500 });
  }
};
const writeState = async (state) => {
  if (memoryMode) {
    memoryState = clone(state);
    return;
  }
  await mkdir(dirname(storeFile), { recursive:true });
  await writeFile(storeFile, `${JSON.stringify(state, null, 2)}\n`, { encoding:"utf8", mode:0o600 });
};
const withState = (operation) => {
  const run = operationQueue.then(async () => {
    const state = await readState();
    const result = await operation(state);
    await writeState(state);
    return result;
  });
  operationQueue = run.catch(() => {});
  return run;
};
const tenantState = (state, tenantId) => {
  const key = text(tenantId, 120) || "default";
  state.tenants[key] ||= emptyTenant();
  const tenant = state.tenants[key];
  for (const field of ["pettyCash", "requests", "events"]) if (!Array.isArray(tenant[field])) tenant[field] = [];
  tenant.revision = Math.max(0, Number(tenant.revision) || 0);
  return tenant;
};
const appendEvent = (tenant, { type, actor, resourceType, resourceId, detail }) => {
  tenant.events.unshift({
    id:uid("finevt"),
    type:text(type, 80),
    actor:text(actor, 120) || "system",
    resource_type:text(resourceType, 40),
    resource_id:text(resourceId, 100),
    detail:text(detail, 240),
    at:nowIso()
  });
  tenant.events = tenant.events.slice(0, 10_000);
};
const assertVersion = (record, expectedVersion) => {
  if (!record) throw Object.assign(new Error("未找到财务记录"), { code:"FINANCE_RECORD_NOT_FOUND", status:404 });
  if (Number(expectedVersion) !== record.version) {
    throw Object.assign(new Error("财务记录已变化，请刷新后再操作"), { code:"FINANCE_VERSION_CONFLICT", status:409 });
  }
};

const evidenceImageType = (buffer) => {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9) {
    return { extension:"jpg", mime_type:"image/jpeg" };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension:"png", mime_type:"image/png" };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension:"webp", mime_type:"image/webp" };
  }
  throw Object.assign(new Error("凭据图片仅支持JPG、PNG或WebP"), { code:"FINANCE_EVIDENCE_TYPE_INVALID", status:400 });
};
const prepareEvidence = (values) => {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw Object.assign(new Error("凭据图片格式无效"), { code:"FINANCE_EVIDENCE_INVALID", status:400 });
  if (values.length > MAX_EVIDENCE_FILES) {
    throw Object.assign(new Error("每笔财务申请最多上传3张凭据图片"), { code:"FINANCE_EVIDENCE_COUNT_EXCEEDED", status:400 });
  }
  return values.map((value) => {
    const encoded = String(value?.data_base64 || "").trim();
    if (!encoded || encoded.length > Math.ceil(MAX_EVIDENCE_BYTES * 4 / 3) + 4
        || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw Object.assign(new Error("凭据图片内容无效"), { code:"FINANCE_EVIDENCE_INVALID", status:400 });
    }
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.length > MAX_EVIDENCE_BYTES) {
      throw Object.assign(new Error("每张凭据图片不能超过5MB"), { code:"FINANCE_EVIDENCE_SIZE_INVALID", status:400 });
    }
    const type = evidenceImageType(buffer);
    const originalName = basename(String(value?.file_name || "凭据图片")).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
    if (!originalName) throw Object.assign(new Error("凭据图片文件名无效"), { code:"FINANCE_EVIDENCE_NAME_INVALID", status:400 });
    const id = uid("finevidence");
    return {
      id,
      file_name:originalName,
      mime_type:type.mime_type,
      size:buffer.length,
      sha256:createHash("sha256").update(buffer).digest("hex"),
      storage_name:`${id}.${type.extension}`,
      uploaded_at:nowIso(),
      buffer
    };
  });
};
const tenantEvidenceDirectory = (tenantId) => join(evidenceRoot(), createHash("sha256").update(text(tenantId, 120)).digest("hex").slice(0, 24));
const storeEvidence = async (tenantId, files) => {
  if (!files.length) return;
  const directory = tenantEvidenceDirectory(tenantId);
  await mkdir(directory, { recursive:true, mode:0o700 });
  for (const file of files) {
    await writeFile(join(directory, file.storage_name), file.buffer, { mode:0o600, flag:"wx" });
  }
};
const removeStoredEvidence = async (tenantId, files) => {
  const directory = tenantEvidenceDirectory(tenantId);
  for (const file of files) await unlink(join(directory, file.storage_name)).catch(() => {});
};

export async function getFinanceOverview({ tenantId } = {}) {
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    return { ...clone(tenant), requests:tenant.requests.map(publicRequest) };
  });
}

export async function createPettyCashApplication({ tenantId, actor, payload = {} } = {}) {
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    const record = {
      id:uid("finpc"),
      employee_name:text(payload.employee_name, 80),
      employee_account:text(payload.employee_account, 100),
      company:text(payload.company, 120),
      project_name:text(payload.project_name, 120),
      amount:money(payload.amount),
      purpose:text(payload.purpose, 500),
      application_status:"pending",
      writeoff_status:"not_issued",
      issued_at:null,
      written_off_amount:null,
      writeoff_reference:null,
      written_off_at:null,
      version:1,
      created_by:text(actor, 120) || "system",
      created_at:nowIso(),
      updated_at:nowIso()
    };
    if (!record.employee_name || !record.employee_account || !record.company || !record.purpose) {
      throw Object.assign(new Error("请填写员工、登录账号、所属公司和备用金用途"), { code:"FINANCE_PETTY_CASH_INVALID", status:400 });
    }
    tenant.pettyCash.unshift(record);
    tenant.pettyCash = tenant.pettyCash.slice(0, 10_000);
    appendEvent(tenant, { type:"finance.petty_cash.created", actor, resourceType:"petty_cash", resourceId:record.id, detail:`${record.employee_name} · ¥${record.amount.toFixed(2)}` });
    tenant.revision += 1;
    return clone(record);
  });
}

export async function issuePettyCash({ tenantId, actor, id, expectedVersion } = {}) {
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    const record = tenant.pettyCash.find((item) => item.id === id);
    assertVersion(record, expectedVersion);
    if (record.application_status !== "pending") {
      throw Object.assign(new Error("备用金已发放或状态不允许重复发放"), { code:"FINANCE_PETTY_CASH_STATE_INVALID", status:409 });
    }
    record.application_status = "approved";
    record.writeoff_status = "pending";
    record.issued_at = nowIso();
    record.updated_at = nowIso();
    record.version += 1;
    appendEvent(tenant, { type:"finance.petty_cash.issued", actor, resourceType:"petty_cash", resourceId:record.id, detail:`${record.employee_name} · 待核销` });
    tenant.revision += 1;
    return clone(record);
  });
}

export async function writeOffPettyCash({ tenantId, actor, id, expectedVersion, payload = {} } = {}) {
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    const record = tenant.pettyCash.find((item) => item.id === id);
    assertVersion(record, expectedVersion);
    if (record.application_status !== "approved" || record.writeoff_status !== "pending") {
      throw Object.assign(new Error("只有待核销备用金可以登记核销"), { code:"FINANCE_PETTY_CASH_STATE_INVALID", status:409 });
    }
    const writtenOffAmount = money(payload.written_off_amount);
    if (writtenOffAmount > record.amount) {
      throw Object.assign(new Error("核销金额不能大于备用金金额"), { code:"FINANCE_WRITEOFF_AMOUNT_EXCEEDED", status:400 });
    }
    const reference = text(payload.writeoff_reference, 200);
    if (!reference) throw Object.assign(new Error("请填写核销凭据或说明"), { code:"FINANCE_WRITEOFF_REFERENCE_REQUIRED", status:400 });
    record.writeoff_status = "completed";
    record.written_off_amount = writtenOffAmount;
    record.writeoff_reference = reference;
    record.written_off_at = nowIso();
    record.updated_at = nowIso();
    record.version += 1;
    appendEvent(tenant, { type:"finance.petty_cash.written_off", actor, resourceType:"petty_cash", resourceId:record.id, detail:`${record.employee_name} · 已核销 ¥${writtenOffAmount.toFixed(2)}` });
    tenant.revision += 1;
    return clone(record);
  });
}

export async function createFinanceRequest({ tenantId, actor, payload = {} } = {}) {
  const evidenceFiles = prepareEvidence(payload.evidence_files);
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    const type = text(payload.type, 30);
    if (!requestTypes.has(type)) throw Object.assign(new Error("请选择费用报销、付款申请或采购申请"), { code:"FINANCE_REQUEST_TYPE_INVALID", status:400 });
    if (type === "expense" && evidenceFiles.length === 0) {
      throw Object.assign(new Error("费用报销必须上传至少一张凭据截图"), { code:"FINANCE_EVIDENCE_REQUIRED", status:400 });
    }
    const record = {
      id:uid("finreq"),
      type,
      type_label:requestTypeLabels[type],
      company:text(payload.company, 120),
      expense_type:text(payload.expense_type, 80),
      project_name:text(payload.project_name, 120),
      applicant:text(payload.applicant, 80),
      employee_account:text(payload.employee_account, 100),
      amount:money(payload.amount),
      cost_center:text(payload.cost_center, 120),
      invoice_reference:text(payload.invoice_reference, 120),
      description:text(payload.description, 1000),
      approval_status:"pending",
      approved_at:null,
      approved_by:null,
      evidence:evidenceFiles.map(({ buffer, ...item }) => item),
      version:1,
      created_by:text(actor, 120) || "system",
      created_at:nowIso(),
      updated_at:nowIso()
    };
    if (!record.company || !record.expense_type || !record.project_name || !record.applicant) {
      throw Object.assign(new Error("请填写所属公司、费用类型、项目名称和申请人"), { code:"FINANCE_REQUEST_INVALID", status:400 });
    }
    try {
      await storeEvidence(tenantId, evidenceFiles);
    } catch {
      await removeStoredEvidence(tenantId, evidenceFiles);
      throw Object.assign(new Error("凭据图片保存失败，请稍后重试"), { code:"FINANCE_EVIDENCE_STORE_FAILED", status:503 });
    }
    tenant.requests.unshift(record);
    tenant.requests = tenant.requests.slice(0, 100_000);
    appendEvent(tenant, { type:"finance.request.created", actor, resourceType:"finance_request", resourceId:record.id, detail:`${record.type_label} · ¥${record.amount.toFixed(2)}` });
    tenant.revision += 1;
    return publicRequest(record);
  });
}

export async function approveFinanceRequest({ tenantId, actor, id, expectedVersion } = {}) {
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    const record = tenant.requests.find((item) => item.id === id);
    assertVersion(record, expectedVersion);
    if (record.approval_status !== "pending") {
      throw Object.assign(new Error("该申请已审批完成，不能重复审批"), { code:"FINANCE_APPROVAL_STATE_INVALID", status:409 });
    }
    record.approval_status = "approved";
    record.approved_at = nowIso();
    record.approved_by = text(actor, 120) || "system";
    record.updated_at = nowIso();
    record.version += 1;
    appendEvent(tenant, { type:"finance.request.approved", actor, resourceType:"finance_request", resourceId:record.id, detail:`${record.type_label} · 审批完成` });
    tenant.revision += 1;
    return publicRequest(record);
  });
}

export async function getFinanceEvidence({ tenantId, actor, requestId, evidenceId } = {}) {
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    const request = tenant.requests.find((item) => item.id === requestId);
    const evidence = request?.evidence?.find((item) => item.id === evidenceId);
    if (!evidence) throw Object.assign(new Error("未找到凭据图片"), { code:"FINANCE_EVIDENCE_NOT_FOUND", status:404 });
    let buffer;
    try {
      buffer = await readFile(join(tenantEvidenceDirectory(tenantId), evidence.storage_name));
    } catch {
      throw Object.assign(new Error("凭据图片文件不存在"), { code:"FINANCE_EVIDENCE_STORAGE_MISSING", status:404 });
    }
    appendEvent(tenant, { type:"finance.evidence.viewed", actor, resourceType:"finance_request", resourceId:request.id, detail:`查看凭据图片 ${evidence.file_name}` });
    tenant.revision += 1;
    return { buffer, file_name:evidence.file_name, mime_type:evidence.mime_type };
  });
}

export async function exportApprovedFinanceRequests({ tenantId, actor } = {}) {
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    const approved = tenant.requests.filter((item) => item.approval_status === "approved");
    const buffer = await buildApprovedFinanceWorkbook(approved);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    appendEvent(tenant, { type:"finance.export.completed", actor, resourceType:"finance_export", resourceId:stamp, detail:`导出已完成审批 ${approved.length} 条` });
    tenant.revision += 1;
    return {
      buffer,
      count:approved.length,
      file_name:`财务审批已完成_${stamp}.xlsx`
    };
  });
}
