import { publicationRequestContext } from "./knowledge-publication.mjs";
import { existsSync, readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorProjectGroupFor, extractNamedDoctorName, isDoctorRecommendationIntent } from "./acquisition-intent.mjs";
import { getKnowledgeAdmissionStatus } from "./knowledge-release-policy.mjs";
import { getKnowledgeIngestionAdmission } from "./knowledge-ingestion-admission.mjs";
import { runtimeKnowledgeIndexStatus, searchRuntimeKnowledge } from "./runtime-knowledge-index.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";

export { extractNamedDoctorName, isDoctorRecommendationIntent } from "./acquisition-intent.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_EXTERNAL_ROOT = join(projectRoot, "..", "一期项目文件", "华美智能体知识库_v1");
const BUNDLED_ROOT = join(projectRoot, "knowledge", "huamei-v1");
const BUNDLED_PUBLIC_SAFE_CATALOG = join(
  projectRoot, "graphrag-service", "graphrag_project", "input", "huamei-public-safe.jsonl"
);
const PUBLIC_RECORD_TYPES = new Set(["directory_overview", "image_ocr", "pdf_text"]);
const PUBLIC_BLOCKED_PATH = /(?:前后对比|聊天记录|客户画像相关资料|案例库|术前术后)/i;
const PRICE_OR_POLICY = /(?:价格|报价|多少钱|费用|活动|优惠|政策|折扣|赠品|套餐|储值|权益|有效期)/i;
const DOCTOR_INTENT = /(?:医生|院长|专家|资质|执业|擅长|排班)/i;
const MEMBER_INTENT = /(?:会员|荟员|储值|权益|积分)/i;
const DIRECTORY_INTENT = /(?:目录|哪些项目|哪些资料|服务范围|有什么资料)/i;
const INTERNAL_DATA_INTENT = /(?:汇总|客户数|消费|营业额|回访|划扣|运营数据|趋势|排名)/i;
const PHONE_OR_ID = /(?:1\d{10}|\b\d{15,18}[0-9Xx]\b)/;
const PRICE_LINE = /(?:￥|¥|元|价格|报价|收费|一口价|储值价|折|赠|活动|套餐|限时|到手价|\b\d{3,6}\b)/i;
const PROMOTIONAL_LANGUAGE = /(?:永久|绝对安全|保证效果|保证安全|百分百|100%|无痛|零风险|最低价|立竿见影|即刻见效|快速见效)/gi;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STOP_TERMS = new Set([
  "我想", "想了解", "了解一下", "下面", "哪些", "项目", "资料", "相关", "清楚", "咨询", "方向",
  "可以", "怎么", "什么", "一下", "有没有", "医院", "华美", "给我", "先给", "这个", "那个"
]);

let cache = null;
const retrievalCache = new Map();
const bindingCache = new Map();
const MAX_RETRIEVAL_CACHE = Math.max(100, Number(process.env.HUAMEI_KNOWLEDGE_RETRIEVAL_CACHE_SIZE || 2_000));
const rememberRetrieval = (key, value) => {
  retrievalCache.set(key, value);
  if (retrievalCache.size > MAX_RETRIEVAL_CACHE) retrievalCache.delete(retrievalCache.keys().next().value);
  return value;
};

const normalize = (value = "") => String(value)
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "");

const unique = (values) => [...new Set(values.filter(Boolean))];

const knowledgeIntegrityError = (code, message = code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const canonicalJsonBytes = (value) => Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const equalSha256 = (left, right) => {
  const normalizedLeft = String(left || "").trim().toLowerCase();
  const normalizedRight = String(right || "").trim().toLowerCase();
  return SHA256_PATTERN.test(normalizedLeft)
    && SHA256_PATTERN.test(normalizedRight)
    && timingSafeEqual(Buffer.from(normalizedLeft, "hex"), Buffer.from(normalizedRight, "hex"));
};

const requiredRecordText = (record, field) => {
  if (typeof record?.[field] !== "string" || !record[field].trim()) {
    throw knowledgeIntegrityError(`KNOWLEDGE_RECORD_${field.toUpperCase()}_MISSING`);
  }
  return record[field].trim();
};

/**
 * Exact JavaScript counterpart of GraphRAG's canonical_record_material.
 * Every customer-visible fact and provenance field is part of the digest.
 */
export function canonicalKnowledgeRecordMaterial(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw knowledgeIntegrityError("KNOWLEDGE_RECORD_INVALID");
  }
  if (!Array.isArray(record.tags) || !record.tags.every((item) => typeof item === "string")) {
    throw knowledgeIntegrityError("KNOWLEDGE_RECORD_TAGS_INVALID");
  }
  const sensitivity = requiredRecordText(record, "sensitivity").toLowerCase();
  if (!["public", "internal"].includes(sensitivity)) {
    throw knowledgeIntegrityError("KNOWLEDGE_RECORD_SENSITIVITY_INVALID");
  }
  return {
    record_id:requiredRecordText(record, "record_id"),
    record_type:requiredRecordText(record, "record_type"),
    title:requiredRecordText(record, "title"),
    content:requiredRecordText(record, "content"),
    tags:[...record.tags],
    source_relative_path:requiredRecordText(record, "source_relative_path"),
    sensitivity,
    verification_note:requiredRecordText(record, "verification_note")
  };
}

export function knowledgeRecordContentSha256(record) {
  const computed = sha256(canonicalJsonBytes(canonicalKnowledgeRecordMaterial(record)));
  if (Object.hasOwn(record, "record_content_sha256")) {
    const declared = String(record.record_content_sha256 || "").trim().toLowerCase();
    if (!SHA256_PATTERN.test(declared)) {
      throw knowledgeIntegrityError("KNOWLEDGE_RECORD_HASH_INVALID");
    }
    if (!equalSha256(declared, computed)) {
      throw knowledgeIntegrityError("KNOWLEDGE_RECORD_HASH_MISMATCH");
    }
  }
  return computed;
}

export function officialKnowledgeRecordText(record) {
  const material = canonicalKnowledgeRecordMaterial(record);
  return [
    `标题：${material.title}`,
    `来源：${material.source_relative_path}`,
    `标签：${material.tags.join("、")}`,
    material.content,
    `核验说明：${material.verification_note}`
  ].join("\n");
}

