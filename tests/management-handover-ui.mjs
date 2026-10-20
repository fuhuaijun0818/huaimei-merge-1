import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { conversationSyncSignaturePayload, messagesChangedSinceCursor } from "../server/acquisition-sync-cursor.mjs";
import { templateVariableReminder, unresolvedTemplateVariables } from "../src/modules/reception/template-variable-validation.js";

const [app, subpages, store, client, leadStore, router, operationsStore] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/subpages.js", import.meta.url), "utf8"),
  readFile(new URL("../src/store.js", import.meta.url), "utf8"),
  readFile(new URL("../src/operations-client.js", import.meta.url), "utf8"),
  readFile(new URL("../server/lead-store.mjs", import.meta.url), "utf8"),
  readFile(new URL("../server/api-router.mjs", import.meta.url), "utf8"),
  readFile(new URL("../server/acquisition-operations-store.mjs", import.meta.url), "utf8")
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
assert.match(client, /handover_version:String\(handoverVersion \|\| ""\)\.trim\(\)/, "人工回复必须携带接管状态版本");
assert.match(app, /const externalConversationId = conversation\.externalConversationId \|\| conversation\.id;/, "人工回复必须使用接管任务关联的前台会话编号");
assert.match(app, /sendManagementConversationReply\(externalConversationId, text, \{ handoverVersion:handover\.updated_at, idempotencyKey \}\)/, "人工回复必须携带当前接管版本和可重试的稳定发送标识");
assert.match(client, /tasks\/\$\{encodeURIComponent\(id\)\}\/complete/, "任务完成必须调用服务端任务完成接口");
assert.match(app, /completeManagementTask\(taskId, \{ customerId:task\.customerId \}\)/, "任务完成必须绑定客户并在服务端持久化");
assert.match(app, /store\.applyTaskCompletion\(result\.task\)/, "服务端确认后才能更新本地任务状态");
assert.match(router, /taskCompleteMatch[\s\S]{0,900}completeAcquisitionTask|tasks\.complete/, "BFF必须把任务完成透传到持久化存储");
assert.match(app, /const isCurrentHandoverAssignee = \(handover\)/, "界面必须根据当前登录顾问识别实际领取人");
assert.match(app, /only current?领取人可发送|仅当前领取人可发送|only.*assignee/i, "非领取人必须在界面侧收到明确的发送限制说明");
assert.match(app, /if \(!isCurrentHandoverAssignee\(handover\)\) return toast\("该会话已由其他顾问领取；只有当前领取人可以发送"/, "发送动作必须在客户端先阻止非领取人");
assert.match(app, /"conversation-detail", "send-message"/, "售前动作白名单必须允许受服务端接管鉴权保护的发送动作");
assert.match(app, /REPLY_DRAFT_STORAGE_PREFIX/, "人工回复草稿必须有明确的浏览器会话级存储命名空间");
assert.match(app, /window\.sessionStorage/, "刷新后必须能恢复当前浏览器标签页中的未发送草稿");
assert.match(app, /replyDraftStorageKey\(conversationId\)/, "草稿存储键必须按企业身份与会话隔离");
assert.match(app, /saveReplyDraft\(event\.target\.dataset\.conversationId, event\.target\.value\)/, "输入时必须立即保存草稿");
assert.match(app, /clearReplyDraft\(conversationId\)/, "发送成功后必须清除已发送草稿");
assert.match(app, /prepareReplyDraftRetry\(conversationId, text\)/, "失败重试必须从草稿恢复稳定发送标识");
assert.match(router, /IDEMPOTENCY_KEY_REQUIRED/, "服务端必须拒绝缺少人工回复发送标识的请求");
assert.match(router, /X-Idempotent-Replay/, "服务端重试必须显式标注幂等回放");
assert.match(leadStore, /idempotency_key/, "人工消息必须持久化发送标识，避免协调缓存重启后重复写入");
assert.match(router, /assertHandoverReplyAuthorization/, "BFF必须在写入消息前校验当前接管权");
assert.match(operationsStore, /HANDOVER_REPLY_ASSIGNEE_FORBIDDEN/);
assert.match(operationsStore, /HANDOVER_REPLY_STATE_STALE/);
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
assert.match(app, /\["claimed", "active"\]\.includes\(task\?\.status\)/, "已接管任务的 active 状态必须进入人工接待分组");
assert.match(app, /data-action="conversation-detail"/, "会话详情按钮必须触发明确的详情动作");
assert.match(app, /case "conversation-detail": showConversationDetail\(id\);/, "会话详情动作必须打开只读详情视图");
assert.match(app, /function showConversationDetail\(/, "会话详情必须展示接待归属和状态");
assert.match(app, /conversationSyncLoading/, "会话首次同步必须具备独立加载状态");
assert.match(app, /acquisitionSnapshotHydrated: false/, "刷新后的新页面必须先标记为未加载完整会话快照");
assert.match(app, /const afterCursor = !full && ui\.acquisitionSnapshotHydrated\s*\?\s*encodeAcquisitionCursors\(readAcquisitionCursors\(\)\)\s*:\s*"";/, "只有已加载完整快照的当前页面才允许按游标请求增量");
assert.match(app, /store\.upsertAcquisitionSnapshot\(body\.data\);\s*persistAcquisitionCursors\(body\.data\?\.meta\?\.cursor\);\s*[\s\S]{0,320}ui\.acquisitionSnapshotHydrated = true;/, "首次全量同步成功后才能启用后续增量同步");
assert.match(app, /正在加载会话/, "同步尚未完成时不能误报为空会话");
assert.match(app, /会话同步失败/, "会话同步失败必须与真实空列表分开呈现");
assert.match(app, /data-action="refresh-conversations"/, "会话同步失败必须提供明确的重新同步动作");
assert.match(app, /action === "refresh-conversations"/, "重新同步动作必须重新请求会话快照");
assert.match(app, /function renderConversationsSubpage\(\)/, "人工接管、会话质检和Bad Case子页必须支持局部内容重绘");
assert.match(app, /container\.innerHTML = currentPage\(\)/, "子页刷新只能替换页面内容，不能重建整个应用外壳");
assert.match(app, /scheduleConversationsSubpageRender\(\)/, "后台同步必须合并子页重绘，避免频繁闪烁");
assert.match(app, /function renderCurrentPageContent\(\)/, "客户列表也必须使用内容区局部重绘");
assert.match(app, /客户列表\/客户360由操作员主动刷新/, "客户列表不得跟随后台会话轮询自动重绘");
assert.doesNotMatch(app, /schedulePageContentRender\(1500\)/, "客户列表后台同步不能自动重建上百行表格");
assert.match(app, /data-action="refresh-customers"/, "客户列表必须提供显式刷新入口");
assert.match(app, /background && \(routeInfo\(\)\.route === "customers"[\s\S]{0,160}routeInfo\(\)\.route === "conversations" && routeInfo\(\)\.id\)/, "客户页和会话子页的后台会话同步必须直接跳过");
assert.match(subpages, /data-action="refresh-takeovers"/, "人工接管队列必须提供显式刷新入口");
assert.match(subpages, /data-action="refresh-quality"/, "会话质检必须提供显式刷新入口");
assert.match(app, /event\.detail\?\.source === "acquisition-sync" \|\| event\.detail\?\.source === "acquisition-operations-sync"\) return/, "接管/质检子页不得跟随后台同步自动重绘");
assert.match(app, /requestConversationSync/, "SSE会话事件必须合并，不能每几秒拉取全量快照");
assert.match(app, /function selectFirstReceptionMatch\(\)/, "接待搜索命中后必须自动切入可见会话");
assert.match(app, /filterReceptionList\(\);\s*selectFirstReceptionMatch\(\);/, "搜索过滤后必须同步右侧聊天区");
assert.match(app, /Entering the inbox must start from a complete view/, "进入会话模块必须先拉取完整会话快照");
assert.match(router, /messagesChangedSinceCursor\(conversation\.messages, afterSequence\)/, "管理端增量同步必须使用同轮次消息补发逻辑");
assert.match(router, /client merges them by stable message ID/, "同轮次出站消息重放必须依靠稳定消息标识去重");
assert.match(router, /conversationSyncSignaturePayload\(conversation, durableCursor\)/, "留资后会话切换正式客户档案时必须触发增量同步");
assert.match(router, /authoritative:true/, "成功的会话全量快照必须标记为权威来源，避免保留旧进程残留会话");
assert.notDeepEqual(
  conversationSyncSignaturePayload({ id:"V-1", cursor:"session#1", customerId:"C-VISITOR-1", messages:[] }),
  conversationSyncSignaturePayload({ id:"V-1", cursor:"session#1", customerId:"C-AI-1", messages:[] }),
  "会话从匿名访客关联到正式客户时，增量游标签名必须变化"
);
assert.deepEqual(messagesChangedSinceCursor([
  { id:"inbound-1", from:"customer", seq:1 },
  { id:"reply-1", from:"ai", seq:1 },
  { id:"human-1", from:"staff" }
], 1).map((message) => message.id), ["reply-1", "human-1"], "已同步入站消息后，同轮次补写的AI回复和人工回复必须继续下发");
assert.deepEqual(messagesChangedSinceCursor([
  { id:"inbound-2", from:"customer", seq:2 },
  { id:"reply-2", from:"ai", seq:2 }
], 1).map((message) => message.id), ["inbound-2", "reply-2"], "新轮次必须下发完整客户和AI消息");
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
assert.match(app, /function customerMatchesSearch\(customer, query = ""\)/, "客户搜索必须统一处理脱敏手机号");
assert.match(app, /digits\.slice\(-4\)/, "完整手机号查询只能按脱敏手机号末四位匹配");
assert.match(app, /appointment\?\.status === "cancelled"/, "客户 360 必须优先显示已取消的到院登记终态");
assert.match(app, /function customerNotesCard\(customer\)/, "客户 360 必须展示独立客户备注");
assert.match(app, /data-action="add-customer-note"/, "客户 360 必须提供新增备注入口");
assert.match(app, /customer-note-form/, "新增备注必须通过独立表单提交");
assert.match(app, /customer_note:note/, "备注提交必须传递独立备注字段");
assert.match(app, /if \(form\.dataset\.saving === "true"\) return;/, "备注提交必须阻止重复点击重入");
assert.match(app, /form\.dataset\.saving = "false";[\s\S]{0,160}submit\.disabled = false/, "保存失败必须恢复可提交状态且保留原表单");
assert.match(app, /function contactRestrictionCard\(customer\)/, "禁止联系偏好必须有独立展示卡片");
assert.match(app, /禁止主动联系/, "禁止联系状态必须以醒目文案展示");
assert.match(app, /不得创建人工回访承诺或发起未授权触达/, "禁止联系状态必须说明明确的操作限制");
assert.match(leadStore, /qualityRedactedPrincipal/, "质量角色必须在服务端进入专用脱敏投影");
assert.match(leadStore, /\[会话内容已脱敏\]/, "质量视图不得下发会话原文");
assert.match(leadStore, /customers:\[\],\s*conversations:/, "质量视图不得下发客户档案或备注");
assert.match(router, /PHASE_ONE_CAPABILITIES\.conversationsReadRedacted/, "质量角色读取会话必须基于专门的脱敏能力");
assert.match(app, /function qualityRedactedConversationPanel\(\)/, "质量角色必须有独立的脱敏会话面板");
assert.match(app, /客户档案、联系方式、备注、预约及会话原文均不下发/, "质量面板必须声明数据边界");
assert.match(app, /hasCapability\('conversations:read_redacted'\)/, "质量角色登录后必须实际请求其脱敏视图");
assert.doesNotMatch(app, /new-schedule-slot|schedule-slot-form|确认预约前必须选择一个内部排班时段/);
assert.match(app, /到院登记待跟进/);
assert.match(app, /appointment-status/, "预约队列必须提供状态筛选");
assert.match(app, /appointment-date/, "预约队列必须提供日期筛选");
assert.match(app, /appointment-assignee/, "预约队列必须提供负责人筛选");
assert.match(app, /appointmentFilterQuery\(ui\.appointmentFilters\)/, "预约筛选条件必须传入真实管理端查询");
assert.match(app, /async function claimAppointmentFromUi\(intakeId, trigger\)[\s\S]*?await claimManagementAppointmentIntake\(intakeId\);[\s\S]*?await syncAppointmentOperations\(\);/, "领取登记后必须按当前筛选条件重新查询，不能保留已不匹配的旧行");
assert.match(client, /followup_status/, "管理端预约查询必须传递跟进状态筛选");
assert.match(client, /preferred_date/, "管理端预约查询必须传递期望日期筛选");
assert.match(client, /assignee/, "管理端预约查询必须传递负责人筛选");
assert.match(router, /followup_status:url\.searchParams\.get\("followup_status"\)/, "预约接口必须接收跟进状态筛选");
assert.match(app, /记录跟进/);
assert.match(app, /next_followup_at/, "预约跟进表单必须提供下一次跟进时间");
assert.match(app, /待客户补充信息时请填写下次跟进时间/, "待补充信息必须明确要求下一步时间");
assert.match(client, /next_followup_at/, "预约跟进请求必须把下一步时间传到服务端");
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
assert.match(app, /const RECEPTION_HISTORY_PAGE_SIZE = 6;/, "会话历史必须按固定窗口加载，避免一次性重绘全部消息");
assert.match(app, /function receptionHistoryWindow\(conversation\)/, "会话历史窗口必须独立管理已展示的消息数量");
assert.match(app, /The window stays fixed as new turns arrive/, "新消息到达时不得悄然扩大历史窗口而隐藏加载入口");
assert.match(app, /data-action="load-earlier-messages"/, "历史会话必须提供加载更早消息的真实页面入口");
assert.match(app, /function loadEarlierConversationMessages\(conversationId\)[\s\S]*?updateReceptionWindow\(\);/, "加载历史后必须仅更新接待窗口");
assert.match(app, /const chatAnchor=captureScrollAnchor\(chat\);[\s\S]*?if\(selector==='\.chat-body'\)restoreScrollAnchor\(current,anchor\);/, "加载更早消息时必须恢复当前阅读锚点，而不是跳到底部");
assert.match(app, /receptionScrollAnchors:\s*\{\}/, "接待工作台必须按会话保存滚动位置");
assert.match(app, /mode:\s*"anchor"[^}]*top:\s*element\.scrollTop/, "滚动锚点必须同时保留像素位置，锚点消息消失时不能回落到顶部");
assert.match(app, /if \(message\) element\.scrollTop = Math\.max\(0, message\.offsetTop - 8\);\s*else element\.scrollTop = element\.scrollHeight;/, "已读游标消息不在当前历史窗口时必须回落到最新消息，而不是顶部");
assert.match(app, /case "select-conversation":\s*\{[\s\S]{0,260}ui\.receptionScrollAnchors\[ui\.conversationId\]=previousAnchor;[\s\S]{0,120}ui\.conversationId = id;[\s\S]{0,120}render\(true\);/, "切换会话前必须保存当前会话滚动锚点");
assert.match(app, /const immediateAnchor=previousConversationId === ui\.conversationId[\s\S]{0,160}: ui\.receptionScrollAnchors\[ui\.conversationId\]/, "切换会话后必须优先恢复目标会话自己的滚动位置");
assert.match(app, /const previousList=document\.querySelector\('\.conversation-list'\)/, "会话切换必须捕获左侧会话列表真实滚动容器");
assert.match(app, /const nextList=document\.querySelector\('\.conversation-list'\)/, "会话切换后必须恢复到左侧会话列表原滚动位置");
assert.match(app, /const list=layout\.querySelector\('\.conversation-list'\);/, "实时刷新会话列表时必须捕获左侧滚动容器");
assert.match(app, /if\(list && listScroll !== undefined\) list\.scrollTop=listScroll;/, "实时刷新会话列表时必须保留左侧滚动位置");
assert.deepEqual(
  unresolvedTemplateVariables("您好，{{客户称呼}}，请了解{{ 项目名称 }}；{{客户称呼}}"),
  ["客户称呼", "项目名称"],
  "话术变量应去重并保留可补全的变量名"
);
assert.equal(
  templateVariableReminder("您好，{{客户称呼}}，请了解{{ 项目名称 }}"),
  "请先填写话术变量：{{客户称呼}}、{{项目名称}}",
  "未填写变量时应给出明确补全提示"
);
assert.equal(templateVariableReminder("您好，欢迎咨询"), "", "普通话术不应误触发变量提醒");
assert.match(app, /templateVariableReminder\(input\.value\)/, "插入含变量的话术时必须提示人工补全");
assert.match(app, /templateVariableReminder\(text\)[\s\S]{0,180}补全后才能发送/, "未填写变量的话术不得登记为已发送消息");

console.log("✓ 管理端真实接管、工时和未对接渠道真实性契约通过");
