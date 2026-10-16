// C-018 常用话术：分类、版本、命名变量与预览不替换真实客户数据。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MESSAGE_TEMPLATE_CATEGORIES,
  MESSAGE_TEMPLATE_VARIABLES,
  extractTemplateVariables,
  normalizeTemplateCategory,
  nextTemplateVersion,
  renderTemplatePreview,
  templateVariableSummary,
  templateVersionLabel
} from "../src/modules/knowledge/message-template.js";

// 1. 分类与版本
assert.ok(MESSAGE_TEMPLATE_CATEGORIES.includes("通用话术"), "必须有分类枚举");
assert.equal(normalizeTemplateCategory("预约与到院"), "预约与到院");
assert.equal(normalizeTemplateCategory("不存在的分类"), "通用话术", "未知分类必须回落到默认分类而不是原样存库");
assert.equal(normalizeTemplateCategory(""), "通用话术");
assert.equal(templateVersionLabel(3), "v3");
assert.equal(templateVersionLabel(undefined), "v1");

// 2. 版本只在内容变化时递增，单纯改状态不产生新版本
assert.equal(nextTemplateVersion({ previousVersion:2, previousContent:"您好", content:"您好" }), 2);
assert.equal(nextTemplateVersion({ previousVersion:2, previousContent:"您好", content:"您好，请问方便电话吗？" }), 3);
assert.equal(nextTemplateVersion({ previousVersion:0, previousContent:"", content:"新模板" }), 2, "异常版本号回落到 1 后再递增");

// 3. 变量必须显式命名，未定义变量要被识别出来
const named = extractTemplateVariables("您好{{客户称呼}}，{{预约时间}}到{{院区}}找{{顾问姓名}}。");
assert.deepEqual(named.used, ["客户称呼", "预约时间", "院区", "顾问姓名"]);
assert.deepEqual(named.unknown, []);
const unknown = extractTemplateVariables("您好{{客户全名}}，{{客户称呼}}在吗？");
assert.deepEqual(unknown.unknown, ["客户全名"]);
assert.deepEqual(unknown.used, ["客户称呼"]);
assert.ok(MESSAGE_TEMPLATE_VARIABLES.every((item) => item.description), "每个变量都必须有明确命名与说明");

// 4. 预览保留占位符，绝不替换成真实客户数据
const preview = renderTemplatePreview("您好{{客户称呼}}，{{预约时间}}见。");
assert.match(preview, /变量未替换：客户称呼/);
assert.match(preview, /变量未替换：预约时间/);
assert.doesNotMatch(preview, /\{\{客户称呼\}\}/, "预览必须把占位符显式标成未替换状态");
const summary = templateVariableSummary("您好{{客户称呼}}，{{未知变量}}");
assert.match(summary.text, /已使用变量：\{\{客户称呼\}\}/);
assert.match(summary.unknown_text, /未定义变量：\{\{未知变量\}\}/);

// 5. 界面必须提供分类/版本/变量预览，并在保存前拦截未定义变量
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /import \{ MESSAGE_TEMPLATE_CATEGORIES, MESSAGE_TEMPLATE_VARIABLES, renderTemplatePreview, normalizeTemplateCategory, extractTemplateVariables, templateVersionLabel \}/, "话术模板能力必须来自 C 负责模块");
assert.match(app, /formField\("分类","category"/, "编辑器必须提供分类");
assert.match(app, /id="message-template-preview"/, "编辑器必须提供预览区");
assert.match(app, /预览只保留占位符本身，不会替换成真实客户数据/, "预览必须说明不替换真实客户数据");
assert.match(app, /if \(unknown\.length\) return toast\(`模板变量未定义：/, "保存前必须拦截未定义变量");
assert.match(app, /event\.target\.name === "content" && event\.target\.closest\("#configuration-record-form"\)\?\.dataset\.kind === "message_template"/, "编辑内容时必须即时刷新预览");
assert.match(app, /category:normalizeTemplateCategory\(data\.category\)/, "保存时必须规范化分类");

const subpages = await readFile(new URL("../src/subpages.js", import.meta.url), "utf8");
assert.match(subpages, /table\(\["话术模板", "分类", "版本", "适用环节", "使用方式", "状态", "更新时间", "操作"\]/, "话术库列表必须展示分类与版本");

const router = await readFile(new URL("../server/api-router.mjs", import.meta.url), "utf8");
assert.match(router, /item\?\.kind === "message_template" && item\?\.status === "启用" && item\?\.presalesVisible !== false/, "售前工作集只能下发已启用且可见的话术");

// 6. 撤回/停用与插入守卫：停用后不得再被插入，已登记的消息不被改写
assert.match(app, /该话术已停用或不存在，请刷新页面/, "停用后插入必须被拒绝并提示刷新");
assert.match(app, /该话术仅供查看，不能插入会话/, "不可插入的话术必须有明确提示");
assert.match(app, /const commonPhraseRecords = \(\) => \(store\.state\.configurationRecords \|\| \[\]\)\n\s*\.filter\(\(item\) => item\.kind === "message_template"\n\s*&& item\.status === "启用"/, "会话窗口只推荐已启用话术");
assert.match(app, /input\.value = input\.value \? `\$\{input\.value\}\\n\$\{template\.content\}` : template\.content;/, "插入话术必须复制当时的内容快照，后续改模板不得回溯改写已插入/已登记消息");

console.log("✓ 话术模板具备分类/版本/命名变量与不替换真实数据的预览；停用后不再推荐，售前只取已启用可见版本");