const canonicalRecordList = (records) => {
  const byId = new Map();
  for (const record of records) {
    const recordId = requiredRecordText(record, "record_id");
    const contentSha = String(record.record_content_sha256 || "").trim().toLowerCase();
    if (!SHA256_PATTERN.test(contentSha)) throw knowledgeIntegrityError("KNOWLEDGE_RECORD_HASH_INVALID");
    if (byId.has(recordId)) throw knowledgeIntegrityError("KNOWLEDGE_DUPLICATE_RECORD_ID");
    byId.set(recordId, contentSha);
  }
  return [...byId]
    .sort(([left], [right]) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")))
    .map(([record_id, record_content_sha256]) => ({ record_id, record_content_sha256 }));
};

const recordListSha256 = (records) => sha256(canonicalJsonBytes(canonicalRecordList(records)));

const resolveConfiguredRoot = () => {
  const configured = String(process.env.HUAMEI_KNOWLEDGE_ROOT || "").trim();
  if (!configured) return null;
  return isAbsolute(configured) ? configured : resolve(projectRoot, configured);
};

const candidateRoots = () => unique([resolveConfiguredRoot(), BUNDLED_ROOT, DEFAULT_EXTERNAL_ROOT]);

const isKnowledgeRoot = (root) => root
  && existsSync(join(root, "manifest.json"))
  && existsSync(join(root, "rag", "knowledge_units.jsonl"));

const findKnowledgeRoot = (preferredRoot = null) => {
  const configured = preferredRoot ? resolve(String(preferredRoot)) : null;
  return unique([configured, ...candidateRoots()]).find(isKnowledgeRoot) || null;
};

const resolveConfiguredCatalog = () => {
  const configured = String(process.env.HUAMEI_KNOWLEDGE_PUBLIC_SAFE_CATALOG || "").trim();
  if (!configured) return null;
  return isAbsolute(configured) ? configured : resolve(projectRoot, configured);
};

const findPublicSafeCatalog = (root, preferredCatalog = null) => {
  const developerPackage = [BUNDLED_ROOT, DEFAULT_EXTERNAL_ROOT]
    .some((candidate) => resolve(root) === resolve(candidate));
  return unique([
    preferredCatalog ? resolve(String(preferredCatalog)) : null,
    resolveConfiguredCatalog(),
    join(root, "rag", "huamei-public-safe.jsonl"),
    join(root, "huamei-public-safe.jsonl"),
    developerPackage ? BUNDLED_PUBLIC_SAFE_CATALOG : null
  ]).find((path) => path && existsSync(path)) || null;
};

const resolveConfiguredPublicMaterialsRoot = () => {
  const configured = String(process.env.HUAMEI_PUBLIC_MATERIALS_PACKAGE_ROOT || "").trim();
  if (!configured) return null;
  return isAbsolute(configured) ? configured : resolve(projectRoot, configured);
};

const isPublicMaterialsRoot = (root) => root
  && existsSync(join(root, "manifest.json"))
  && existsSync(join(root, "assets.jsonl"))
  && existsSync(join(root, "rag", "knowledge_units.jsonl"));

const findPublicMaterialsRoot = (knowledgeRoot, preferredRoot = null) => unique([
  preferredRoot ? resolve(String(preferredRoot)) : null,
  resolveConfiguredPublicMaterialsRoot(),
  join(knowledgeRoot, "public-materials-v1")
]).find(isPublicMaterialsRoot) || null;

// Public materials are an independently versioned extension package.  They are
// retrievable in preview only; a production release must still explicitly add
// them to the signed public-safe catalog and release record list.
const loadPublicMaterialsPackage = (knowledgeRoot, preferredRoot = null) => {
  const root = findPublicMaterialsRoot(knowledgeRoot, preferredRoot);
  if (!root) return { loaded:false, root:null, manifest:null, records:[], error:null };
  try {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    if (manifest?.review_status !== "approved" || typeof manifest.source_review_attestation !== "string" || !manifest.source_review_attestation.trim()) {
      throw knowledgeIntegrityError("PUBLIC_MATERIALS_REVIEW_ATTESTATION_MISSING");
    }
    const { records } = loadJsonLines(readFileSync(join(root, "rag", "knowledge_units.jsonl"), "utf8"), {
      requireDeclaredHash:true,
      requireOfficialText:true
    });
    if (records.some((record) => {
      const sourcePath = String(record.source_relative_path || "");
      return sourcePath !== "公开资料" && !sourcePath.startsWith("公开资料/");
    })) {
      throw knowledgeIntegrityError("PUBLIC_MATERIALS_SOURCE_PATH_INVALID");
    }
    return {
      loaded:true,
      root,
      manifest,
      records:records.filter(publicEligible),
      total_records:records.length,
      error:null
    };
  } catch (error) {
    return { loaded:false, root, manifest:null, records:[], error:error.code || "PUBLIC_MATERIALS_LOAD_FAILED" };
  }
};

const queryTerms = (message = "") => {
  const text = String(message).normalize("NFKC").toLowerCase();
  const terms = [];
  for (const match of text.matchAll(/[“”"']([^“”"']{2,40})[“”"']/g)) terms.push(match[1]);
  const segmenter = new Intl.Segmenter("zh-CN", { granularity:"word" });
  for (const segment of segmenter.segment(text)) {
    const term = segment.segment.trim();
    if (segment.isWordLike && normalize(term).length >= 2) terms.push(term);
  }
  for (const span of text.match(/[\p{Script=Han}]{2,20}|[a-z0-9][a-z0-9._-]{1,30}/gu) || []) {
    terms.push(span);
    if (/^[\p{Script=Han}]+$/u.test(span)) {
      for (const size of [2, 3, 4, 5]) {
        if (span.length <= size) continue;
        for (let index = 0; index <= span.length - size; index += 1) terms.push(span.slice(index, index + size));
      }
    }
  }
  return unique(terms.map(normalize)).filter((term) => term.length >= 2 && !STOP_TERMS.has(term)).slice(0, 80);
};

const QUERY_CORE_PREFIX = /^(?:我想了解一下|我想了解|想了解|了解一下|介绍一下|介绍|明星产品|项目介绍|医生介绍|帮我|请问|想问一下|想问|想咨询)/u;
const QUERY_CORE_SUFFIX = /(?:多少钱|价格|费用|报价|收费|预算|政策|优惠|活动|套餐|权益|是什么原理|的一般流程是什么|擅长什么|专业方向是什么|专业方向|是什么|一般流程|恢复期一般多久|恢复期|多久|怎么选|有哪些内容|有哪些|有什么区别|这个项目|院长)$/u;
const queryCoreText = (message = "") => {
  let core = String(message || "").normalize("NFKC").trim();
  for (let index = 0; index < 2; index += 1) {
    core = core
      .replace(QUERY_CORE_PREFIX, "")
      .replace(QUERY_CORE_SUFFIX, "")
      .replace(/^(?:一下|这个|那个)/u, "")
      .trim();
  }
  return core;
};
const queryCoreTerms = (message = "") => {
  const core = queryCoreText(message);
  if (!core) return [];
  const segmenter = new Intl.Segmenter("zh-CN", { granularity:"word" });
  const segmented = [...segmenter.segment(core)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => normalize(segment.segment))
    .filter((term) => term.length >= 2 && !STOP_TERMS.has(term));
  return unique(segmented.length ? segmented : queryTerms(core)).slice(0, 20);
};
const shouldGateWeakEvidence = (message = "", coreTerms = []) => {
  const text = String(message || "").normalize("NFKC").trim();
  if (text.length <= 4 || !coreTerms.length) return false;
  if (/(?:区别|对比|怎么选)/u.test(text)) return false;
  if (/(?:和|与|、)/u.test(text) && coreTerms.length >= 2) return false;
  return true;
};
const hasMeaningfulCoreEvidence = (record, coreTerms = [], coreText = "") => {
  if (!coreTerms.length) return true;
  const searchable = normalize(`${record.title || ""} ${record.source_relative_path || ""} ${(record.tags || []).join(" ")} ${record.content || ""}`);
  const leadingAnchor = normalize(coreText).slice(0, 3);
  if (leadingAnchor.length >= 3 && !searchable.includes(leadingAnchor)) return false;
  const matched = coreTerms.filter((term) => searchable.includes(term)).length;
  return matched / coreTerms.length >= 0.75;
};

const publicEligible = (record) => PUBLIC_RECORD_TYPES.has(record.record_type)
  && record.sensitivity !== "restricted"
  && !PUBLIC_BLOCKED_PATH.test(record.source_relative_path || "");

const approvedRecordListChecksumForState = (state, approvedRecordIds = []) => {
  if (!state?.loaded || !(state.recordHashById instanceof Map)) {
    throw knowledgeIntegrityError("KNOWLEDGE_PACKAGE_NOT_LOADED");
  }
  const normalizedIds = approvedRecordIds.map((item) => String(item || "").trim());
  if (!normalizedIds.length || normalizedIds.some((item) => !item)) {
    throw knowledgeIntegrityError("KNOWLEDGE_APPROVED_RECORD_LIST_EMPTY");
  }
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw knowledgeIntegrityError("KNOWLEDGE_APPROVED_RECORD_LIST_DUPLICATE");
  }
  const records = normalizedIds.map((recordId) => {
    const contentSha = state.recordHashById.get(recordId);
    if (!contentSha) throw knowledgeIntegrityError("KNOWLEDGE_APPROVED_RECORD_NOT_FOUND");
    return { record_id:recordId, record_content_sha256:contentSha };
  });
  return recordListSha256(records);
};

