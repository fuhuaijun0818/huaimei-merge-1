import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createJsonStateStore } from "./platform/json-state-store.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";

// This is the incremental RAG index for material uploaded through the
// management console. It is an INTERNAL candidate index, never an alternate
// publication path. Public answers use the independently activated, immutable
// knowledge release. The index uses deterministic Chinese
// feature vectors locally, so it never exports newly-uploaded material merely
// to make it searchable.
const initialState = { version:1, revision:0, entries:[] };
const store = createJsonStateStore({
  envName:"HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE",
  defaultFile:".local-data/runtime-knowledge-index.json",
  initialState
});
let diskSnapshot = null;

const VECTOR_DIMENSIONS = 384;
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;
const clone = (value) => JSON.parse(JSON.stringify(value));
const nowIso = () => new Date().toISOString();
const hash = (value) => createHash("sha256").update(String(value || ""), "utf8").digest("hex");
const normalize = (value = "") => String(value)
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "");

const normalizeText = (value = "") => String(value)
  .replace(/\u0000/g, "")
  .replace(/\r\n?/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const queryTerms = (value = "") => {
  const source = String(value).normalize("NFKC").toLowerCase();
  const terms = new Set();
  for (const word of source.match(/[a-z0-9][a-z0-9._-]{1,40}/g) || []) terms.add(normalize(word));
  for (const run of source.match(/[\p{Script=Han}]{2,32}/gu) || []) {
    terms.add(normalize(run));
    for (const size of [2, 3, 4, 5]) {
      for (let index = 0; index <= run.length - size; index += 1) terms.add(normalize(run.slice(index, index + size)));
    }
  }
  return [...terms].filter((term) => term.length >= 2).slice(0, 160);
};

const vectorFor = (value = "") => {
  const values = new Float64Array(VECTOR_DIMENSIONS);
  const terms = queryTerms(value);
  for (const term of terms) {
    const digest = createHash("sha256").update(term, "utf8").digest();
    const slot = digest.readUInt16BE(0) % VECTOR_DIMENSIONS;
    const sign = (digest[2] & 1) === 0 ? 1 : -1;
    values[slot] += sign * (1 + Math.min(term.length, 8) / 8);
  }
  let magnitude = 0;
  for (const valueAtIndex of values) magnitude += valueAtIndex * valueAtIndex;
  magnitude = Math.sqrt(magnitude);
  return magnitude ? Array.from(values, (item) => Number((item / magnitude).toFixed(8))) : Array(VECTOR_DIMENSIONS).fill(0);
};

const cosine = (left = [], right = []) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += Number(left[index] || 0) * Number(right[index] || 0);
  return Number.isFinite(score) ? score : 0;
};

const chunksFor = (value = "") => {
  const text = normalizeText(value);
  if (!text) return [];
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + CHUNK_SIZE);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf("。", end), text.lastIndexOf("；", end));
      if (boundary > offset + Math.floor(CHUNK_SIZE * 0.55)) end = boundary + 1;
    }
    const content = text.slice(offset, end).trim();
    if (content) chunks.push(content);
    if (end >= text.length) break;
    offset = Math.max(end - CHUNK_OVERLAP, offset + 1);
  }
  return chunks;
};

const validateState = (state) => {
  if (!state || typeof state !== "object" || state.version !== 1
    || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.entries)
    || state.entries.some((entry) => !entry || typeof entry !== "object"
      || typeof entry.tenant_id !== "string" || normalizeTenantId(entry.tenant_id) !== entry.tenant_id
      || !["record_id", "document_id", "title", "content", "source_relative_path"].every((field) => typeof entry[field] === "string" && entry[field].trim())
      || typeof entry.customer_facing !== "boolean"
      || !Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === "string")
      || !Array.isArray(entry.vector) || entry.vector.length !== VECTOR_DIMENSIONS
      || !entry.vector.every((value) => typeof value === "number" && Number.isFinite(value)))) {
    throw new Error("Runtime knowledge index has an invalid snapshot");
  }
  return state;
};

