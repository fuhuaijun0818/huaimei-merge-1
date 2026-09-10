import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../apps/acquisition-advisor/src/App.jsx", import.meta.url), "utf8");

for (const status of ["idle", "submitting", "captured"]) {
  assert.ok(source.includes(`status:"${status}"`) || source.includes(`status === "${status}"`), `网页留资状态机必须包含 ${status}`);
}
assert.match(source, /type="checkbox"[^>]*checked=\{serviceConsent\}/, "用户必须主动勾选服务联系授权");
assert.match(source, /prompt\.consent_text/, "同意文案必须由服务端响应驱动");
assert.doesNotMatch(source, /onSubmit\(\{[^}]*service_consent\s*:\s*true/s, "网页不得硬编码代替用户同意");
assert.match(source, /pattern="1\[3-9\]\[0-9\]\{9\}"/, "手机号输入框必须执行11位中国大陆格式校验");
assert.doesNotMatch(source, /one-time-code|contact-verification\/challenges|contact-verification\/confirmations|短信验证码/, "网页留资不得再包含短信OTP步骤");
assert.match(source, /手机号待顾问回电时人工核对/, "保存成功后必须明确手机号待人工核号");
assert.doesNotMatch(source, /management_path|customer\?\.id|same_customer|VITE_MANAGEMENT_BASE_URL/, "公网成功页不得暴露客户ID、既有客户状态或CRM路径");
assert.match(source, /credentials:"include"/, "跨Origin网页请求必须携带HttpOnly会话Cookie");
assert.match(source, /acquisition-feedback/, "前台每轮回答必须支持赞踩反馈提交");
assert.match(source, /这次回答有帮助吗？/, "前台需要明确展示回答反馈入口");
assert.match(source, /reply_id:replyId/, "反馈必须绑定被评价的具体回答轮次");
assert.match(source, /transcript:messages\.slice\(-24\)/, "踩反馈必须携带有限且可审计的可见上下文");
assert.match(source, /message\.isFinalSegment && <ConversationFeedback/, "拆分短句的一轮回答只能展示一组反馈控件");

console.log("acquisition advisor direct lead-capture UI contract tests passed");
