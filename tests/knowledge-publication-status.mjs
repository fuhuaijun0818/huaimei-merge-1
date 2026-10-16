import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { indexStatusLabel, summarizeDocumentPublicationStatus, PUBLICATION_STATUS_LEGEND } from "../src/modules/knowledge/publication-status.js";

const doc = (overrides = {}) => ({ id:"kidoc_test", publication_readiness:{ ready:false, missing:[] }, ...overrides });
const pkg = (id, status, documentIds, active = false) => ({ id, status, active, documents:documentIds.map((documentId) => ({ id:documentId })) });

// 1. 资料在“对客启用”的发布包内：必须显示对客启用，而不是未发布
const active = summarizeDocumentPublicationStatus({
  document:doc(),
  publications:[pkg("kpub_active", "active", ["kidoc_test"], true), pkg("kpub_pending", "awaiting_evaluation", ["kidoc_test"])]
});
assert.equal(active.key, "active");
assert.equal(active.label, "对客启用");
assert.equal(active.tone, "success");
assert.equal(active.package_id, "kpub_active");
assert.equal(active.in_package, true);

// 2. 已评测但未启用
const evaluated = summarizeDocumentPublicationStatus({ document:doc(), publications:[pkg("kpub_eval", "evaluated", ["kidoc_test"])] });
assert.equal(evaluated.label, "已评测，未启用");
assert.equal(evaluated.package_id, "kpub_eval");

// 3. 只是候选包、还没评测
const awaiting = summarizeDocumentPublicationStatus({ document:doc(), publications:[pkg("kpub_new", "awaiting_evaluation", ["kidoc_test"])] });
assert.equal(awaiting.label, "候选包待评测");
assert.equal(awaiting.tone, "warning");

// 4. 只出现在已撤销的包里：不视为已发布
const withdrawn = summarizeDocumentPublicationStatus({ document:doc(), publications:[pkg("kpub_old", "withdrawn", ["kidoc_test"])] });
assert.equal(withdrawn.label, "未进入发布包");
assert.equal(withdrawn.in_package, false);
assert.equal(withdrawn.package_id, "");

// 5. 没有包但资料已具备候选条件
const ready = summarizeDocumentPublicationStatus({ document:doc({ publication_readiness:{ ready:true, missing:[] } }), publications:[] });
assert.equal(ready.label, "可准备候选");
assert.equal(ready.tone, "warning");

// 6. 其它资料的包不得影响本资料
const other = summarizeDocumentPublicationStatus({ document:doc(), publications:[pkg("kpub_other", "active", ["kidoc_other"], true)] });
assert.equal(other.label, "未进入发布包");

// 7. 索引状态必须有独立语义，不能只靠块数推断
assert.deepEqual(indexStatusLabel("indexed"), { label:"已索引", tone:"success" });
assert.deepEqual(indexStatusLabel("indexing"), { label:"索引中", tone:"warning" });
assert.deepEqual(indexStatusLabel("awaiting_parse"), { label:"待解析", tone:"warning" });
assert.deepEqual(indexStatusLabel("awaiting_correction"), { label:"待修正", tone:"warning" });
assert.deepEqual(indexStatusLabel(""), { label:"未建立索引", tone:"outline" });
assert.match(PUBLICATION_STATUS_LEGEND, /资料状态＝/, "页面必须解释三个维度的区别");

// 8. 界面必须真正拆成三列，且不得再写死“未对客发布”
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /import \{ indexStatusLabel, summarizeDocumentPublicationStatus, PUBLICATION_STATUS_LEGEND \} from "\.\/modules\/knowledge\/publication-status\.js"/, "三态展示必须来自 C 负责模块");
assert.match(app, /<th>解析与索引<\/th><th>资料状态<\/th><th>发布状态<\/th>/, "列表表头必须区分解析与索引、资料状态、发布状态");
assert.match(app, /summarizeDocumentPublicationStatus\(\{ document, publications:ui\.publications \}\)/, "发布状态必须结合发布包计算");
assert.match(app, /badge\(indexState\.label, indexState\.tone\)/, "索引状态必须直接展示语义标签");
assert.match(app, /escapeHtml\(PUBLICATION_STATUS_LEGEND\)/, "页面必须展示三态说明");
assert.doesNotMatch(app, /<td>\$\{badge\("未对客发布", "outline"\)\}<\/td>/, "不得再写死“未对客发布”");
assert.match(app, /desc:`\$\{document\.title\} · 当前 v\$\{document\.version\} · \$\{publicationStatusLabel\(document\)\}`/, "详情弹窗必须显示真实发布状态");
assert.match(app, /function publicationStatusLabel\(knowledgeDocument\)/, "发布状态文案必须由发布包计算得出");
assert.doesNotMatch(app, /当前 v\$\{document\.version\} · 尚未对客发布/, "详情弹窗不得再写死“尚未对客发布”");

console.log("✓ 资料状态、索引状态、发布状态三维度可区分；发布状态按发布包计算，写死的“未对客发布”已移除");