const currentSnapshot = () => {
  const file = store.status().file;
  if (!file) {
    const state = store.load();
    return { state, fingerprint:hash(JSON.stringify(state)) };
  }
  try {
    // Web and acquisition workers share this file but not the JSON store's
    // in-memory state. Observe atomic replacements before consulting any
    // retrieval cache; use nanosecond metadata, including inode and ctime.
    const stat = statSync(file, { bigint:true });
    const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    if (diskSnapshot?.signature !== signature) {
      const bytes = readFileSync(file, "utf8");
      const state = validateState(JSON.parse(bytes));
      diskSnapshot = { signature, state, fingerprint:hash(bytes) };
    }
    return diskSnapshot;
  } catch (cause) {
    // Never keep serving an earlier public snapshot after a withdrawal,
    // damaged file, permission failure, or removed shared volume.
    diskSnapshot = null;
    if (cause.code === "ENOENT") return { state:initialState, fingerprint:hash("missing") };
    const error = new Error("运行时知识索引暂时不可用", { cause });
    error.code = "RUNTIME_KNOWLEDGE_INDEX_UNAVAILABLE";
    throw error;
  }
};

const stateWithCollections = () => clone(currentSnapshot().state);

const publicRecord = (entry) => ({
  record_id:entry.record_id,
  record_type:"operator_uploaded_document",
  title:entry.title,
  content:entry.content,
  tags:entry.tags,
  source_relative_path:entry.source_relative_path,
  sensitivity:"internal",
  verification_note:`内部草稿检索，不代表对客发布 · ${entry.indexed_at}`,
  uploaded_document_id:entry.document_id,
  index_mode:"local_vector"
});

export function indexRuntimeKnowledgeDocument(document = {}) {
  const tenantId = normalizeTenantId(document.tenant_id);
  const documentId = String(document.id || "").trim();
  const rawText = normalizeText(document.raw_text || "");
  if (!documentId || rawText.length < 20) {
    const error = new Error("已解析知识资料缺少可索引正文");
    error.code = "RUNTIME_KNOWLEDGE_INDEX_SOURCE_INVALID";
    throw error;
  }
  const chunks = chunksFor(rawText);
  if (!chunks.length) {
    const error = new Error("知识资料未生成可检索文本块");
    error.code = "RUNTIME_KNOWLEDGE_INDEX_CHUNKS_EMPTY";
    throw error;
  }
  const state = stateWithCollections();
  state.entries = state.entries.filter((entry) => !(entry.tenant_id === tenantId && entry.document_id === documentId));
  const indexedAt = nowIso();
  const sourcePath = `运营上传/${String(document.department || "未分类").trim() || "未分类"}/${String(document.source_filename || document.title || documentId).trim()}`;
  const tags = [...new Set([...(Array.isArray(document.tags) ? document.tags : []), String(document.content_type || "").trim(), String(document.department || "").trim()]
    .map((item) => String(item || "").trim())
    .filter(Boolean))].slice(0, 20);
  const contentHash = hash(rawText);
  const customerFacing = false;
  const title = String(document.title || document.source_filename || "运营上传知识").trim().slice(0, 160);
  const entries = chunks.map((content, index) => ({
    record_id:`krt_${documentId}_${index + 1}`,
    tenant_id:tenantId,
    document_id:documentId,
    chunk_index:index + 1,
    title:chunks.length > 1 ? `${title}（${index + 1}/${chunks.length}）` : title,
    content,
    tags,
    source_relative_path:sourcePath,
    customer_facing:customerFacing,
    effective_at:document.effective_at || null,
    expires_at:document.expires_at || null,
    content_sha256:contentHash,
    vector:vectorFor(`${title}\n${tags.join(" ")}\n${content}`),
    indexed_at:indexedAt
  }));
  state.entries.unshift(...entries);
  state.entries = state.entries.slice(0, 50_000);
  state.revision += 1;
  store.save(state);
  return {
    status:"indexed",
    index_mode:"local_vector",
    embedding_model:"local-hashing-zh-v1",
    chunk_count:entries.length,
    indexed_at:indexedAt,
    index_revision:state.revision
  };
}

