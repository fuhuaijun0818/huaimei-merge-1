import { knowledgeIntakeContext, withKnowledgeIntake, persistIntakeAsset, loadIntakeAsset } from "./persistence/knowledge-intake-persistence.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonStateStore } from "./platform/json-state-store.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";
import { indexRuntimeKnowledgeDocument, removeRuntimeKnowledgeDocument, runtimeKnowledgeIndexStatus } from "./runtime-knowledge-index.mjs";

// Raw materials, parsed derivatives and published knowledge deliberately live
// in three separate layers. This module owns only the first two layers: an
// internal, access-controlled material vault and an auditable intake workflow.
// Customer-facing retrieval is bound solely through knowledge-release-policy.
const store = createJsonStateStore({
  envName:"HUAMEI_KNOWLEDGE_INTAKE_STORE_FILE",
  defaultFile:".local-data/knowledge-intake.json",
  initialState:{ version:3, documents:[], assets:[], events:[] }
});

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const assetRoot = () => resolve(String(process.env.HUAMEI_KNOWLEDGE_INTAKE_ASSET_ROOT || "").trim()
  || join(projectRoot, ".local-data", "knowledge-intake-assets"));
const allowedContentTypes = new Set(["项目介绍", "医生介绍", "服务流程", "活动权益", "公开海报", "排班说明", "其他"]);
const sourceProfiles = new Map([
  ["txt", { kind:"text", mimes:["text/plain"], maxBytes:256 * 1024 }],
  ["md", { kind:"text", mimes:["text/markdown", "text/plain"], maxBytes:256 * 1024 }],
  ["markdown", { kind:"text", mimes:["text/markdown", "text/plain"], maxBytes:256 * 1024 }],
  ["csv", { kind:"text", mimes:["text/csv", "text/plain"], maxBytes:256 * 1024 }],
  ["json", { kind:"text", mimes:["application/json", "text/plain"], maxBytes:256 * 1024 }],
  ["pdf", { kind:"controlled_parser", mimes:["application/pdf"], maxBytes:32 * 1024 * 1024 }],
  ["docx", { kind:"controlled_parser", mimes:["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], maxBytes:32 * 1024 * 1024 }],
  ["jpg", { kind:"controlled_parser", mimes:["image/jpeg"], maxBytes:16 * 1024 * 1024 }],
  ["jpeg", { kind:"controlled_parser", mimes:["image/jpeg"], maxBytes:16 * 1024 * 1024 }],
  ["png", { kind:"controlled_parser", mimes:["image/png"], maxBytes:16 * 1024 * 1024 }],
  ["webp", { kind:"controlled_parser", mimes:["image/webp"], maxBytes:16 * 1024 * 1024 }]
]);
const nowIso = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const saveState = state => { const tx=knowledgeIntakeContext.getStore(); if(tx) {tx.state=state;tx.dirty=true;} else store.save(state); };
const stateWithCollections = () => {
  if(knowledgeIntakeContext.getStore()) return knowledgeIntakeContext.getStore().state;
  const environment = String(process.env.HUAMEI_RUNTIME_ENV || process.env.HUAMEI_DEPLOYMENT_ENV || process.env.NODE_ENV || "development").trim().toLowerCase();
  if (["production", "prod"].includes(environment)) {
    throw Object.assign(new Error("资料持久化服务尚未完成生产接入，暂时无法读写。"), { code:"KNOWLEDGE_INTAKE_PERSISTENCE_NOT_READY", status:503 });
  }
  const state = store.load();
  if (!Array.isArray(state.documents)) state.documents = [];
  if (!Array.isArray(state.assets)) state.assets = [];
  if (!Array.isArray(state.events)) state.events = [];
  if (!Number.isInteger(state.version) || state.version < 3) state.version = 3;
  return state;
};
const clean = (value, limit = 160) => String(value || "")
  .replace(/[<>]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);
const cleanLines = (value, limit = 240_000) => String(value || "")
  .replace(/\u0000/g, "")
  .replace(/\r\n?/g, "\n")
  .trim()
  .slice(0, limit);
const parsePreviewFor = (value, filename) => {
  const lines = cleanLines(value).split("\n");
  const segments = [];
  let block = [];
  let startLine = 1;
  const append = (endLine) => {
    const content = block.join("\n").trim();
    if (!content) return;
    const ordinal = segments.length + 1;
    const isTable = block.filter((line) => line.trim()).every((line) => /^\s*\|/.test(line));
    segments.push({
      id:`segment-${ordinal}`,
      source_filename:sourceFilename(filename),
      kind:isTable ? "table" : "paragraph",
      paragraph:ordinal,
      line_start:startLine,
      line_end:endLine,
      locator:`${isTable ? "表格" : "段落"} ${ordinal} · 第 ${startLine}${endLine > startLine ? `–${endLine}` : ""} 行`,
      content:cleanLines(content, 1_200)
    });
  };
  lines.forEach((line, index) => {
    if (line.trim()) {
      if (!block.length) startLine = index + 1;
      block.push(line);
      return;
    }
    append(index);
    block = [];
  });
  append(lines.length);
  return segments.slice(0, 120);
};
const parseAssessmentFor = (value, filename) => {
  const preview = parsePreviewFor(value, filename).map((segment) => ({ ...segment, issue_codes:[] }));
  const lines = cleanLines(value).split("\n");
  const issues = [];
  const mark = (code, message, lineStart, lineEnd = lineStart, segment = null) => {
    const locator = `第 ${lineStart}${lineEnd > lineStart ? `–${lineEnd}` : ""} 行`;
    issues.push({ code, message, locator, line_start:lineStart, line_end:lineEnd, segment_id:segment?.id || null });
    if (segment && !segment.issue_codes.includes(code)) segment.issue_codes.push(code);
  };
  let blankStart = null;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) {
      blankStart ??= lineNumber;
      return;
    }
    if (blankStart && lineNumber - blankStart >= 2) mark("EMPTY_BLOCK", "检测到连续空白块，请确认是否遗漏正文。", blankStart, lineNumber - 1);
    blankStart = null;
    if (/[\uFFFD\u0001-\u0008\u000B\u000C\u000E-\u001F]/u.test(line)) {
      mark("GARBLED_TEXT", "检测到乱码或不可见控制字符，请人工核对原文件。", lineNumber, lineNumber, preview.find((segment) => segment.line_start <= lineNumber && segment.line_end >= lineNumber));
    }
  });
  if (blankStart && lines.length - blankStart >= 1) mark("EMPTY_BLOCK", "检测到连续空白块，请确认是否遗漏正文。", blankStart, lines.length);
  preview.filter((segment) => segment.kind === "table").forEach((segment) => {
    const tableLines = String(segment.content || "").split("\n").filter((line) => line.trim());
    const columnCounts = tableLines.map((line) => line.trim().replace(/^\||\|$/g, "").split("|").length);
    const hasDivider = tableLines.some((line) => line.trim().replace(/^\||\|$/g, "").split("|").every((cell) => /^:?-{3,}:?$/.test(cell.trim())));
    if (tableLines.length < 2 || !hasDivider || new Set(columnCounts).size !== 1) {
      mark("TABLE_STRUCTURE_INVALID", "表格列数或分隔行异常，请按原文件人工核对。", segment.line_start, segment.line_end, segment);
    }
  });
  return {
    preview,
    quality:{ status:issues.length ? "needs_attention" : "ready", issues }
  };
};
const cleanList = (value, limit = 12) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => clean(item, 80))
  .filter(Boolean))].slice(0, limit);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const invalid = (code, message, details = []) => Object.assign(new Error(message), { code, status:400, details });
