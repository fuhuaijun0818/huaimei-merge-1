import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../apps/acquisition-advisor/src/App.jsx", import.meta.url), "utf8");

for (const status of ["idle", "submitting", "captured"]) {
  assert.ok(source.includes(`status:"${status}"`) || source.includes(`status === "${status}"`), `网页留资状态机必须包含 ${status}`);
}
assert.match(source, /type="checkbox"[^>]*checked=\{serviceConsent\}/, "用户必须主动勾选服务联系授权");
assert.match(source, /prompt\.consent_text/, "同意文案必须由服务端响应驱动");
assert.doesNotMatch(source, /onSubmit\(\{[^}]*service_consent\s*:\s*true/s, "网页不得硬编码代替用户同意");
assert.match(source, /pattern="[^"]*1\[3-9\]\[0-9\]\{9\}"/, "手机号输入框必须执行11位中国大陆格式校验");
assert.ok(source.includes("const isValidMainlandMobileInput = (value) => /^1[3-9]\\d{9}$/.test(normalizeMobileInput(value));"), "提交前必须按完整手机号校验，而非只依赖输入框提示");
assert.match(source, /if \(!isValidMainlandMobileInput\(mobile\)\) \{\s*setMobileError\("请输入有效的11位中国大陆手机号"\);\s*return;/s, "超长或格式错误手机号必须提示并阻止提交");
assert.doesNotMatch(source, /return local\.slice\(0, 11\);/, "手机号不得被截断为11位后再保存");
assert.doesNotMatch(source, /one-time-code|contact-verification\/challenges|contact-verification\/confirmations|短信验证码/, "网页留资不得再包含短信OTP步骤");
assert.match(source, /手机号待顾问回电时人工核对/, "保存成功后必须明确手机号待人工核号");
assert.doesNotMatch(source, /management_path|customer\?\.id|same_customer|VITE_MANAGEMENT_BASE_URL/, "公网成功页不得暴露客户ID、既有客户状态或CRM路径");
assert.match(source, /const appointmentLeadCaptureRequired = \(message\) => message\?\.orchestration\?\.action_proposal\?\.type === "appointment_request";/, "预约登记在未留资时必须触发留资提示");
assert.match(source, /APPOINTMENT_LEAD_CAPTURE_PROMPT/, "预约登记必须有明确的留资说明和授权文案");
assert.match(source, /message\.leadCapture\?\.should_prompt \|\| appointmentLeadCaptureRequired\(message\)/, "预约动作必须纳入留资卡展示条件");
assert.match(source, /leadCaptured=\{Boolean\(leadState\.result\)\}/, "留资成功后才允许解锁到院登记");
assert.match(source, /body\.delivery\?\.suppress_ai === true && body\.orchestration\?\.action_proposal\?\.type === "appointment_request"/, "人工接管后明确预约也必须接入待确认登记动作");
assert.match(source, /appointmentState\.proposal && !appointmentState\.intake/, "无AI回复的人工接管状态仍必须展示独立登记卡");
assert.match(source, /allowSubjectEntry/, "人工接管后的登记卡必须允许客户补充咨询项目或医生");
assert.match(source, /本登记不代表指定医生或接诊名额已锁定/, "人工接管后的登记不得暗示已锁定真实号源");
assert.match(source, /credentials:"include"/, "跨Origin网页请求必须携带HttpOnly会话Cookie");
assert.match(source, /const shouldApplyAppointmentResponse = \(current, submitted, incoming\) =>/, "到院登记变更必须校验异步回执是否仍适用于当前登记");
assert.match(source, /if \(incomingVersion < currentVersion\) return false;/, "版本落后的到院登记回执不得覆盖较新状态");
assert.match(source, /return current\.status !== "cancelled" \|\| incoming\.status === "cancelled";/, "已取消登记不得被非取消回执恢复");
assert.match(source, /acquisition-feedback/, "前台每轮回答必须支持赞踩反馈提交");
assert.match(source, /这次回答有帮助吗？/, "前台需要明确展示回答反馈入口");
assert.match(source, /reply_id:replyId/, "反馈必须绑定被评价的具体回答轮次");
assert.match(source, /transcript:messages\.slice\(-24\)/, "踩反馈必须携带有限且可审计的可见上下文");
assert.match(source, /message\.isFinalSegment && <ConversationFeedback/, "拆分短句的一轮回答只能展示一组反馈控件");

console.log("acquisition advisor direct lead-capture UI contract tests passed");
