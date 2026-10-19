import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadHuameiKnowledge } from "../server/huamei-knowledge.mjs";
import {
  assertMultimodalRuntimeSafe,
  classifyLanguage,
  getMultimodalGuardrail,
  getMultimodalReadiness
} from "../server/multimodal-policy.mjs";

for (const [text, expected] of [
  ["热玛吉是什么", "zh"],
  ["Thermage 热玛吉 原理", "mixed"],
  ["What is Thermage?", "en"],
  ["12345", "other"]
]) {
  assert.equal(classifyLanguage(text), expected, `语言分类错误：${text}`);
}

const knowledge = loadHuameiKnowledge();
assert.equal(knowledge.loaded, true);
const cases = (await readFile(new URL(
  "../artifacts/graphrag-baseline/graphrag-baseline-20261019.2/retrieval-cases.jsonl",
  import.meta.url
), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const readiness = getMultimodalReadiness({ records:knowledge.publicRecords, queries:cases, env:{} });
assert.equal(readiness.record_types.image_ocr, 654);
assert.equal(readiness.ocr_missing_verification, 0, "OCR记录必须逐条保留核验说明");
assert.equal(readiness.language.en || 0, 0, "当前公开知识子集不应被误判为存在纯英文知识");
assert.equal(readiness.query_language.en || 0, 0, "当前评测集没有纯英文查询");
assert.equal(readiness.flags.multilingual_requested, false);
assert.equal(readiness.flags.image_requested, false);

const guardrail = getMultimodalGuardrail({});
assert.equal(guardrail.ocr_text_only, true);
assert.equal(guardrail.image_embedding, false);
assert.equal(guardrail.generated_image_description_as_fact, false);
assert.equal(guardrail.multilingual_retrieval, false);
assert.equal(guardrail.image_retrieval, false);

assert.throws(
  () => assertMultimodalRuntimeSafe({
    records:knowledge.publicRecords,
    queries:cases,
    env:{ HUAMEI_MULTILINGUAL_RETRIEVAL_ENABLED:"true" }
  }),
  (error) => error.code === "MULTILINGUAL_EMBEDDING_NOT_APPROVED"
);
assert.throws(
  () => assertMultimodalRuntimeSafe({
    records:knowledge.publicRecords,
    queries:cases,
    env:{ HUAMEI_IMAGE_RETRIEVAL_ENABLED:"true" }
  }),
  (error) => error.code === "IMAGE_EMBEDDING_NOT_APPROVED"
);

console.log("✓ 语言分布、OCR核验覆盖、多语言/图片检索默认关闭与启用门禁通过");