export function computeApprovedKnowledgeRecordListChecksum(approvedRecordIds = [], options = {}) {
  return approvedRecordListChecksumForState(options.state || loadHuameiKnowledge(), approvedRecordIds);
}

// 发布侧需要为“某个批准清单”算出可绑定的校验和：撤回或收窄发布范围时校验和
// 随之变化，这里把同一套计算对外开放，避免只能绑定全量清单。
export const computeApprovedRecordListChecksum = (approvedRecordIds = [], options = {}) =>
  approvedRecordListChecksumForState(options.state || loadHuameiKnowledge(), approvedRecordIds);

export function getHuameiKnowledgeBindingStatus(tenantId, options = {}) {
  const state = options.state || loadHuameiKnowledge();
  const tenant = normalizeTenantId(tenantId);
  const publication=publicationRequestContext.getStore();
  if(publication?.tenantId===tenant && publication.revision>0) {
    const pkg=publication.package;
    return {mode:"enforce",ready:Boolean(pkg),error:pkg?null:"KNOWLEDGE_ACTIVE_PUBLICATION_UNAVAILABLE",
      active_release:pkg?{id:pkg.id,package_checksum:pkg.checksum,approved_record_ids:pkg.text_index.chunks.map(c=>c.record_id)}:null,
      binding:{valid:Boolean(pkg),mode:"enforce",anchored_to_active_release:Boolean(pkg),release_id:pkg?.id||null}};
  }
  const admission = getKnowledgeAdmissionStatus(tenant, state.version || "");
  if (!state.loaded) {
    return {
      ...admission,
      ready:false,
      error:state.error || "KNOWLEDGE_PACKAGE_NOT_LOADED",
      binding:{ valid:false, error:state.error || "KNOWLEDGE_PACKAGE_NOT_LOADED" }
    };
  }
  if (admission.mode === "preview") {
    return {
      ...admission,
      ready:true,
      error:null,
      binding:{
        valid:true,
        mode:"preview",
        package_checksum:state.packageChecksum,
        record_list_checksum:state.allRecordListChecksum,
        anchored_to_active_release:false
      }
    };
  }
  const release = admission.active_release;
  const bindingKey = JSON.stringify([
    state.loadedAt, state.packageChecksum, state.allRecordListChecksum,
    tenant, release?.id || null, release?.package_checksum || null,
    release?.record_list_checksum || null, release?.approved_record_ids || []
  ]);
  const cachedBinding = bindingCache.get(bindingKey);
  if (cachedBinding) return cachedBinding;
  let error = null;
  let approvedRecordListChecksum = null;
  if (!release) {
    error = "KNOWLEDGE_ACTIVE_RELEASE_MISSING";
  } else if (!equalSha256(release.package_checksum, state.packageChecksum)) {
    error = "KNOWLEDGE_PACKAGE_CHECKSUM_MISMATCH";
  } else {
    try {
      approvedRecordListChecksum = approvedRecordListChecksumForState(state, release.approved_record_ids || []);
    } catch (failure) {
      error = failure.code || "KNOWLEDGE_APPROVED_RECORD_LIST_INVALID";
    }
    if (!error && !equalSha256(release.record_list_checksum, approvedRecordListChecksum)) {
      error = "KNOWLEDGE_RECORD_LIST_CHECKSUM_MISMATCH";
    }
  }
  const result = {
    ...admission,
    ready:!error,
    error,
    binding:{
      valid:!error,
      mode:"enforce",
      error,
      package_checksum:state.packageChecksum,
      record_list_checksum:approvedRecordListChecksum,
      anchored_to_active_release:!error,
      release_id:release?.id || null
    }
  };
  bindingCache.set(bindingKey, result);
  if (bindingCache.size > 1_000) bindingCache.delete(bindingCache.keys().next().value);
  return result;
}

const admittedPublicRecords = (state, tenantId) => {
  const tenant = normalizeTenantId(tenantId);
  const publication=publicationRequestContext.getStore();
  if(publication?.tenantId===tenant && publication.revision>0) return (publication.package?.text_index.chunks||[]).map((c,i)=>enrichRecord({...c,record_type:"published_document",source_relative_path:c.source_reference,sensitivity:"public"},i));
  const admission = getHuameiKnowledgeBindingStatus(tenant, { state });
  if (!admission.ready) return [];
  if (admission.mode === "preview") return [...state.publicRecords, ...state.publicMaterialRecords];
  const admittedIds = new Set(admission.active_release?.approved_record_ids || []);
  return state.publicRecords.filter((record) => admittedIds.has(record.record_id));
};

const enrichRecord = (record, sourceIndex) => ({
  ...record,
  sourceIndex,
  _title:normalize(record.title),
  _path:normalize(record.source_relative_path),
  _tags:normalize((record.tags || []).join(" ")),
  _content:normalize(record.content)
});

const loadJsonLines = (raw, options = {}) => {
  const records = [];
  const recordHashes = [];
  const lines = String(raw).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let source;
    try {
      source = JSON.parse(lines[index]);
    } catch {
      throw knowledgeIntegrityError("KNOWLEDGE_UNITS_INVALID_JSONL");
    }
    const declaredHashPresent = Object.hasOwn(source, "record_content_sha256");
    if (options.requireDeclaredHash === true && !declaredHashPresent) {
      throw knowledgeIntegrityError("KNOWLEDGE_RECORD_HASH_MISSING");
    }
    const computedHash = knowledgeRecordContentSha256(source);
    if (options.requireOfficialText === true) {
      if (typeof source.text !== "string" || !source.text) {
        throw knowledgeIntegrityError("KNOWLEDGE_RECORD_TEXT_MISSING");
      }
      if (source.text !== officialKnowledgeRecordText(source)) {
        throw knowledgeIntegrityError("KNOWLEDGE_RECORD_TEXT_MISMATCH");
      }
    }
    const record = enrichRecord({
      ...canonicalKnowledgeRecordMaterial(source),
      record_content_sha256:computedHash,
      record_hash_declared:declaredHashPresent
    }, records.length);
    records.push(record);
    recordHashes.push({ record_id:record.record_id, record_content_sha256:computedHash });
  }
  if (!records.length) throw knowledgeIntegrityError("KNOWLEDGE_UNITS_EMPTY");
  // This also rejects duplicate record IDs before any record can become retrievable.
  const canonicalRecords = canonicalRecordList(recordHashes);
  if (options.requirePublicEligible === true && records.some((record) => !publicEligible(record))) {
    throw knowledgeIntegrityError("KNOWLEDGE_PUBLIC_SAFE_CATALOG_CONTAINS_BLOCKED_RECORD");
  }
  return { records, canonicalRecords };
};