export function removeRuntimeKnowledgeDocument({ tenant_id, id, document_id } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const targetDocumentId = String(id || document_id || "").trim();
  if (!targetDocumentId) return { removed:0, index_revision:currentSnapshot().state.revision };
  const state = stateWithCollections();
  const before = state.entries.length;
  state.entries = state.entries.filter((entry) => !(entry.tenant_id === tenantId && entry.document_id === targetDocumentId));
  const removed = before - state.entries.length;
  if (removed) {
    state.revision += 1;
    store.save(state);
  }
  return { removed, index_revision:state.revision };
}

export function runtimeKnowledgeIndexStatus(tenantId) {
  const tenant = normalizeTenantId(tenantId);
  const { state, fingerprint } = currentSnapshot();
  const entries = state.entries.filter((entry) => entry.tenant_id === tenant);
  const now = Date.now();
  const visibilityBoundary = entries.reduce((latest, entry) => {
    for (const value of [entry.effective_at, entry.expires_at]) {
      const at = Date.parse(value);
      if (Number.isFinite(at) && at <= now) latest = Math.max(latest, at);
    }
    return latest;
  }, 0);
  return {
    storage_mode:"server_persistent_json",
    index_mode:"local_vector",
    embedding_model:"local-hashing-zh-v1",
    revision:state.revision,
    retrieval_revision:`${fingerprint}:${visibilityBoundary}`,
    chunks:entries.length,
    documents:new Set(entries.map((entry) => entry.document_id)).size,
    public_chunks:0,
    publication_boundary:"internal_candidates_only"
  };
}

export function searchRuntimeKnowledge(message, { tenant_id, audience = "public", limit = 5, minimum_score = 0.08 } = {}) {
  const tenant = normalizeTenantId(tenant_id);
  const query = normalizeText(message);
  if (!query) return [];
  const now = Date.now();
  const terms = queryTerms(query);
  const queryVector = vectorFor(query);
  const rows = stateWithCollections().entries
    .filter((entry) => entry.tenant_id === tenant)
    // Also quarantines legacy snapshots whose customer_facing flag was set
    // automatically. Do not trust flags copied from the previous intake flow.
    .filter(() => audience === "internal")
    .filter((entry) => !entry.effective_at || Date.parse(entry.effective_at) <= now)
    .filter((entry) => !entry.expires_at || Date.parse(entry.expires_at) > now)
    .map((entry) => {
      const normalizedContent = normalize(`${entry.title} ${entry.tags.join(" ")} ${entry.content}`);
      const lexicalHits = terms.reduce((count, term) => count + (normalizedContent.includes(term) ? 1 : 0), 0);
      const semantic = cosine(queryVector, entry.vector);
      const lexical = terms.length ? lexicalHits / Math.min(terms.length, 8) : 0;
      return { entry, score:(semantic * 0.72) + (lexical * 0.28), semantic, lexicalHits };
    })
    .filter((item) => item.score >= Math.max(0, Number(minimum_score) || 0))
    .sort((left, right) => right.score - left.score || right.lexicalHits - left.lexicalHits || String(left.entry.record_id).localeCompare(String(right.entry.record_id)))
    .slice(0, Math.min(Math.max(Number(limit) || 5, 1), 20))
    .map((item) => ({
      score:Number(item.score.toFixed(4)),
      vector_score:Number(item.semantic.toFixed(4)),
      item:publicRecord(item.entry)
    }));
  return clone(rows);
}

export const resetRuntimeKnowledgeIndexForTest = () => store.reset();
