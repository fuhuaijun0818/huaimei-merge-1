import assert from "node:assert/strict";

process.env.HUAMEI_KNOWLEDGE_ROOT = "knowledge/huamei-v1";

const { retrieveHuameiKnowledge } = await import("../server/huamei-knowledge.mjs");

const unknownQueries = [
  "等离子睫毛增长术多少钱",
  "生物电面部提升多少钱",
  "磁力双眼皮多少钱",
  "量子细胞抗衰多少钱",
  "自体细胞隆胸多少钱",
  "基因美白针多少钱"
];
const knownQueries = [
  "热玛吉是什么原理",
  "口腔美容科拔牙术价格",
  "张群院长擅长什么",
  "6月份皮肤套餐政策",
  "瑞可丽面膜是什么"
];

for (const query of unknownQueries) {
  const hits = retrieveHuameiKnowledge(query, { audience:"public", limit:6, tenantId:"huamei-shanghai" });
  assert.equal(hits.length, 0, `未知项目不应返回证据：${query}`);
}
for (const query of knownQueries) {
  const hits = retrieveHuameiKnowledge(query, { audience:"public", limit:6, tenantId:"huamei-shanghai" });
  assert.ok(hits.length > 0, `已知项目必须保留检索：${query}`);
}

console.log(`✓ 无答案门槛：${unknownQueries.length}/${unknownQueries.length} 拒绝，${knownQueries.length}/${knownQueries.length} 已知问题保留`);