export function loadHuameiKnowledge(options = {}) {
  if (cache && options.force !== true) return cache;
  const root = findKnowledgeRoot(options.root);
  if (!root) {
    cache = {
      loaded:false,
      root:null,
      version:null,
      manifest:null,
      records:[],
      publicRecords:[],
      publicMaterialRecords:[],
      publicMaterials:null,
      canonicalRecords:[],
      recordHashById:new Map(),
      manifestSha256:null,
      knowledgeUnitsSha256:null,
      publicSafeCatalogSha256:null,
      publicSafeCatalogPath:null,
      packageChecksum:null,
      allRecordListChecksum:null,
      declaredRecordHashCount:0,
      error:"KNOWLEDGE_ROOT_NOT_FOUND"
    };
    return cache;
  }
  try {
    const publicSafeCatalogPath = findPublicSafeCatalog(root, options.publicSafeCatalog);
    if (!publicSafeCatalogPath) {
      throw knowledgeIntegrityError("KNOWLEDGE_PUBLIC_SAFE_CATALOG_NOT_FOUND");
    }
    const manifestBytes = readFileSync(join(root, "manifest.json"));
    const knowledgeUnitsBytes = readFileSync(join(root, "rag", "knowledge_units.jsonl"));
    const publicSafeCatalogBytes = readFileSync(publicSafeCatalogPath);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw knowledgeIntegrityError("KNOWLEDGE_MANIFEST_INVALID");
    }
    if (typeof manifest.version !== "string" || !manifest.version.trim()) {
      throw knowledgeIntegrityError("KNOWLEDGE_MANIFEST_VERSION_MISSING");
    }
    if (typeof manifest.package_name !== "string" || !manifest.package_name.trim()) {
      throw knowledgeIntegrityError("KNOWLEDGE_MANIFEST_PACKAGE_NAME_MISSING");
    }
    const { records } = loadJsonLines(knowledgeUnitsBytes.toString("utf8"));
    const { records:publicRecords, canonicalRecords } = loadJsonLines(
      publicSafeCatalogBytes.toString("utf8"),
      { requireDeclaredHash:true, requireOfficialText:true, requirePublicEligible:true }
    );
    if (manifest.knowledge_unit_count !== undefined
      && Number(manifest.knowledge_unit_count) !== records.length) {
      throw knowledgeIntegrityError("KNOWLEDGE_MANIFEST_RECORD_COUNT_MISMATCH");
    }
    const manifestSha256 = sha256(manifestBytes);
    const knowledgeUnitsSha256 = sha256(knowledgeUnitsBytes);
    // This exact immutable catalog is both the official GraphRAG input and the
    // Node customer-facing fallback package. Neither runtime derives or edits
    // fields after review.
    const publicSafeCatalogSha256 = sha256(publicSafeCatalogBytes);
    const packageChecksum = publicSafeCatalogSha256;
    const allRecordListChecksum = recordListSha256(canonicalRecords);
    const declaredUnitsSha = String(manifest.knowledge_units_sha256 || "").trim().toLowerCase();
    const declaredPackageSha = String(manifest.package_checksum || "").trim().toLowerCase();
    const declaredRecordListSha = String(manifest.record_list_checksum || manifest.approved_record_list_sha256 || "").trim().toLowerCase();
    if (declaredUnitsSha && !equalSha256(declaredUnitsSha, knowledgeUnitsSha256)) {
      throw knowledgeIntegrityError("KNOWLEDGE_UNITS_CHECKSUM_MISMATCH");
    }
    if (declaredPackageSha && !equalSha256(declaredPackageSha, packageChecksum)) {
      throw knowledgeIntegrityError("KNOWLEDGE_PACKAGE_CHECKSUM_MISMATCH");
    }
    if (declaredRecordListSha && !equalSha256(declaredRecordListSha, allRecordListChecksum)) {
      throw knowledgeIntegrityError("KNOWLEDGE_RECORD_LIST_CHECKSUM_MISMATCH");
    }
    const recordHashById = new Map(canonicalRecords.map((item) => [item.record_id, item.record_content_sha256]));
    const publicMaterials = loadPublicMaterialsPackage(root, options.publicMaterialsRoot);
    cache = {
      loaded:true,
      root,
      version:manifest.version.trim(),
      manifest,
      records,
      publicRecords,
      publicMaterialRecords:publicMaterials.records,
      publicMaterials,
      canonicalRecords,
      recordHashById,
      manifestSha256,
      knowledgeUnitsSha256,
      publicSafeCatalogSha256,
      publicSafeCatalogPath,
      packageChecksum,
      allRecordListChecksum,
      declaredRecordHashCount:publicRecords.filter((record) => record.record_hash_declared).length,
      loadedAt:new Date().toISOString(),
      error:null
    };
  } catch (error) {
    cache = {
      loaded:false,
      root,
      version:null,
      manifest:null,
      records:[],
      publicRecords:[],
      publicMaterialRecords:[],
      publicMaterials:null,
      canonicalRecords:[],
      recordHashById:new Map(),
      manifestSha256:null,
      knowledgeUnitsSha256:null,
      publicSafeCatalogSha256:null,
      publicSafeCatalogPath:null,
      packageChecksum:null,
      allRecordListChecksum:null,
      declaredRecordHashCount:0,
      error:error.code || "KNOWLEDGE_LOAD_FAILED"
    };
  }
  return cache;
}

const categoryBoost = (query, record) => {
  const combined = `${record._title} ${record._path} ${record._tags}`;
  let score = 0;
  if (PRICE_OR_POLICY.test(query) && /(?:价格|政策|优惠|套餐|权益|储值)/.test(combined)) score += 46;
  if (DOCTOR_INTENT.test(query) && /(?:医生|院长|专家)/.test(combined)) score += 46;
  if (MEMBER_INTENT.test(query) && /(?:会员|荟员|权益|储值)/.test(combined)) score += 42;
  if (DIRECTORY_INTENT.test(query) && record.record_type === "directory_overview") score += 34;
  if (INTERNAL_DATA_INTENT.test(query) && record.record_type === "deidentified_operating_aggregate") score += 34;
  if (!INTERNAL_DATA_INTENT.test(query) && record.record_type === "deidentified_operating_aggregate") score -= 20;
  return score;
};

const recordScore = (message, terms, record) => {
  const normalizedQuery = normalize(message);
  let score = categoryBoost(message, record);
  if (record.record_id && normalizedQuery.includes(normalize(record.record_id))) score += 300;
  if (record._path && normalizedQuery.includes(record._path)) score += 180;
  for (const term of terms) {
    if (record._title === term) score += 140;
    else if (record._title.includes(term)) score += 54 + Math.min(term.length, 12);
    if (record._path === term) score += 120;
    else if (record._path.includes(term)) score += 40 + Math.min(term.length, 10);
    if (record._tags.includes(term)) score += 34;
    if (record._content.includes(term)) score += Math.min(18, 4 + term.length);
  }
  if (normalizedQuery && record._title && normalizedQuery.includes(record._title)) score += 100;
  const specificity = Math.max(record._title.length, record._path.length);
  score += Math.min(specificity / 80, 4);
  if (record.record_type === "directory_overview") score -= Math.max(0, String(record.source_relative_path || "").split("/").length - 1) * 3;
  return score;
};

