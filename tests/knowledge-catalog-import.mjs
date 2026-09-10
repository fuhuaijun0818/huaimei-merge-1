import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initialState } from "../src/data.js";
import { KNOWLEDGE_CATALOG_IMPORT } from "../src/knowledge-catalog-import.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const generated = execFileSync(process.execPath, ["scripts/build-knowledge-catalog-import.mjs"], { cwd:root, encoding:"utf8" });
assert.equal(generated, readFileSync(new URL("../src/knowledge-catalog-import.js", import.meta.url), "utf8"), "已提交的目录导入文件必须可由当前知识包重复生成");

assert.equal(KNOWLEDGE_CATALOG_IMPORT.schemaVersion, "huamei.knowledge-catalog-import.v9");
assert.equal(KNOWLEDGE_CATALOG_IMPORT.summary.sourceKnowledgeUnits, 7127);
assert.equal(KNOWLEDGE_CATALOG_IMPORT.physicians.length, 32, "医生介绍目录必须导入为独立医师档案，团队/中心资料不应被误建为个人档案");
assert.equal(KNOWLEDGE_CATALOG_IMPORT.products.length, 144, "项目介绍和明星产品目录必须导入产品目录");
assert.equal(KNOWLEDGE_CATALOG_IMPORT.prices.length, 42, "项目价格目录必须按资料组导入价格审核队列");

assert.equal(initialState.meta.tenant, "上海华美医疗美容医院");
assert.equal(initialState.physicians.length, KNOWLEDGE_CATALOG_IMPORT.physicians.length);
assert.equal(initialState.products.length, KNOWLEDGE_CATALOG_IMPORT.products.length);
assert.equal(initialState.priceEvidenceSources.length, KNOWLEDGE_CATALOG_IMPORT.prices.length);
assert.ok(initialState.physicians.every((item) => item.importSource === "华美智能体知识库_v1" && item.customerFacing === false));
assert.ok(initialState.products.every((item) => item.importSource === "华美智能体知识库_v1" && item.status === "草稿" && item.salesStatus === "待维护" && item.customerFacing === false));
const productsWithReferencePrice = initialState.products.filter((item) => item.price);
assert.equal(productsWithReferencePrice.length, 45, "仅直接匹配到原始价目资料的产品才允许显示资料参考价");
assert.ok(productsWithReferencePrice.every((item) => item.priceType === "资料参考价" && item.priceApprovalStatus === "待业务、医务与合规核验" && item.referencePriceSourcePath), "资料参考价必须携带核验状态和来源路径");
assert.equal(initialState.products.find((item) => item.name === "瑞可丽豆仙优")?.price, "¥2,980");
assert.equal(initialState.products.find((item) => item.name === "热玛吉")?.price, "¥68,200");
assert.equal(initialState.prices, undefined, "价格不应再作为独立运营对象；唯一维护入口是产品档案");
assert.ok(initialState.priceEvidenceSources.every((item) => item.importSource === "华美智能体知识库_v1" && item.kind === "price_evidence_source" && item.customerFacing === false));
assert.ok(initialState.priceEvidenceSources.every((item) => /^(?:项目价格|明星产品\/明星产品价格表)\//.test(item.sourceCollectionPath) && item.sourcePreviews.length > 0), "每组价目资料必须作为可追溯证据保留来源目录与审核预览");

const liJian = initialState.physicians.find((item) => item.name === "李健");
assert.ok(liJian, "李健医生资料应从内部知识库导入");
assert.equal(liJian.status, "资料待审核");
assert.match(liJian.sourceCollectionPath, /^医生介绍\/整形外科\/李健\//);

const storage = new Map();
globalThis.localStorage = {
  getItem:(key) => storage.get(key) || null,
  setItem:(key, value) => storage.set(key, String(value)),
  removeItem:(key) => storage.delete(key)
};
storage.set("huamei-ai-saas-mvp-v1", JSON.stringify({
  meta:{ version:3, businessCopyVersion:2, knowledgeCatalogImportVersion:"" },
  physicians:[{ id:"DR-001", name:"旧演示医生" }, { id:"DR-local", name:"人工维护医生" }],
  products:[{ id:"P-001", name:"旧演示产品" }, { id:"P-local", name:"人工维护产品" }],
  prices:[{ id:"PR-001", product:"旧演示价格" }, { id:"PR-local", product:"人工维护价格" }],
  audit:[]
}));
const { store } = await import(`../src/store.js?catalog-migration=${Date.now()}`);
assert.equal(store.state.physicians.some((item) => item.id === "DR-001"), false, "旧演示医生必须被知识库目录替换");
assert.equal(store.state.products.some((item) => item.id === "P-001"), false, "旧演示产品必须被知识库目录替换");
assert.equal(store.state.prices, undefined, "历史独立价格表迁移后不得继续暴露为可运营的数据集合，避免两套价格口径并存");
assert.equal(store.state.physicians.some((item) => item.id === "DR-local"), false, "管理后台不得从浏览器本地缓存读取或恢复业务资料");
assert.equal(store.state.products.some((item) => item.id === "P-local"), false, "管理后台不得从浏览器本地缓存读取或恢复产品资料");
assert.equal(store.state.legacyPriceReferences?.some((item) => item.id === "PR-local"), false, "浏览器缓存中的历史价格不能进入服务端运营数据");
delete globalThis.localStorage;

console.log("✓ 华美v1知识包已导入32位医师、144个产品项目和42组原始价目证据");
console.log("✓ 已提取45条可直接匹配的资料参考价；价格统一维护在产品档案，原始资料保留为证据且默认不对客发布");