const forbidden = (code, message) => Object.assign(new Error(message), { code, status:403 });
const conflict = (code, message, details = []) => Object.assign(new Error(message), { code, status:409, details });
const sourceFilename = (value) => clean(value, 160).replace(/[^\w.\-\u4e00-\u9fff（）()]/g, "_");
const extensionOf = (filename) => String(filename || "").toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] || "";
const firstMeaningfulLine = (content, fallback) => content
  .split("\n")
  .map((line) => line.replace(/^\s*[#>*-]+\s*/, "").trim())
  .find((line) => line.length >= 4) || fallback;
const assetStoragePath = (assetId, extension) => join(assetRoot(), `${assetId}.${extension}`);

const confirmationDigest = (document) => sha256(JSON.stringify([
  document.version, document.content_hash, document.title, document.department,
  document.content_type, document.owner, document.tags, document.source_reference,
  document.source_sha256, document.applicable_campuses, document.public_scope,
  document.customer_facing_candidate, document.effective_at, document.expires_at
]));

export function knowledgeIntakeReadiness(document) {
  const missing = [];
  const now = Date.now();
  if (document.parser_status !== "parsed" || String(document.raw_text || "").length < 20) missing.push("parsed_content");
  if (!document.source_reference) missing.push("source_reference");
  if (!document.applicable_campuses?.length) missing.push("applicable_campuses");
  if (!document.customer_facing_candidate || !["customer_summary", "public_full"].includes(document.public_scope)) missing.push("public_scope");
  if (!Number.isFinite(Date.parse(document.effective_at))) missing.push("effective_at");
  if (!(Date.parse(document.expires_at) > now && Date.parse(document.expires_at) > Date.parse(document.effective_at))) missing.push("expires_at");
  const confirmation = document.hospital_confirmation;
  if (!confirmation || confirmation.version !== document.version || confirmation.digest !== confirmationDigest(document)
    || !(Date.parse(confirmation.expires_at) > now) || !confirmation.reference || !confirmation.confirmed_by) missing.push("hospital_confirmation");
  return { ready:missing.length === 0, missing, published:false, next_step:"正式评测与发布" };
}

const publicAsset = (asset, { includeUploadUrl = false } = {}) => {
  if (!asset) return null;
  const { storage_path:ignoredStoragePath, prepare_idempotency_key:ignoredPrepareKey, prepare_payload_hash:ignoredPrepareHash, ...safe } = asset;
  return {
    ...clone(safe),
    ...(includeUploadUrl ? { upload_url:`/api/admin/knowledge/intake/assets/${encodeURIComponent(asset.id)}/content` } : {})
  };
};

const versionCompareFields = [
  "title", "raw_text", "department", "content_type", "owner", "tags",
  "source_reference", "applicable_campuses", "public_scope",
  "customer_facing_candidate", "effective_at", "expires_at"
];
const versionHistoryFor = (document) => {
  const snapshots = [...(document.versions || []), document];
  return (document.versions || []).map((version, index) => {
    const next = snapshots[index + 1] || document;
    const changedFields = versionCompareFields.filter((field) => JSON.stringify(canonical(version[field] ?? null)) !== JSON.stringify(canonical(next[field] ?? null)));
    return {
      version:version.version,
      content_hash:version.content_hash,
      title:version.title,
      updated_at:version.updated_at,
      changed_fields_to_next:changedFields
    };
  });
};

// Raw originals remain in the private version snapshots.  A correction record
// is deliberately exposed only by detailDocument (after department access has
// been checked), never by the list/public projection used elsewhere.
const correctionHistoryFor = (document) => {
  const versions = document.versions || [];
  const snapshots = [...versions, document];
  return versions.flatMap((version, index) => {
    const next = snapshots[index + 1] || document;
    if (String(version.raw_text || "") === String(next.raw_text || "")) return [];
    return [{
      from_version:Number(version.version),
      to_version:Number(next.version),
      original_source:{
        source_filename:version.source_filename || null,
        source_sha256:version.source_sha256 || null,
        source_asset_id:version.source_asset_id || null,
        source_reference:version.source_reference || null
      },
      original_content_hash:version.content_hash || null,
      corrected_content_hash:next.content_hash || null,
      corrected_by:next.updated_by || next.created_by || null,
      corrected_at:next.updated_at || next.created_at || null,
      // This is an authorized-detail field, not a list or retrieval field.
      original_text:String(version.raw_text || "")
    }];
  });
};

const publicDocument = (document) => {
  if (!document) return null;
  const {
    raw_text:ignoredRaw,
    create_idempotency_key:ignoredKey,
    create_payload_hash:ignoredHash,
    submit_idempotency_key:ignoredSubmitKey,
    review_idempotency_keys:ignoredReviewKeys,
    versions:ignoredVersions,
    mutations:ignoredMutations,
    parse_preview:ignoredParsePreview,
    ...safe
  } = document;
  return clone({ ...safe,
    status:document.status === "indexed" ? "draft" : document.status,
    knowledge_base_status:"internal_only",
    publication_status:"not_published",
    publication_readiness:knowledgeIntakeReadiness(document),
    version_history:versionHistoryFor(document)
  });
};

const detailDocument = (document) => ({
  ...publicDocument(document),
  text_content:document.raw_text || "",
  parse_preview:clone(document.parse_preview || parseAssessmentFor(document.raw_text || "", document.source_filename).preview),
  parse_quality:clone(document.parse_quality || parseAssessmentFor(document.raw_text || "", document.source_filename).quality),
  correction_history:clone(correctionHistoryFor(document))
});

const appendEvent = (state, event) => {
  state.events.unshift(event);
  state.events = state.events.slice(0, 10_000);
};
const canAccessDepartment = (department, permittedDepartments = []) => {
  const scope = new Set((Array.isArray(permittedDepartments) ? permittedDepartments : []).map((item) => clean(item, 80)));
  return scope.has("*") || scope.has(department);
};
const assertDepartmentAccess = (department, permittedDepartments) => {
  if (!canAccessDepartment(department, permittedDepartments)) {
    throw forbidden("KNOWLEDGE_DEPARTMENT_FORBIDDEN", "当前账号无权维护该科室知识");
  }
};
const assertActor = (value, action) => {
  const actor = clean(value, 120);
  if (!actor) throw invalid("KNOWLEDGE_ACTOR_REQUIRED", `${action}必须绑定当前实名操作人`);
  return actor;
};
const assertIdempotency = (value, action) => {
  const key = clean(value, 128);
  if (key.length < 8) throw invalid("IDEMPOTENCY_KEY_REQUIRED", `${action}必须提供8位以上幂等键`);
  return key;
};
const profileForFilename = (filename) => {
  const extension = extensionOf(filename);
  const profile = sourceProfiles.get(extension);
  if (!profile) {
    throw invalid("KNOWLEDGE_FILE_TYPE_UNSUPPORTED", "仅可上传 TXT、Markdown、CSV、JSON、PDF、DOCX、JPG、PNG 或 WEBP；其他材料请先完成格式转换");
  }
  return { extension, profile };
};
const assertMime = (profile, mime) => {
  const normalized = String(mime || "").split(";")[0].trim().toLowerCase();
  if (!profile.mimes.includes(normalized)) {
    throw invalid("KNOWLEDGE_ASSET_MIME_UNSUPPORTED", "文件MIME类型与允许格式不一致");
  }
  return normalized;
};
const assertSourceSignature = (asset, buffer) => {
  const extension = asset.extension;
  const isJpeg = ["jpg", "jpeg"].includes(extension) && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  const isPng = extension === "png" && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = extension === "webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  const isPdf = extension === "pdf" && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const isDocx = extension === "docx" && buffer.subarray(0, 4).toString("ascii") === "PK\u0003\u0004";
  const text = sourceProfiles.get(extension)?.kind === "text";
  if (![isJpeg, isPng, isWebp, isPdf, isDocx, text].some(Boolean)) {
    throw invalid("KNOWLEDGE_ASSET_SIGNATURE_MISMATCH", "文件二进制签名与声明格式不一致");
  }
};

const normalizeMetadata = (payload = {}) => {
  const filename = sourceFilename(payload.source_filename);
  const { extension, profile } = profileForFilename(filename);
  const department = clean(payload.department, 80);
  const contentType = clean(payload.content_type, 40);
  const owner = clean(payload.owner, 80);
  const tags = cleanList(payload.tags);
  const effectiveAt = String(payload.effective_at || "").trim() || null;
  const expiresAt = String(payload.expires_at || "").trim() || null;
  const metadataErrors = [
    !department && { field:"department", message:"请填写所属科室" },
    !allowedContentTypes.has(contentType) && { field:"content_type", message:"请选择受支持的内容类型" },
    !owner && { field:"owner", message:"请填写内容负责人" }
  ].filter(Boolean);
  if (metadataErrors.length) {
    throw invalid("KNOWLEDGE_INTAKE_METADATA_REQUIRED", "请补充所属科室、内容类型和内容负责人", metadataErrors);
  }
  const timeFormatErrors = [
    effectiveAt && Number.isNaN(Date.parse(effectiveAt)) && { field:"effective_at", message:"生效日期格式不正确" },
    expiresAt && Number.isNaN(Date.parse(expiresAt)) && { field:"expires_at", message:"失效日期格式不正确" }
  ].filter(Boolean);
  if (timeFormatErrors.length) {
    throw invalid("KNOWLEDGE_EFFECTIVE_TIME_INVALID", "生效时间或失效时间格式不正确", timeFormatErrors);
  }
  if (effectiveAt && expiresAt && Date.parse(expiresAt) <= Date.parse(effectiveAt)) {
    throw invalid("KNOWLEDGE_EFFECTIVE_RANGE_INVALID", "失效时间必须晚于生效时间", [
      { field:"effective_at", message:"生效日期必须早于失效日期" },
      { field:"expires_at", message:"失效日期必须晚于生效日期" }
    ]);
  }
  return {
    source_filename:filename,
    extension,
    source_kind:profile.kind,
    department,
    content_type:contentType,
    owner,
    tags,
    effective_at:effectiveAt ? new Date(effectiveAt).toISOString() : null,
    expires_at:expiresAt ? new Date(expiresAt).toISOString() : null,
    source_reference:clean(payload.source_reference, 500),
    applicable_campuses:cleanList(payload.applicable_campuses),
    public_scope:["customer_summary", "public_full"].includes(payload.public_scope) ? payload.public_scope : "internal",
    customer_facing_candidate:payload.customer_facing_candidate === true
  };
};

const createDocument = ({ state, tenantId, actor, normalized, rawText = "", asset = null, idempotencyKey = "", parserStatus, parseSummary, status = "draft" }) => {
  const contentHash = rawText ? sha256(rawText) : String(asset?.content_sha256 || "");
  const duplicate = state.documents.find((item) => item.tenant_id === tenantId
    && item.department === normalized.department && item.content_hash === contentHash
    && !["rejected", "archived"].includes(item.status));
  if (duplicate) return { document:duplicate, duplicate:true };
  const now = nowIso();
  const fallbackTitle = normalized.source_filename.replace(/\.[^.]+$/, "");
  const parsed = parserStatus === "parsed" ? parseAssessmentFor(rawText, normalized.source_filename) : { preview:[], quality:{ status:"not_available", issues:[] } };
  const needsAttention = parsed.quality.status === "needs_attention";
  const document = {
    id:`kidoc_${randomUUID()}`,
    tenant_id:tenantId,
    ...normalized,
    source_asset_id:asset?.id || null,
    source_mime:asset?.mime || null,
    source_size:asset?.size || null,
    source_sha256:asset?.content_sha256 || (rawText ? sha256(rawText) : null),
    title:clean(rawText ? firstMeaningfulLine(rawText, fallbackTitle) : fallbackTitle, 120),
    excerpt:rawText ? clean(rawText, 500) : null,
    content_hash:contentHash,
    parser_status:needsAttention ? "needs_attention" : parserStatus,
    parse_summary:needsAttention ? "检测到解析质量问题，已标为待处理；修正前不会建立内部检索索引。" : parseSummary,
    parse_preview:parsed.preview,
    parse_quality:parsed.quality,
    status:needsAttention ? "parsing_pending" : status,
    knowledge_base_status:"internal_only",
    retrieval_index_status:needsAttention ? "awaiting_correction" : parserStatus === "parsed" ? "indexing" : "awaiting_parse",
    retrieval_index_mode:null,
    embedding_model:null,
    indexed_chunk_count:0,
    indexed_at:null,
    graph_build_status:"not_requested",
    graph_build_reason:null,
    knowledge_record_id:null,
    reviews:[],
    version:1,
    created_by:actor,
    submitted_by:null,
    submitted_at:null,
    create_idempotency_key:idempotencyKey || null,
    create_payload_hash:null,
    review_idempotency_keys:{},
    raw_text:rawText || null,
    created_at:now,
    updated_at:now
  };
  state.documents.unshift(document);
  state.documents = state.documents.slice(0, 10_000);
  appendEvent(state, {
    id:`kievent_${randomUUID()}`,
    tenant_id:tenantId,
    type:"knowledge_intake.material_parsed",
    document_id:document.id,
    asset_id:asset?.id || null,
    department:document.department,
    actor,
    at:now
  });
  return { document, duplicate:false };
};

const indexDraftDocument = (state, document, actor) => {
  if (document.parser_status !== "parsed" || !String(document.raw_text || "").trim()) return document;
  const indexed = knowledgeIntakeContext.getStore()
    ? {indexed_at:nowIso(),index_mode:"transactional_draft",embedding_model:null,chunk_count:Math.ceil(document.raw_text.length/900)}
    : indexRuntimeKnowledgeDocument(document);
  const now = indexed.indexed_at || nowIso();
  Object.assign(document, {
    status:"draft",
    knowledge_base_status:"internal_only",
    knowledge_record_id:document.knowledge_record_id || `krec_${randomUUID()}`,
    retrieval_index_status:"indexed",
    retrieval_index_mode:indexed.index_mode,
    embedding_model:indexed.embedding_model,
    indexed_chunk_count:indexed.chunk_count,
    indexed_at:now,
    graph_build_status:"not_requested",
    graph_build_reason:"内部草稿不进入对客图谱；正式发布须绑定评测、媒体与索引版本。",
    parse_summary:`已完成受控解析并建立 ${indexed.chunk_count} 个内部检索块；解析预览可定位 ${document.parse_preview?.length || 0} 个源段，尚未对客发布。`,
    updated_at:now
  });
  appendEvent(state, {
    id:`kievent_${randomUUID()}`,
    tenant_id:document.tenant_id,
    type:"knowledge_intake.internal_indexed",
    document_id:document.id,
    department:document.department,
    actor,
    index_mode:indexed.index_mode,
    chunk_count:indexed.chunk_count,
    at:now
  });
  return document;
};

const quarantineDraftDocument = (state, document, actor) => {
  const removed = knowledgeIntakeContext.getStore() ? 0 : removeRuntimeKnowledgeDocument(document).removed;
  document.status = "parsing_pending";
  document.parser_status = "needs_attention";
  document.retrieval_index_status = "awaiting_correction";
  document.retrieval_index_mode = null;
  document.indexed_chunk_count = 0;
  document.indexed_at = null;
  document.knowledge_record_id = null;
  document.graph_build_status = "not_requested";
  document.graph_build_reason = "解析质量待处理；修正前不建立内部或对客检索。";
  document.parse_summary = `检测到 ${document.parse_quality?.issues?.length || 0} 项解析质量问题，已标为待处理；${removed ? "已移除旧的内部检索块。" : "尚未建立内部检索块。"}`;
  appendEvent(state, { id:`kievent_${randomUUID()}`, tenant_id:document.tenant_id, type:"knowledge_intake.parse_quarantined", document_id:document.id,
    department:document.department, actor, issue_codes:(document.parse_quality?.issues || []).map((item) => item.code), at:nowIso() });
  return document;
};

// Reads never publish, reindex or mutate old drafts. Legacy automatically
// indexed records are treated as internal by both this view and the index.

function createKnowledgeIntakeDocumentImpl(payload = {}) {
  const tenantId = normalizeTenantId(payload.tenant_id);
  const actor = assertActor(payload.actor, "知识录入");
  const idempotencyKey = assertIdempotency(payload.idempotency_key, "知识录入");
  const normalized = normalizeMetadata(payload);
  const rawText = cleanLines(payload.text_content);
  if (normalized.source_kind !== "text") {
    throw invalid("KNOWLEDGE_RAW_UPLOAD_REQUIRED", "PDF、DOCX和图片必须先通过原始素材上传通道隔离保存");
  }
  if (rawText.length < 20) throw invalid("KNOWLEDGE_TEXT_TOO_SHORT", "资料正文至少需要20个字符");
  if (Buffer.byteLength(rawText, "utf8") > sourceProfiles.get(normalized.extension).maxBytes) {
    throw invalid("KNOWLEDGE_TEXT_TOO_LARGE", "单次文本资料不能超过256KB");
  }
  assertDepartmentAccess(normalized.department, payload.permitted_departments);
  const payloadHash = sha256(JSON.stringify({ ...normalized, raw_text:sha256(rawText) }));
  const state = stateWithCollections();
  const replay = state.documents.find((item) => item.tenant_id === tenantId && item.create_idempotency_key === idempotencyKey);
  if (replay) {
    if (replay.create_payload_hash !== payloadHash) throw conflict("KNOWLEDGE_INTAKE_IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同资料");
    return { document:publicDocument(replay), replayed:true };
  }
  const created = createDocument({
    state, tenantId, actor, normalized, rawText, idempotencyKey,
    parserStatus:"parsed", parseSummary:"已完成受控文本解析，正在建立检索索引。"
  });
  if (created.duplicate) return { document:publicDocument(created.document), replayed:true, duplicate:true };
  if (created.document.parser_status === "needs_attention") quarantineDraftDocument(state, created.document, actor);
  else indexDraftDocument(state, created.document, actor);
  created.document.create_payload_hash = payloadHash;
  saveState(state);
  return { document:publicDocument(created.document), replayed:false, duplicate:false };
}

function prepareKnowledgeIntakeAssetImpl(payload = {}) {
  const tenantId = normalizeTenantId(payload.tenant_id);
  const actor = assertActor(payload.actor, "原始素材上传");
  const idempotencyKey = assertIdempotency(payload.idempotency_key, "原始素材上传");
  const normalized = normalizeMetadata(payload);
  const profile = sourceProfiles.get(normalized.extension);
  const mime = assertMime(profile, payload.mime);
  const expectedSize = Number(payload.size);
  if (!Number.isInteger(expectedSize) || expectedSize < 1 || expectedSize > profile.maxBytes) {
    const maxLabel = profile.maxBytes < 1024 * 1024
      ? `${profile.maxBytes / 1024}KB`
      : `${profile.maxBytes / 1024 / 1024}MB`;
    throw invalid("KNOWLEDGE_ASSET_SIZE_INVALID", `文件大小必须在1字节至${maxLabel}之间`);
  }
  assertDepartmentAccess(normalized.department, payload.permitted_departments);
  const payloadHash = sha256(JSON.stringify({ ...normalized, mime, expectedSize }));
  const state = stateWithCollections();
  const replay = state.assets.find((item) => item.tenant_id === tenantId && item.prepare_idempotency_key === idempotencyKey);
  if (replay) {
    if (replay.prepare_payload_hash !== payloadHash) throw conflict("KNOWLEDGE_ASSET_IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同原始素材");
    return { asset:publicAsset(replay, { includeUploadUrl:replay.status === "prepared" }), replayed:true };
  }
  const now = nowIso();
  const asset = {
    id:`kiasset_${randomUUID()}`,
    tenant_id:tenantId,
    ...normalized,
    mime,
    expected_size:expectedSize,
    size:null,
    content_sha256:null,
    status:"prepared",
    parser_status:"awaiting_upload",
    storage_path:null,
    created_by:actor,
    prepare_idempotency_key:idempotencyKey,
    prepare_payload_hash:payloadHash,
    created_at:now,
    updated_at:now
  };
  state.assets.unshift(asset);
  state.assets = state.assets.slice(0, 10_000);
  appendEvent(state, { id:`kievent_${randomUUID()}`, tenant_id:tenantId, type:"knowledge_intake.asset_prepared", asset_id:asset.id, department:asset.department, actor, at:now });
  saveState(state);
  return { asset:publicAsset(asset, { includeUploadUrl:true }), replayed:false };
}

async function saveKnowledgeIntakeAssetContentImpl({ tenant_id, asset_id, actor, permitted_departments, buffer, mime } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const author = assertActor(actor, "原始素材上传");
  const assetId = clean(asset_id, 80);
  const state = stateWithCollections();
  const asset = state.assets.find((item) => item.tenant_id === tenantId && item.id === assetId);
  if (!asset) return null;
  assertDepartmentAccess(asset.department, permitted_departments);
  if (asset.created_by !== author) throw forbidden("KNOWLEDGE_ASSET_OWNER_FORBIDDEN", "只有上传人可继续上传该原始素材");
  if (["uploaded", "completed"].includes(asset.status)) return publicAsset(asset);
  if (asset.status !== "prepared") throw conflict("KNOWLEDGE_ASSET_STATE_INVALID", "原始素材当前状态不允许继续上传");
  if (!Buffer.isBuffer(buffer) || buffer.length !== asset.expected_size) throw invalid("KNOWLEDGE_ASSET_SIZE_MISMATCH", "上传文件大小与申请信息不一致");
  if (String(mime || "").split(";")[0].trim().toLowerCase() !== asset.mime) throw invalid("KNOWLEDGE_ASSET_MIME_MISMATCH", "上传MIME与申请信息不一致");
  assertSourceSignature(asset, buffer);
  const root = assetRoot();
  const path = assetStoragePath(asset.id, asset.extension);
  if(knowledgeIntakeContext.getStore()) await persistIntakeAsset(asset.id,buffer);
  else { await mkdir(root, { recursive:true, mode:0o700 }); await writeFile(path, buffer, { mode:0o600, flag:"wx" }); }
  const now = nowIso();
  asset.status = "uploaded";
  asset.size = buffer.length;
  asset.content_sha256 = sha256(buffer);
  asset.storage_path = knowledgeIntakeContext.getStore() ? null : path;
  asset.parser_status = asset.source_kind === "text" ? "queued" : "pending_controlled_parse";
  asset.uploaded_at = now;
  asset.updated_at = now;
  appendEvent(state, { id:`kievent_${randomUUID()}`, tenant_id:tenantId, type:"knowledge_intake.asset_uploaded", asset_id:asset.id, department:asset.department, actor:author, at:now });
  saveState(state);
  return publicAsset(asset);
}

async function completeKnowledgeIntakeAssetImpl({ tenant_id, asset_id, actor, idempotency_key, permitted_departments } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const author = assertActor(actor, "原始素材入库");
  const key = assertIdempotency(idempotency_key, "原始素材入库");
  const assetId = clean(asset_id, 80);
  const state = stateWithCollections();
  const asset = state.assets.find((item) => item.tenant_id === tenantId && item.id === assetId);
  if (!asset) return null;
  assertDepartmentAccess(asset.department, permitted_departments);
  if (asset.created_by !== author) throw forbidden("KNOWLEDGE_ASSET_OWNER_FORBIDDEN", "只有上传人可完成该原始素材入库");
  if (asset.complete_idempotency_key === key && asset.document_id) {
    const replay = state.documents.find((item) => item.id === asset.document_id);
    return replay ? { document:publicDocument(replay), replayed:true, duplicate:false } : null;
  }
  if (asset.status !== "uploaded") throw conflict("KNOWLEDGE_ASSET_STATE_INVALID", "原始素材尚未上传完成或已入库");
  const storedBuffer=knowledgeIntakeContext.getStore()?await loadIntakeAsset(asset.id):null;
  const info = knowledgeIntakeContext.getStore() ? (storedBuffer?{isFile:()=>true,size:storedBuffer.length}:null) : await stat(asset.storage_path || "").catch(() => null);
  if (!info || !info.isFile() || info.size !== asset.expected_size) throw conflict("KNOWLEDGE_ASSET_STORAGE_INVALID", "服务端原始素材校验失败");
  let rawText = "";
  let parserStatus = "pending_controlled_parse";
  let status = "parsing_pending";
  let parseSummary = "原始文件已隔离保存，已进入受控解析队列；解析完成后将自动建立检索索引。";
  if (asset.source_kind === "text") {
    rawText = cleanLines(storedBuffer?storedBuffer.toString("utf8"):await readFile(asset.storage_path, "utf8"));
    if (rawText.length < 20) throw invalid("KNOWLEDGE_TEXT_TOO_SHORT", "资料正文至少需要20个字符");
    parserStatus = "parsed";
    status = "draft";
    parseSummary = "已完成受控文本解析，正在建立检索索引。";
  }
  const created = createDocument({
    state, tenantId, actor:author, normalized:normalizeMetadata(asset), rawText, asset, idempotencyKey:key,
    parserStatus, parseSummary, status
  });
  if (!created.duplicate) {
    if (created.document.parser_status === "needs_attention") quarantineDraftDocument(state, created.document, author);
    else indexDraftDocument(state, created.document, author);
  }
  asset.status = "completed";
  asset.document_id = created.document.id;
  asset.complete_idempotency_key = key;
  asset.parser_status = parserStatus;
  asset.updated_at = nowIso();
  saveState(state);
  return { document:publicDocument(created.document), replayed:false, duplicate:created.duplicate };
}

function listKnowledgeIntakeDocumentsImpl({
  tenant_id,
  permitted_departments,
  department = "",
  status = "",
  content_type = "",
  public_scope = "",
  q = "",
  valid_on = "",
  limit = 100
} = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const requestedDepartment = clean(department, 80);
  if (requestedDepartment) assertDepartmentAccess(requestedDepartment, permitted_departments);
  const requestedContentType = clean(content_type, 40);
  const requestedPublicScope = clean(public_scope, 40);
  const query = clean(q, 120).toLocaleLowerCase("zh-CN");
  const validOn = valid_on ? Date.parse(valid_on) : null;
  if (valid_on && !Number.isFinite(validOn)) throw invalid("KNOWLEDGE_VALID_ON_INVALID", "有效期筛选日期无效");
  const max = Math.min(500, Math.max(1, Number(limit) || 100));
  const state = stateWithCollections();
  return state.documents
    .filter((item) => item.tenant_id === tenantId
      && (!requestedDepartment || item.department === requestedDepartment)
      && (!status || (item.status === "indexed" ? "draft" : item.status) === status)
      && (!requestedContentType || item.content_type === requestedContentType)
      && (!requestedPublicScope || item.public_scope === requestedPublicScope)
      && (!query || [item.title, item.source_filename, item.source_reference, ...(item.tags || [])]
        .join(" ").toLocaleLowerCase("zh-CN").includes(query))
      && (!Number.isFinite(validOn) || (Date.parse(item.effective_at) <= validOn && Date.parse(item.expires_at) >= validOn))
      && canAccessDepartment(item.department, permitted_departments))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
    .slice(0, max)
    .map(publicDocument);
}

function getKnowledgeIntakeDocumentImpl({ tenant_id, document_id, permitted_departments } = {}) {
  const current = stateWithCollections().documents.find((item) => item.tenant_id === normalizeTenantId(tenant_id) && item.id === clean(document_id, 80));
  if (!current) return null;
  assertDepartmentAccess(current.department, permitted_departments);
  return detailDocument(current);
}

// This synchronous store has one writer per process. Version checks protect
// stale browser edits; cross-process transactional writes require PostgreSQL.
function mutateDocument(payload, action, mutate) {
  const tenantId = normalizeTenantId(payload.tenant_id);
  const author = assertActor(payload.actor, "资料维护");
  const key = assertIdempotency(payload.idempotency_key, "资料维护");
  const state = clone(stateWithCollections());
  const current = state.documents.find((item) => item.tenant_id === tenantId && item.id === clean(payload.document_id, 80));
  if (!current) return null;
  assertDepartmentAccess(current.department, payload.permitted_departments);
  const { idempotency_key:ignoredKey, permitted_departments:ignoredScope, ...intent } = payload;
  const payloadHash = sha256(JSON.stringify(canonical({ action, ...intent })));
  const replay = (current.mutations || []).find((item) => item.key === key);
  if (replay) {
    if (replay.payload_hash !== payloadHash) throw conflict("KNOWLEDGE_INTAKE_IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同资料操作");
    return { document:clone(replay.result), replayed:true };
  }
  if (current.parser_status !== "parsed" && action !== "draft_updated") throw conflict("KNOWLEDGE_INTAKE_PARSE_PENDING", "请先完成受控解析或人工校订正文");
  if (!Number.isInteger(payload.expected_version) || payload.expected_version !== current.version) {
    throw conflict("KNOWLEDGE_VERSION_CONFLICT", "资料版本已变化，请比较最新版本后重试", [{
      field:"expected_version",
      message:`资料当前已更新为 v${current.version}，请比较后重试`,
      expected_version:payload.expected_version,
      current_version:current.version
    }]);
  }
  const now = nowIso();
  mutate(current, { state, author, now });
  current.updated_at = now;
  const result = publicDocument(current);
  current.mutations = [...(current.mutations || []), { key, payload_hash:payloadHash, result }].slice(-100);
  appendEvent(state, { id:`kievent_${randomUUID()}`, tenant_id:tenantId, type:`knowledge_intake.${action}`, document_id:current.id,
    department:current.department, actor:author, version:current.version, content_hash:current.content_hash,
    ...(action === "confirmation_recorded" ? { confirmation:clone(current.hospital_confirmation) } : {}), at:now });
  saveState(state);
  return { document:result, replayed:false };
}

function updateKnowledgeIntakeDocumentImpl(payload = {}) {
  return mutateDocument(payload, "draft_updated", (current, { state, author, now }) => {
    const editable = ["department", "content_type", "owner", "tags", "effective_at", "expires_at", "source_reference", "applicable_campuses", "public_scope", "customer_facing_candidate"];
    const metadata = normalizeMetadata({ ...current, ...Object.fromEntries(editable.filter((key) => Object.hasOwn(payload, key)).map((key) => [key, payload[key]])) });
    assertDepartmentAccess(metadata.department, payload.permitted_departments);
    const text = cleanLines(payload.text_content ?? current.raw_text);
    if (text.length < 20) throw invalid("KNOWLEDGE_TEXT_TOO_SHORT", "校订正文至少需要20个字符");
    if (Buffer.byteLength(text, "utf8") > 256 * 1024) throw invalid("KNOWLEDGE_TEXT_TOO_LARGE", "校订正文不能超过256KB");
    const title = clean(payload.title ?? current.title, 120);
    if (!title) throw invalid("KNOWLEDGE_TITLE_REQUIRED", "请填写资料标题");
    const parsed = parseAssessmentFor(text, current.source_filename);
    const needsAttention = parsed.quality.status === "needs_attention";
    const { versions:ignoredVersions, mutations:ignoredMutations, ...snapshot } = current;
    current.versions = [...(current.versions || []), clone(snapshot)];
    Object.assign(current, metadata, { title, raw_text:text, excerpt:clean(text, 500), content_hash:sha256(text), parse_preview:parsed.preview, parse_quality:parsed.quality, version:current.version + 1,
      parser_status:needsAttention ? "needs_attention" : "parsed", status:needsAttention ? "parsing_pending" : "draft", hospital_confirmation:null, submitted_by:null, submitted_at:null, submit_idempotency_key:null,
      updated_by:author, updated_at:now });
    if (needsAttention) quarantineDraftDocument(state, current, author);
    else indexDraftDocument(state, current, author);
  });
}

function recordKnowledgeIntakeConfirmationImpl(payload = {}) {
  return mutateDocument(payload, "confirmation_recorded", (current, { author, now }) => {
    const reference = clean(payload.reference, 500);
    const confirmedBy = clean(payload.confirmed_by, 120);
    const confirmedAt = Date.parse(payload.confirmed_at);
    const expiresAt = Date.parse(payload.confirmation_expires_at);
    if (!reference || !confirmedBy || !Number.isFinite(confirmedAt) || confirmedAt > Date.now()
      || !(expiresAt > Date.now() && expiresAt > confirmedAt)) throw invalid("KNOWLEDGE_CONFIRMATION_INVALID", "请填写院方确认人、可追溯凭据、已发生的确认时间和有效的确认截止时间");
    current.hospital_confirmation = { reference, confirmed_by:confirmedBy, confirmed_at:new Date(confirmedAt).toISOString(),
      expires_at:new Date(expiresAt).toISOString(), recorded_by:author, recorded_at:now, version:current.version, digest:confirmationDigest(current) };
    // Changing confirmation invalidates any prior candidate preparation.
    current.status = "draft";
    current.submitted_by = null;
    current.submitted_at = null;
  });
}

function submitKnowledgeIntakeDocumentImpl(payload = {}) {
  return mutateDocument(payload, "candidate_prepared", (current, { author, now }) => {
    const readiness = knowledgeIntakeReadiness(current);
    if (!readiness.ready) throw invalid("KNOWLEDGE_PUBLICATION_PREREQUISITES_MISSING", "资料尚不满足候选准备条件", readiness.missing.map((field) => ({ field })));
    current.status = "release_candidate";
    current.submitted_by = author;
    current.submitted_at = now;
  });
}

export function reviewKnowledgeIntakeDocument({ tenant_id, document_id, stage, decision, comment = "", actor, idempotency_key, permitted_departments } = {}) {
  const error = new Error("资料使用院方线下确认依据，不提供线上逐级审核流转");
  error.code = "KNOWLEDGE_REVIEW_WORKFLOW_DISABLED";
  error.status = 410;
  throw error;
}

function getKnowledgeIntakeStoreStatusImpl(tenantId) {
  const tenant = normalizeTenantId(tenantId);
  const state = stateWithCollections();
  const documents = state.documents.filter((item) => item.tenant_id === tenant);
  return {
    ...store.status(),
    tenant_id:tenant,
    storage_mode:knowledgeIntakeContext.getStore()?"postgres_encrypted":"local_protected_disk",
    documents:documents.length,
    parsing_pending:documents.filter((item) => item.status === "parsing_pending").length,
    indexed:documents.filter((item) => item.retrieval_index_status === "indexed").length,
    published:0,
    drafts:documents.filter((item) => ["draft", "indexed"].includes(item.status)).length,
    candidates:documents.filter((item) => item.status === "release_candidate").length,
    vector_index:runtimeKnowledgeIndexStatus(tenant)
  };
}

export const createKnowledgeIntakeDocument = payload => withKnowledgeIntake(payload, createKnowledgeIntakeDocumentImpl);

export const prepareKnowledgeIntakeAsset = payload => withKnowledgeIntake(payload, prepareKnowledgeIntakeAssetImpl);

export const saveKnowledgeIntakeAssetContent = payload => withKnowledgeIntake(payload, saveKnowledgeIntakeAssetContentImpl);

export const completeKnowledgeIntakeAsset = payload => withKnowledgeIntake(payload, completeKnowledgeIntakeAssetImpl);

export const listKnowledgeIntakeDocuments = payload => withKnowledgeIntake(payload, listKnowledgeIntakeDocumentsImpl);

export const getKnowledgeIntakeDocument = payload => withKnowledgeIntake(payload, getKnowledgeIntakeDocumentImpl);

export const updateKnowledgeIntakeDocument = payload => withKnowledgeIntake(payload, updateKnowledgeIntakeDocumentImpl);

export const recordKnowledgeIntakeConfirmation = payload => withKnowledgeIntake(payload, recordKnowledgeIntakeConfirmationImpl);

export const submitKnowledgeIntakeDocument = payload => withKnowledgeIntake(payload, submitKnowledgeIntakeDocumentImpl);

export const getKnowledgeIntakeStoreStatus = payload => withKnowledgeIntake(payload, getKnowledgeIntakeStoreStatusImpl);