export function retrieveHuameiKnowledge(message, options = {}) {
  const state = loadHuameiKnowledge();
  const audience = options.audience === "internal" ? "internal" : "public";
  const pathPrefixes = Array.isArray(options.pathPrefixes) ? options.pathPrefixes.map((item) => String(item || "")).filter(Boolean) : [];
  const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
  const minimumScore = Number(options.minimumScore) || 16;
  const tenant = normalizeTenantId(options.tenantId);
  const admission = audience === "public" && (state.loaded || publicationRequestContext.getStore()?.revision>0) ? getHuameiKnowledgeBindingStatus(tenant, { state }) : null;
  const runtimeIndex = runtimeKnowledgeIndexStatus(tenant);
  const retrievalKey = JSON.stringify(["general", state.version || "runtime-only", audience, tenant, admission?.active_release?.id || admission?.mode || "internal", runtimeIndex.retrieval_revision, String(message), pathPrefixes, limit, minimumScore]);
  const cached = retrievalCache.get(retrievalKey);
  if (cached) return cached;
  const sourceRecords = !state.loaded && !publicationRequestContext.getStore()?.package
    ? []
    : audience === "internal" ? state.records : admittedPublicRecords(state, tenant);
  const records = pathPrefixes.length
    ? sourceRecords.filter((record) => pathPrefixes.some((prefix) => String(record.source_relative_path || "").startsWith(prefix)))
    : sourceRecords;
  const terms = queryTerms(message);
  const coreTerms = queryCoreTerms(message);
  const coreText = queryCoreText(message);
  const gateWeakEvidence = shouldGateWeakEvidence(message, coreTerms);
  const runtimeRecords = (audience === "public" && publicationRequestContext.getStore()?.revision>0 ? [] : searchRuntimeKnowledge(message, {
    tenant_id:tenant,
    audience,
    limit:Math.min(limit * 3, 20),
    minimum_score:0.04
  })).map((entry, index) => ({
    record:enrichRecord(entry.item, records.length + index),
    runtimeRelevance:entry.score
  }));
  if (!terms.length && !runtimeRecords.length) return [];
  const result = [
    ...records.map((record) => ({ record, runtimeRelevance:0 })),
    ...runtimeRecords
  ]
    .map(({ record, runtimeRelevance }) => ({
      record,
      // A direct-upload record is ranked both by its persisted vector and the
      // same lexical/evidence score used by the signed package.  A strong
      // match is intentionally preferred over a broad immutable catalog hit:
      // an operator who has just corrected a project or service document
      // expects the fresh, scoped source to take effect immediately. It still
      // remains ordinary RAG evidence and never impersonates GraphRAG output.
      score:recordScore(message, terms, record) + (runtimeRelevance * 1_100)
    }))
    .filter((entry) => entry.score >= minimumScore
      && (!gateWeakEvidence || hasMeaningfulCoreEvidence(entry.record, coreTerms, coreText)))
    .sort((left, right) => right.score - left.score || left.record.sourceIndex - right.record.sourceIndex)
    .slice(0, limit)
    .map(({ record, score }) => ({
      score:Number(score.toFixed(2)),
      item:{
        record_id:record.record_id,
        record_type:record.record_type,
        title:record.title,
        content:record.content,
        tags:record.tags || [],
        source_relative_path:record.source_relative_path,
        sensitivity:record.sensitivity,
        verification_note:record.verification_note || ""
      }
    }));
  return rememberRetrieval(retrievalKey, result);
}

const doctorNameFromPath = (path = "") => {
  const parts = String(path).split("/");
  const start = parts[0] === "公开资料" ? 1 : 0;
  if (parts[start] !== "医生介绍" || parts.length < start + 4) return "";
  const candidate = parts[start + 2];
  return candidate && !/\.[a-z0-9]+$/i.test(candidate) ? candidate : "";
};

const doctorProfileFocusTerms = (message = "") => {
  const text = String(message);
  if (/(?:丰胸|隆胸|胸部)/.test(text)) return ["丰胸", "隆胸", "胸部"];
  if (/(?:鼻|隆鼻|鼻整形)/.test(text)) return ["鼻", "隆鼻", "鼻整形"];
  if (/(?:眼|双眼皮|眼整形)/.test(text)) return ["眼", "双眼皮", "眼整形"];
  if (/(?:拉皮|微拉美|提升|抗衰|年轻化)/.test(text)) return ["拉皮", "微拉美", "提升", "年轻化"];
  if (/(?:脂肪|填充|吸脂)/.test(text)) return ["脂肪", "填充", "吸脂"];
  return [];
};

export function retrieveDoctorKnowledge(message, options = {}) {
  if (!isDoctorRecommendationIntent(message)) return [];
  const group = doctorProjectGroupFor(message);
  if (!group) return [];
  const state = loadHuameiKnowledge();
  if (!state.loaded) return [];
  const terms = queryTerms(message);
  const limit = Math.min(Math.max(Number(options.limit) || 4, 1), 8);
  const tenant = normalizeTenantId(options.tenantId);
  const admission = getHuameiKnowledgeBindingStatus(tenant, { state });
  const retrievalKey = JSON.stringify(["doctor-project", state.version, tenant, admission.active_release?.id || admission.mode, String(message), group.id, limit]);
  const cached = retrievalCache.get(retrievalKey);
  if (cached) return cached;
  const candidates = admittedPublicRecords(state, tenant)
    .filter((record) => record.record_type === "image_ocr")
    // 医生推荐属于高影响判断：即便公开资料扩展包已审核，推荐链路仍
    // 只使用已进入正式发布目录的医生资料；扩展包可用于一般资料检索。
    .filter((record) => String(record.source_relative_path || "").startsWith("医生介绍/"))
    .map((record) => {
      const doctorName = doctorNameFromPath(record.source_relative_path);
      const titleAndPath = normalize(`${record.title} ${record.source_relative_path}`);
      const leadingContent = normalize(String(record.content || "").slice(0, 700));
      const directMatches = group.evidenceTerms.filter((term) => titleAndPath.includes(normalize(term)));
      const contentMatches = group.evidenceTerms.filter((term) => leadingContent.includes(normalize(term)));
      const relevance = directMatches.length * 120 + contentMatches.length * 46;
      return { record, doctorName, relevance, score:recordScore(message, terms, record) + relevance };
    })
    .filter((entry) => entry.doctorName && entry.relevance > 0)
    .sort((left, right) => right.score - left.score || left.record.sourceIndex - right.record.sourceIndex);
  const selected = [];
  const seenDoctors = new Set();
  for (const entry of candidates) {
    if (seenDoctors.has(entry.doctorName)) continue;
    seenDoctors.add(entry.doctorName);
    selected.push({
      score:Number(entry.score.toFixed(2)),
      item:{
        record_id:entry.record.record_id,
        record_type:entry.record.record_type,
        title:entry.record.title,
        content:entry.record.content,
        tags:entry.record.tags || [],
        source_relative_path:entry.record.source_relative_path,
        sensitivity:entry.record.sensitivity,
        verification_note:entry.record.verification_note || "",
        doctor_name:entry.doctorName,
        project_direction:group.label
      }
    });
    if (selected.length >= limit) break;
  }
  return rememberRetrieval(retrievalKey, selected);
}

