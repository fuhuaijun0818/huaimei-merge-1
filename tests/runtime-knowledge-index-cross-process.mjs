import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureRoot = mkdtempSync(join(tmpdir(), "huamei-runtime-index-refresh-"));
const indexFile = join(fixtureRoot, "runtime-index.json");
const moduleUrl = new URL("../server/runtime-knowledge-index.mjs", import.meta.url).href;
const tenant = "tenant-shanghai";
const otherTenant = "tenant-hangzhou";
const query = "星云服务方案";
process.env.HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE = indexFile;
process.env.HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE = ":memory:";
process.env.HUAMEI_KNOWLEDGE_INGESTION_ADMISSION_STORE_FILE = ":memory:";
const packageRoot = join(fixtureRoot, "unavailable-immutable-package");
mkdirSync(join(packageRoot, "rag"), { recursive:true });
writeFileSync(join(packageRoot, "manifest.json"), "{}");
writeFileSync(join(packageRoot, "rag", "knowledge_units.jsonl"), "");
process.env.HUAMEI_KNOWLEDGE_ROOT = packageRoot;
process.env.HUAMEI_KNOWLEDGE_PUBLIC_SAFE_CATALOG = join(packageRoot, "missing-public-safe.jsonl");

// Keep this reader alive while a separate process changes the shared file,
// matching the deployed web/acquisition container arrangement.
const index = await import(moduleUrl);
const { retrieveHuameiKnowledge } = await import("../server/huamei-knowledge.mjs");
const writerSource = `
  import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.action === "replace") {
    const temporary = process.env.HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE + ".fixture";
    writeFileSync(temporary, input.bytes);
    renameSync(temporary, process.env.HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE);
  } else if (input.action === "remove") {
    unlinkSync(process.env.HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE);
  } else {
    const index = await import(input.moduleUrl);
    if (input.action === "reset") index.resetRuntimeKnowledgeIndexForTest();
    else index.indexRuntimeKnowledgeDocument(input.document);
  }
`;
const mutateInWriter = (payload) => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", writerSource], {
    env:process.env,
    input:JSON.stringify({ moduleUrl, ...payload }),
    encoding:"utf8",
    timeout:15_000
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
};
const document = (overrides = {}) => ({
  id:"shared-document-id",
  tenant_id:tenant,
  title:query,
  source_filename:"星云服务方案.md",
  department:"运营中心",
  tags:[query],
  raw_text:"星云服务方案的旧版说明：客户提交需求后，由服务人员核对资料并提供办理步骤。",
  ...overrides
});
const publish = (overrides) => mutateInWriter({ action:"index", document:document(overrides) });
const search = (tenantId = tenant, audience = "internal") => index.searchRuntimeKnowledge(query, { tenant_id:tenantId, audience });
const retrieve = (tenantId = tenant, audience = "internal") => retrieveHuameiKnowledge(query, { tenantId, audience });
const unavailable = (error) => error.code === "RUNTIME_KNOWLEDGE_INDEX_UNAVAILABLE";

