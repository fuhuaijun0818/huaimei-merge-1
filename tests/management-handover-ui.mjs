import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, store, client, leadStore] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/store.js", import.meta.url), "utf8"),
  readFile(new URL("../src/operations-client.js", import.meta.url), "utf8"),
  readFile(new URL("../server/lead-store.mjs", import.meta.url), "utf8")
]);

assert.match(client, /credentials:"same-origin"/, "管理端必须支持服务端HttpOnly会话");
assert.match(client, /MANAGEMENT_NETWORK_UNAVAILABLE/, "网络中断必须给出可理解的失败原因");
assert.match(client, /资料未完成上传，请恢复后重试/, "上传中断不得被误报为成功");
assert.match(client, /\/api\/admin\/acquisition\/handovers/);
assert.match(client, /\/api\/admin\/acquisition\/bad-cases/);
assert.match(client, /\/api\/admin\/acquisition\/human-work/);
assert.doesNotMatch(client, /X-Service-Key/i, "浏览器代码不得包含内部服务密钥");
assert.doesNotMatch(client, /sessionStorage|localStorage|Authorization/i, "管理端不得在浏览器存储或组装Bearer令牌");
assert.match(client, /Idempotency-Key/, "人工写操作必须具备幂等键");
assert.match(client, /\/api\/admin\/appointment-intakes/);
assert.match(client, /\/api\/admin\/schedule-slots/);
assert.match(client, /\/api\/admin\/knowledge\/intake\/documents/);
assert.match(client, /revealManagementHandoverContact/);
assert.match(client, /contact-reveal-\$\{crypto\.randomUUID\(\)\}/, "每次显式查看必须生成独立一次性请求标识");
assert.doesNotMatch(client, /(?:localStorage|sessionStorage|indexedDB)[\s\S]{0,200}contact/i, "联系方式不得写入浏览器持久化存储");

assert.match(store, /replaceAcquisitionHandovers/);
assert.match(store, /updateAcquisitionHandover/);
assert.match(store, /handovers:\[\]/, "真实接管摘要不得持久化到浏览器localStorage");
assert.match(store, /customer\.origin === "acquisition_advisor"/);
assert.match(leadStore, /externalConversationId:sessionId/, "管理会话必须可与服务端接管任务关联");

assert.match(app, /人工接管实时队列/);
assert.match(app, /listManagementBadCases/);
assert.match(app, /reviewManagementBadCase/);
assert.match(app, /showBadCaseModal/);
assert.match(app, /claimManagementHandover/);
assert.match(app, /completeManagementHandoverWithWork/);
assert.doesNotMatch(app, /recordManagementHumanWork/, "管理端完结流程不得再拆成先complete、后record work");
assert.match(client, /completeManagementHandoverWithWork/);
assert.match(client, /minutes:Number\(minutes\)/, "完结请求必须一次携带实际工时");
assert.match(client, /complete-with-work/, "原子完结必须使用独立稳定幂等键");
assert.match(app, /HANDOVER_POLL_BASE_MS = 15_000/, "可见页面必须在30秒内发现新接管任务");
assert.match(app, /HANDOVER_POLL_MAX_BACKOFF_MS = 60_000/, "失败轮询必须有退避上限");
assert.match(app, /document\.visibilityState !== "visible"/, "隐藏页面必须暂停轮询");
assert.match(app, /window\.addEventListener\("pagehide", \(\) => \{[\s\S]*?pauseHandoverPolling\(\)/, "页面销毁必须清理轮询计时器");
assert.match(app, /newUrgent\.length/, "新出现的紧急接管必须主动提醒当前顾问");
assert.doesNotMatch(app, /唐欣怡的医疗问题等待人工接管|预约系统同步检查完成/, "通知中心不得伪装硬编码通知为实时数据");
assert.match(app, /企业微信、抖音、小红书在完成官方凭证、回调验签和发送验收前，不会把草稿或话术标记为“已发送”/, "未完成官方 IM 验收时不得把草稿伪装为真实外发");
assert.match(app, /customer\?\.origin === "acquisition_advisor"/);
assert.match(client, /revealManagementHandoverContact/);
assert.match(client, /contact-reveal-\$\{crypto\.randomUUID\(\)\}/, "每次显式查看必须使用新的单次请求标识");
assert.match(app, /data-action="reveal-contact"/);
assert.doesNotMatch(app, /new-schedule-slot|schedule-slot-form|确认预约前必须选择一个内部排班时段/);
assert.match(app, /到院登记待跟进/);
assert.match(app, /记录跟进/);
assert.match(app, /资料仅限当前授权科室/);
assert.match(app, /正在上传并解析…/, "资料上传必须显示明确等待状态");
assert.match(app, /showKnowledgeFieldErrors/, "资料维护服务端字段错误必须定位到对应表单项");
assert.match(app, /请修正标红字段后重试/, "资料维护字段错误必须给出明确的修正提示");
assert.match(app, /showKnowledgeVersionConflictModal/, "资料并发修改必须打开版本比较界面");
assert.match(app, /基于最新版本重试保存/, "资料并发冲突必须由用户显式确认后重试，不能自动覆盖");
assert.match(app, /knowledge-conflict-reload/, "资料并发冲突必须允许加载服务端最新版本");
assert.match(app, /解析预览与来源定位/, "已解析资料必须提供受控预览和来源定位");
assert.match(app, /当前资料尚未产生可预览的解析源段/, "未完成受控解析时不得伪造预览内容");
assert.match(app, /解析待处理/, "空块、乱码和异常表格必须明确标为待处理");
assert.match(app, /parseIssues/, "异常表格的服务端质量状态必须可呈现给操作人");
assert.match(app, /人工校订记录/, "授权详情必须展示人工校订的来源与操作记录");
assert.match(app, /查看原文快照/, "人工校订必须可在授权详情核验原文快照");
assert.match(app, /correction_history/, "人工校订记录必须来自服务端受控详情字段");
assert.match(app, /form\.id === "knowledge-intake-form"[\s\S]{0,220}clearKnowledgeFieldErrors/, "原始素材录入表单也必须清除旧字段错误");
assert.match(app, /客户回答/);
assert.match(app, /browser_storage_allowed !== false/, "前端必须拒绝不满足禁止浏览器存储约束的披露响应");
assert.match(app, /contactRevealHideTimer = window\.setTimeout\(\(\) => clearRevealedContact\(\), 30_000\)/, "明文联系方式必须自动从页面清除");

console.log("✓ 管理端真实接管、工时和未对接渠道真实性契约通过");