export function retrieveNamedDoctorProfiles(names = [], options = {}) {
  const requested = unique(names.map((name) => String(name || "").trim()));
  if (!requested.length) return [];
  const state = loadHuameiKnowledge();
  if (!state.loaded) return [];
  const limitPerDoctor = Math.min(Math.max(Number(options.limitPerDoctor) || 2, 1), 4);
  const requestQuery = String(options.query || "").trim();
  const focusTerms = doctorProfileFocusTerms(requestQuery);
  const tenant = normalizeTenantId(options.tenantId);
  const admission = getHuameiKnowledgeBindingStatus(tenant, { state });
  const retrievalKey = JSON.stringify(["named-doctor", state.version, tenant, admission.active_release?.id || admission.mode, requested, limitPerDoctor, requestQuery]);
  const cached = retrievalCache.get(retrievalKey);
  if (cached) return cached;
  const selected = [];
  for (const doctorName of requested) {
    const matches = admittedPublicRecords(state, tenant)
      .filter((record) => record.record_type === "image_ocr")
      // 点名医生属于专业信息咨询，仍优先使用正式发布的医生介绍，避免
      // 同名宣传物或历史海报挤占经核验的个人资料。
      .filter((record) => String(record.source_relative_path || "").startsWith("医生介绍/"))
      .filter((record) => doctorNameFromPath(record.source_relative_path) === doctorName)
      .map((record) => {
        const title = String(record.title || "");
        const priority = /(?:个人|简介|介绍)/.test(title) ? 120 : /(?:术式|手卡)/.test(title) ? 70 : 20;
        const query = requestQuery || `${doctorName} 医生介绍`;
        // 点名医生后又补充了“丰胸/鼻整形”等明确项目时，不能仍按通用
        // 个人介绍排序，否则会给出与当前问题无关的资料卡。
        const sourceText = normalize(`${record.title} ${record.source_relative_path} ${record.content || ""}`);
        const focusMatched = !focusTerms.length || focusTerms.some((term) => sourceText.includes(normalize(term)));
        return { record, focusMatched, score:priority + recordScore(query, queryTerms(query), record) };
      })
      .filter((entry) => entry.focusMatched)
      .sort((left, right) => right.score - left.score || left.record.sourceIndex - right.record.sourceIndex)
      .slice(0, limitPerDoctor);
    selected.push(...matches.map(({ record, score }) => ({
      score:Number(score.toFixed(2)),
      item:{
        record_id:record.record_id,
        record_type:record.record_type,
        title:record.title,
        content:record.content,
        tags:record.tags || [],
        source_relative_path:record.source_relative_path,
        sensitivity:record.sensitivity,
        verification_note:record.verification_note || "",
        doctor_name:doctorName
      }
    })));
  }
  return rememberRetrieval(retrievalKey, selected);
}

