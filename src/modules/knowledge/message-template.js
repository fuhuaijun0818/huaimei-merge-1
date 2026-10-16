// C-018 常用话术：分类、版本、命名变量与预览。
// 预览只保留变量占位符本身，绝不替换成真实客户数据，避免把客户信息写进模板或截图。

export const MESSAGE_TEMPLATE_CATEGORIES = ["通用话术", "预约与到院", "价格与活动", "异议处理", "术后关怀"];

export const MESSAGE_TEMPLATE_VARIABLES = [
  { name:"客户称呼", description:"客户希望被称呼的方式" },
  { name:"预约时间", description:"与客户确认后的到院时间" },
  { name:"院区", description:"客户选择的院区" },
  { name:"顾问姓名", description:"当前实名售前人员" }
];

const VARIABLE_PATTERN = /\{\{\s*([^{}]{1,24}?)\s*\}\}/g;
const KNOWN_VARIABLES = new Set(MESSAGE_TEMPLATE_VARIABLES.map((item) => item.name));

export const extractTemplateVariables = (content = "") => {
  const used = [];
  const unknown = [];
  for (const match of String(content).matchAll(VARIABLE_PATTERN)) {
    const name = match[1].trim();
    if (!KNOWN_VARIABLES.has(name)) {
      if (!unknown.includes(name)) unknown.push(name);
      continue;
    }
    if (!used.includes(name)) used.push(name);
  }
  return { used, unknown };
};

export const normalizeTemplateCategory = (value = "") => {
  const category = String(value || "").trim();
  return MESSAGE_TEMPLATE_CATEGORIES.includes(category) ? category : MESSAGE_TEMPLATE_CATEGORIES[0];
};

export const templateVersionLabel = (version) => `v${Number.isSafeInteger(Number(version)) && Number(version) > 0 ? Number(version) : 1}`;

// 只有模板内容变化才产生新版本；仅切换启用状态不改变版本，避免同一内容出现无意义版本。
export const nextTemplateVersion = ({ previousContent = "", content = "", previousVersion = 1 } = {}) => {
  const version = Number.isSafeInteger(Number(previousVersion)) && Number(previousVersion) > 0 ? Number(previousVersion) : 1;
  return String(previousContent) === String(content) ? version : version + 1;
};

// 预览：保留 {{变量}} 原样展示，不做任何客户数据替换。
export const renderTemplatePreview = (content = "") => String(content)
  .replace(VARIABLE_PATTERN, (match, name) => `〔变量未替换：${String(name).trim()}〕`);

export const templateVariableSummary = (content = "") => {
  const { used, unknown } = extractTemplateVariables(content);
  return {
    used,
    unknown,
    text: used.length ? `已使用变量：${used.map((name) => `{{${name}}}`).join("、")}` : "未使用变量：模板将按原文发送",
    unknown_text: unknown.length ? `未定义变量：${unknown.map((name) => `{{${name}}}`).join("、")}（保存前必须改用已命名变量）` : ""
  };
};
