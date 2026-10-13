// Reusable phrase templates may use {{变量名}} placeholders. They remain
// visible in drafts so an operator can complete them, but must never be sent
// as unresolved text to a customer.
const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;

export const unresolvedTemplateVariables = (text = "") => {
  const names = [];
  const seen = new Set();
  for (const match of String(text).matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    const name = String(match[1] || "").trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
};

export const templateVariableReminder = (text = "") => {
  const variables = unresolvedTemplateVariables(text);
  return variables.length ? `请先填写话术变量：${variables.map((name) => `{{${name}}}`).join("、")}` : "";
};