const safeOcrExcerpt = (content, message) => {
  const terms = queryTerms(message).filter((term) => term.length >= 2);
  const lines = String(content || "").split(/\r?\n/)
    .map((line) => line.replace(PROMOTIONAL_LANGUAGE, "").trim())
    .filter((line) => line.length >= 4)
    .filter((line) => !/^(?:资料分类|原始素材)[:：]/.test(line))
    .filter((line) => !PHONE_OR_ID.test(line))
    .filter((line) => !PRICE_LINE.test(line));
  const relevant = lines
    .map((line, sourceIndex) => ({
      line,
      sourceIndex,
      score:terms.reduce((score, term) => score + (normalize(line).includes(term) ? Math.max(2, term.length) : 0), 0)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex)
    .map((item) => item.line);
  return unique([...(relevant.length ? relevant : lines)].slice(0, 3))
    .join("；")
    .replace(/\s+/g, " ")
    .slice(0, 320);
};

export function publicEvidenceFor(hit, message = "") {
  const item = hit?.item || hit;
  if (!item || !publicEligible(item)) return null;
  const requiresVerification = item.record_type === "image_ocr"
    || PRICE_OR_POLICY.test(`${message} ${item.title} ${(item.tags || []).join(" ")}`)
    || DOCTOR_INTENT.test(`${message} ${item.title}`);
  const excerpt = item.record_type === "directory_overview"
    ? String(item.content || "").replace(PROMOTIONAL_LANGUAGE, "").replace(/检索/g, "查找").slice(0, 360)
    : safeOcrExcerpt(item.content, message);
  return {
    knowledge_id:item.record_id,
    source_record_id:item.record_id,
    title:item.title,
    version:loadHuameiKnowledge().version,
    source_relative_path:item.source_relative_path,
    record_type:item.record_type,
    excerpt,
    requires_verification:requiresVerification,
    verification_note:item.verification_note || "",
    usage:"huamei_internal_source_for_consumer_safe_summary",
    review_status:requiresVerification ? "回答前需业务/医务/合规核验" : "目录导航信息"
  };
}

const doctorFocusFromTitle = (title = "", doctorName = "", fallback = "相关项目介绍") => {
  const cleaned = String(title)
    .replace(/^医生与专家：/, "")
    .replace(/^【(?:医生\+|术式)】/, "")
    .replace(new RegExp(doctorName, "g"), "")
    .replace(/[-—_]*(?:个人)?(?:短图)?介绍|[-—_]*手卡|[()（）]?[12][()（）]?/g, "")
    .replace(/^术式/, "")
    .replace(/^[-—_\s]+|[-—_\s]+$/g, "")
    .trim();
  return cleaned && cleaned !== "术式" ? cleaned : fallback;
};

export function buildDoctorRecommendationResponse(message, hits = []) {
  if (!isDoctorRecommendationIntent(message) || !hits.length) return null;
  const group = doctorProjectGroupFor(message);
  if (!group) return null;
  const evidence = hits.map((hit) => {
    const item = hit.item;
    const source = publicEvidenceFor(hit, message);
    return source ? { ...source, doctor_name:item.doctor_name, project_direction:item.project_direction } : null;
  }).filter(Boolean).slice(0, 3);
  if (!evidence.length) return null;
  const doctorCandidates = evidence.slice(0, 3).map((item) => ({
    name:item.doctor_name,
    project_direction:item.project_direction,
    source_record_id:item.source_record_id,
    source_title:item.title,
    source_relative_path:item.source_relative_path,
    focus:doctorFocusFromTitle(item.title, item.doctor_name, group.label),
    requires_verification:true
  }));
  const candidateText = doctorCandidates.map((candidate) => `${candidate.name}院长`).join("、");
  return {
    status:"completed",
    message:`做${group.label}的相关医生，目前可先为您核验${candidateText}。每位公开资料对应的项目方向不完全相同，正式擅长范围和近期排班以院方最新信息为准。您更想先了解假体丰胸，还是自体脂肪丰胸方向？`,
    intent:"doctor_discovery_by_project",
    evidence,
    doctor_candidates:doctorCandidates,
    next_questions:["您更想先了解假体丰胸，还是自体脂肪丰胸方向？"]
  };
}

export function buildDoctorComparisonResponse(message, doctorNames = [], hits = []) {
  const names = unique(doctorNames.map((name) => String(name || "").trim()));
  if (names.length < 2 || !hits.length) return null;
  const evidence = hits.map((hit) => {
    const source = publicEvidenceFor(hit, message);
    return source ? { ...source, doctor_name:hit.item?.doctor_name || doctorNameFromPath(source.source_relative_path) } : null;
  }).filter(Boolean);
  const comparisons = names.map((name) => {
    const sources = evidence.filter((item) => item.doctor_name === name);
    const focuses = unique(sources.map((item) => doctorFocusFromTitle(item.title, name, "医生介绍"))).slice(0, 3);
    return { name, focuses, sources };
  }).filter((item) => item.sources.length);
  if (comparisons.length < 2) return null;
  return {
    status:"completed",
    message:`先按目前可核验的方向比较：${comparisons.map((item) => `${item.name}院长涉及${item.focuses.join("、") || "个人介绍"}`).join("；")}。这只能说明两位医生的介绍方向，不能据此判断谁更适合，职称和排班也要按院方最新信息确认。您想按哪个具体项目继续比较？`,
    intent:"doctor_comparison",
    evidence,
    doctor_candidates:comparisons.map((item) => ({
      name:item.name,
      focus:item.focuses.join("、") || "个人介绍",
      source_record_ids:item.sources.map((source) => source.source_record_id),
      requires_verification:true
    })),
    next_questions:["您想按哪个具体项目比较这两位医生？"]
  };
}

export function buildProductAttributeResponse(message, hits = []) {
  if (!/(?:水滴形|水滴型|解剖型|圆形|光面|微绒面|绒面|型号|假体形状)/.test(message)) return null;
  const evidence = hits.map((hit) => publicEvidenceFor(hit, message)).filter(Boolean);
  if (!evidence.length) return null;
  const phraseEntries = evidence
    .flatMap((item) => String(item.excerpt || "").split(/[；。\n]/)
      .map((phrase) => ({ phrase:phrase.trim(), evidence:item })))
    .filter((entry) => /(?:水滴形|水滴型|解剖型|圆形|光面|微绒面|绒面)/.test(entry.phrase));
  const queryProductTerms = queryTerms(message)
    .filter((term) => term.length >= 2)
    .filter((term) => !/(?:水滴|水滴形|水滴型|解剖型|圆形|光面|微绒面|绒面|丰胸|隆胸|胸部|是不是|属于|假体|形状)/.test(term));
  const matchedEntry = phraseEntries.find((entry) => queryProductTerms.some((term) => normalize(entry.phrase).includes(term))) || phraseEntries[0];
  if (!matchedEntry) return null;
  const matched = matchedEntry.phrase;
  const supportingEvidence = evidence.filter((item) => {
    const excerpt = normalize(item.excerpt || "");
    const hasAttribute = /(?:水滴形|水滴型|解剖型|圆形|光面|微绒面|绒面)/.test(item.excerpt || "");
    return hasAttribute && queryProductTerms.some((term) => excerpt.includes(term));
  });
  const compact = matched.replace(/^[·•\-\s]+/, "").slice(0, 100);
  const product = compact.split(/[（(]/)[0].trim();
  const waterdrop = /(?:水滴形|水滴型|解剖型)/.test(compact);
  const round = /圆形/.test(compact);
  const descriptor = compact.match(/[（(]([^）)]{2,40})[）)]/)?.[1] || (waterdrop ? "水滴形/解剖型" : round ? "圆形" : "当前资料标注的型号");
  const genericShapeQuestion = /^\s*(?:(?:丰胸|隆胸)[：:，,]?\s*)?(?:水滴形|水滴型|解剖型)(?:项目)?(?:有吗|有么|有没有|吗)?[？?]?\s*$/.test(message);
  return {
    status:"completed",
    message:waterdrop && genericShapeQuestion
      ? `有。水滴形是丰胸假体的一种形态，不是独立项目。当前已核验资料中，${product}标注为“${descriptor}”。具体可用型号以院方当前产品为准。`
      : waterdrop
        ? `是的，${product}在当前院方资料中标注为“${descriptor}”，属于水滴形。具体可用型号以院方当前产品为准。`
      : round
        ? `${product}在当前院方资料中标注为“${descriptor}”，属于圆形。具体可用型号以院方当前产品为准。`
        : `${compact}。具体可用型号以院方当前产品为准。`,
    intent:"product_attribute_verification",
    // 只引用真正包含“产品名 + 形状/表面属性”的资料，避免把同目录下的
    // 其他价目表误显示为当前结论的依据。
    evidence:(supportingEvidence.length ? supportingEvidence : [matchedEntry.evidence]).slice(0, 3),
    next_questions:[]
  };
}

const publicPathParts = (path = "") => {
  const parts = String(path).split("/").filter(Boolean);
  return parts[0] === "公开资料" ? parts.slice(1) : parts;
};

const isStarProductPath = (path = "") => publicPathParts(path)[0] === "明星产品";
const sourceFileName = (value = "") => String(value).replace(/\.[a-z0-9]+$/i, "");
const starProductNameFor = (record) => {
  const parts = publicPathParts(record?.source_relative_path);
  if (parts[0] !== "明星产品") return "";
  const folders = parts.slice(1, -1).filter((part) => !/价格|价目/.test(part));
  return folders.at(-1) || sourceFileName(parts.at(-1));
};

/**
 * Retail-product questions need a different conversational shape from a
 * medical-project consultation. The answer names the verified catalog item
 * first, then asks only one product-level follow-up.
 */
export function buildStarProductResponse(message, hits = [], options = {}) {
  const text = String(message || "").trim();
  const explicitCatalogQuestion = /(?:明星(?:产品|项目)|爆款|热销)/.test(text)
    && /(?:有|哪|什么|哪些|介绍|看看|了解|吗|？|\?)/.test(text);
  const candidateItems = hits.map((hit) => hit?.item || hit).filter((item) => item && isStarProductPath(item.source_relative_path));
  const directProductQuestion = !explicitCatalogQuestion
    && text.length <= 16
    && candidateItems.some((item) => item.record_type === "image_ocr" || item.record_type === "pdf_text");
  if (!explicitCatalogQuestion && !directProductQuestion) return null;

  const state = loadHuameiKnowledge();
  const tenantId = options.tenantId;
  const starRecords = admittedPublicRecords(state, tenantId)
    .filter((record) => isStarProductPath(record.source_relative_path));
  if (!starRecords.length) return null;

  if (explicitCatalogQuestion) {
    const branches = unique(starRecords
      .map((record) => publicPathParts(record.source_relative_path)[1] || "")
      .filter((name) => name && !/\.[a-z0-9]+$/i.test(name) && !/价格|价目/.test(name)))
      .slice(0, 4);
    const catalogRecord = starRecords.find((record) => publicPathParts(record.source_relative_path).length === 1 && record.record_type === "directory_overview")
      || starRecords.find((record) => record.record_type === "directory_overview")
      || starRecords[0];
    const evidence = [publicEvidenceFor(catalogRecord, text)].filter(Boolean);
    if (!branches.length || !evidence.length) return null;
    const question = "您想先看哪一类？";
    return {
      status:"completed",
      intent:"directory_discovery",
      message:`有呀。目前华美的明星产品主要有${branches.join("、")}。${question}`,
      evidence,
      next_questions:[question]
    };
  }

  // 短词直问会同时召回目录下多条素材（例如“面膜”既能命中“敷贴面膜”，也能
  // 命中目录名就叫“面膜”的那条）。按客户用词与目录名/文件名的贴合度选，
  // 避免用同目录里的另一款产品回答。
  const askedTerm = text.replace(/[？?！!。.\s、,，]/gu, "");
  const mediaCandidates = candidateItems.filter((candidate) => candidate.record_type === "image_ocr" || candidate.record_type === "pdf_text");
  const rankCandidate = (candidate) => {
    if (!askedTerm) return 0;
    const parts = publicPathParts(candidate.source_relative_path);
    const folder = parts.at(-2) || "";
    const file = sourceFileName(parts.at(-1));
    let score = 0;
    if (file === askedTerm) score += 80;
    else if (file.includes(askedTerm)) score += 40;
    if (folder && folder.includes(askedTerm)) score += 60;
    return score;
  };
  const item = [...mediaCandidates]
    .sort((left, right) => rankCandidate(right) - rankCandidate(left))
    .find((candidate) => rankCandidate(candidate) > 0) || mediaCandidates[0];
  if (!item) return null;
  const parts = publicPathParts(item.source_relative_path);
  const category = parts[1] || "明星产品";
  const productName = starProductNameFor(item) || sourceFileName(parts.at(-1)) || "这款产品";
  const evidence = [publicEvidenceFor(item, text)].filter(Boolean);
  if (!evidence.length) return null;
  const question = "您想先看使用方式，还是规格信息？";
  return {
    status:"completed",
    intent:"product_catalog_detail",
    message:`您说的是${productName}，归在${category}里。这张产品介绍图可以直接查看。${question}`,
    evidence,
    next_questions:[question]
  };
}

export function buildPublicKnowledgeResponse(message, hits = []) {
  const evidence = hits.map((hit) => publicEvidenceFor(hit, message)).filter(Boolean);
  if (!evidence.length) return null;
  const titles = unique(evidence.map((item) => item.title.replace(/^华美资料目录：/, ""))).slice(0, 3);
  const top = evidence[0];
  const priceIntent = PRICE_OR_POLICY.test(message);
  const doctorIntent = DOCTOR_INTENT.test(message);
  const explicitDirectoryIntent = DIRECTORY_INTENT.test(message);
  const directoryIntent = explicitDirectoryIntent || top.record_type === "directory_overview";
  let responseMessage;
  let intent;
  let nextQuestions;
  if (explicitDirectoryIntent) {
    intent = "directory_discovery";
    responseMessage = `${top.excerpt || `目前有“${titles.join("、")}”相关内容。`} 我可以按一个方向继续整理，价格和排班等时效信息再单独确认。您想先看项目、医生，还是价格政策？`;
  } else if (priceIntent) {
    intent = /(?:活动|政策|套餐|优惠|赠品|有效|过期|权益)/.test(message) ? "policy_verification" : "price_verification";
    responseMessage = "历史价格或活动可能已经调整，不能直接当作当前报价；需要确认包含项、有效期、限制条件和最终价格。您要核验现在的价格吗？";
  } else if (doctorIntent) {
    intent = "doctor_profile";
    const doctorName = extractNamedDoctorName(message);
    const sourceText = evidence.map((item) => `${item.title} ${item.source_relative_path} ${item.excerpt}`).join(" ");
    const directions = unique([
      /(?:鼻部|鼻整形|隆鼻)/.test(sourceText) ? "鼻部整形" : "",
      /(?:拉皮|提升|年轻化|抗衰)/.test(sourceText) ? "面部年轻化与提升" : "",
      /(?:隆胸|胸部)/.test(sourceText) ? "胸部整形" : "",
      /(?:自体脂肪|脂肪移植|4D光影)/.test(sourceText) ? "自体脂肪与面部轮廓" : ""
    ]);
    responseMessage = doctorName
      ? `${doctorName}院长的公开介绍主要涉及${directions.length ? directions.join("和") : titles.join("、")}。具体面诊安排会按院方最新信息确认。${directions.length >= 2 ? `您想先了解${directions[0]}，还是${directions[1]}？` : "您想先看个人介绍，还是具体项目方向？"}`
      : `目前有“${titles.join("、")}”相关医生介绍。这里先说明项目方向，不据此判断个体适用性；职称、正式擅长和排班以院方最新信息为准。您想先了解哪位医生？`;
    nextQuestions = directions.length >= 2
      ? [`您想先了解${directions[0]}，还是${directions[1]}？`]
      : ["您想先看个人介绍，还是具体项目方向？"];
  } else if (directoryIntent) {
    intent = "directory_discovery";
    responseMessage = `${top.excerpt || `目前有“${titles.join("、")}”相关内容。`} 我可以按一个方向继续整理，价格和排班等时效信息再单独确认。您想先看项目、医生，还是价格政策？`;
  } else {
    intent = "knowledge_grounded_explanation";
    const summaries = evidence.map((item) => item.excerpt).filter(Boolean).slice(0, 2);
    responseMessage = summaries.length
      ? `${summaries.join("；")}。具体方案需要到院确认。您更想继续看一般原理，还是到院流程？`
      : `目前有“${titles.join("、")}”相关项目介绍。我可以继续按项目原理、一般流程或到院准备来讲。您想先看哪一项？`;
  }
  return {
    status:"completed",
    message:responseMessage,
    intent,
    evidence,
    next_questions:nextQuestions || (priceIntent
      ? ["要请人工顾问继续核验当前信息吗？"]
      : ["您更想先了解一般原理，还是到院流程？"])
  };
}

export function getHuameiKnowledgeStatus(tenantId) {
  const state = loadHuameiKnowledge();
  const admission = getHuameiKnowledgeBindingStatus(tenantId, { state });
  const runtimeIndex = runtimeKnowledgeIndexStatus(tenantId);
  return {
    loaded:state.loaded,
    package_name:state.manifest?.package_name || "华美智能体知识库",
    version:state.version,
    generated_date:state.manifest?.generated_date || null,
    total_records:state.records.length,
    public_candidate_records:state.publicRecords.length,
    reviewed_public_material_records:state.publicMaterialRecords.length,
    reviewed_public_material_package:{
      loaded:state.publicMaterials?.loaded === true,
      version:state.publicMaterials?.manifest?.version || null,
      total_records:state.publicMaterials?.total_records || 0,
      source_root:state.publicMaterials?.root || null,
      error:state.publicMaterials?.error || null
    },
    public_retrievable_records:state.loaded ? admittedPublicRecords(state, tenantId).length : 0,
    runtime_knowledge_index:runtimeIndex,
    internal_catalog_admission:getKnowledgeIngestionAdmission(tenantId),
    admission,
    integrity:{
      valid:state.loaded,
      manifest_sha256:state.manifestSha256 || null,
      knowledge_units_sha256:state.knowledgeUnitsSha256 || null,
      public_safe_catalog_path:state.publicSafeCatalogPath || null,
      public_safe_catalog_sha256:state.publicSafeCatalogSha256 || null,
      public_safe_catalog_records:state.publicRecords.length,
      package_checksum:state.packageChecksum || null,
      all_record_list_checksum:state.allRecordListChecksum || null,
      declared_record_hashes:state.declaredRecordHashCount || 0,
      binding_valid:admission.binding?.valid === true,
      error:state.error || admission.error || null
    },
    restricted_assets_isolated:state.manifest?.restricted_asset_count ?? null,
    source_root:state.root,
    error:state.error
  };
}

export const resetHuameiKnowledgeForTest = () => {
  cache = null;
  retrievalCache.clear();
  bindingCache.clear();
};