try {
  assert.deepEqual(search(), []);
  assert.deepEqual(retrieve(), [], "Pre-upload empty cache is primed in the acquisition reader");

  publish();
  assert.match(search()[0].item.content, /旧版说明/);
  assert.match(retrieve()[0].item.content, /旧版说明/, "New shared-volume uploads bypass the reader's earlier empty result");
  assert.deepEqual(search(tenant, "public"), [], "Even a candidate flag cannot publish drafts");
  assert.deepEqual(retrieve(tenant, "public"), []);
  const firstRevision = index.runtimeKnowledgeIndexStatus(tenant).revision;

  publish({ tenant_id:otherTenant, raw_text:"星云服务方案的杭州私有说明：这份资料只属于杭州租户，不得被上海租户检索或引用。" });
  assert.equal(index.runtimeKnowledgeIndexStatus(tenant).documents, 1);
  assert.equal(index.runtimeKnowledgeIndexStatus(otherTenant).documents, 1);
  assert.ok(search().every((hit) => !hit.item.content.includes("杭州私有")));
  assert.ok(retrieve().every((hit) => !hit.item.content.includes("杭州私有")));
  assert.ok(retrieve(otherTenant).every((hit) => hit.item.content.includes("杭州私有")));

  publish({ raw_text:"星云服务方案的新版说明：客户提交需求后，由服务人员核对资料并提供全新步骤。" });
  assert.ok(index.runtimeKnowledgeIndexStatus(tenant).revision > firstRevision);
  assert.match(search()[0].item.content, /新版说明/);
  assert.match(retrieve()[0].item.content, /新版说明/, "Cached old wording must be replaced without restarting acquisition");
  assert.ok(retrieve().every((hit) => !hit.item.content.includes("旧版说明")));

  // A writer initialized before another process's update must merge against
  // the current disk snapshot, not overwrite unrelated tenant records.
  index.indexRuntimeKnowledgeDocument(document({ id:"reader-side-document", raw_text:"银河流程文档供运营人员介绍资料准备和服务办理步骤，所有信息均由本地独立测试生成。" }));
  assert.equal(index.runtimeKnowledgeIndexStatus(otherTenant).documents, 1);

  publish({ customer_facing_candidate:false });
  assert.deepEqual(search(tenant, "public"), []);
  assert.deepEqual(retrieve(tenant, "public"), [], "Drafts never become customer evidence");
  assert.ok(search(tenant, "internal").some((hit) => hit.item.uploaded_document_id === "shared-document-id"));
  assert.ok(retrieve(tenant, "internal").every((hit) => !hit.item.content.includes("杭州私有")));

  publish({ expires_at:new Date(Date.now() - 1_000).toISOString() });
  assert.ok(search().every((hit) => hit.item.uploaded_document_id !== "shared-document-id"));
  assert.ok(retrieve().every((hit) => hit.item.record_id !== "krt_shared-document-id_1"));

  const clock = Date.now;
  const start = clock();
  publish({ effective_at:new Date(start + 10_000).toISOString(), expires_at:new Date(start + 20_000).toISOString() });
  try {
    Date.now = () => start;
    const revision = index.runtimeKnowledgeIndexStatus(tenant).revision;
    assert.ok(retrieve().every((hit) => hit.item.record_id !== "krt_shared-document-id_1"));
    Date.now = () => start + 10_000;
    assert.ok(retrieve().some((hit) => hit.item.record_id === "krt_shared-document-id_1"), "Effective dates invalidate an earlier cached miss");
    Date.now = () => start + 20_000;
    assert.ok(retrieve().every((hit) => hit.item.record_id !== "krt_shared-document-id_1"), "Expiration invalidates cached evidence even without a write");
    assert.equal(index.runtimeKnowledgeIndexStatus(tenant).revision, revision);
  } finally {
    Date.now = clock;
  }

  publish();
  assert.ok(retrieve().some((hit) => hit.item.record_id === "krt_shared-document-id_1"));
  const validBytes = readFileSync(indexFile, "utf8");
  mutateInWriter({ action:"replace", bytes:'{"version":1,"entries":' });
  assert.throws(() => search(), unavailable);
  assert.throws(() => retrieve(), unavailable, "A damaged shared file must not return a cached public answer");
  mutateInWriter({ action:"replace", bytes:JSON.stringify({ version:1, revision:100, entries:[{ customer_facing:true }] }) });
  assert.throws(() => retrieve(), unavailable, "Parseable but malformed snapshots also fail closed");
  mutateInWriter({ action:"replace", bytes:validBytes });
  assert.ok(retrieve().some((hit) => hit.item.record_id === "krt_shared-document-id_1"));

  // Restore/replace operations may retain the stored numeric revision. The
  // retrieval token must also follow file content, not only that counter.
  const replacement = JSON.parse(validBytes);
  replacement.entries = replacement.entries.filter((entry) => entry.tenant_id !== tenant);
  mutateInWriter({ action:"replace", bytes:JSON.stringify(replacement) });
  assert.deepEqual(retrieve(), []);
  assert.ok(retrieve(otherTenant).length > 0);
  mutateInWriter({ action:"remove" });
  assert.deepEqual(search(otherTenant), []);
  assert.deepEqual(retrieve(otherTenant), [], "Removing the shared index must clear previously cached references");

  publish();
  assert.ok(retrieve().length > 0, "The live reader recovers after shared-file recreation");
  mutateInWriter({ action:"reset" });
  assert.deepEqual(retrieve(), []);

  process.env.HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE = ":memory:";
  const memoryIndex = await import(`${moduleUrl}?memory-fixture`);
  memoryIndex.indexRuntimeKnowledgeDocument(document());
  assert.equal(memoryIndex.searchRuntimeKnowledge(query, { tenant_id:tenant, audience:"internal" }).length, 1);
  assert.deepEqual(memoryIndex.searchRuntimeKnowledge(query, { tenant_id:otherTenant }), []);
  assert.equal(memoryIndex.runtimeKnowledgeIndexStatus(tenant).documents, 1);
  memoryIndex.resetRuntimeKnowledgeIndexForTest();
  assert.deepEqual(memoryIndex.searchRuntimeKnowledge(query, { tenant_id:tenant }), []);
  console.log("✓ 跨进程知识新增/更新/撤回、有效期缓存、租户隔离、索引损坏关闭与内存模式通过");
} finally {
  rmSync(fixtureRoot, { recursive:true, force:true });
}
