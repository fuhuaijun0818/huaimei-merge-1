import { ROLE_CATALOG, roleCatalogEntry } from "./role-catalog.js";
import { PROJECT_KNOWLEDGE_DATASET, projectKnowledge } from "./project-knowledge.js";
// Keep the signed catalog import revision explicit. Besides avoiding a stale
// browser module after a local import is regenerated, the schema version below
// causes only auto-matched values to be refreshed; verified manual prices stay
// intact.
import { KNOWLEDGE_CATALOG_IMPORT } from "./knowledge-catalog-import.js?catalog=v9";

const iso = (days = 0, hours = 0) => {
  const date = new Date("2026-08-10T09:30:00+08:00");
  date.setDate(date.getDate() + days);
  date.setHours(date.getHours() + hours);
  return date.toISOString();
};

const portrait = (skin, hair, top, accent) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
    <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${accent}"/><stop offset="1" stop-color="#f7eee9"/></linearGradient></defs>
    <rect width="160" height="160" rx="32" fill="url(#b)"/><circle cx="80" cy="66" r="34" fill="${skin}"/>
    <path d="M47 70c0-31 16-48 36-48 23 0 37 17 35 51-8-12-18-23-33-27-8 12-21 20-38 24Z" fill="${hair}"/>
    <path d="M34 157c2-36 20-54 46-54s44 18 47 54" fill="${top}"/><path d="M65 62c3-3 8-3 11 0M91 62c3-3 8-3 11 0" stroke="#46352f" stroke-width="2" stroke-linecap="round"/>
    <path d="M73 83c6 5 12 5 18 0" stroke="#b66f68" stroke-width="2.5" fill="none" stroke-linecap="round"/><circle cx="68" cy="68" r="2"/><circle cx="98" cy="68" r="2"/>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const event = (id, type, title, detail, day, hour, actor, channel, tone = "neutral") => ({
  id, type, title, detail, occurredAt: iso(day, hour), actor, channel, tone
});

export const PHASE_ONE_MANAGEMENT_ROLES = Object.freeze(ROLE_CATALOG.map(r=>Object.freeze({id:r.id,name:r.name,scope:r.scope,permissions:r.permissions,status:"启用",fixed:true})));
export const resolvePhaseOneManagementRole = (candidate = {}, fallbackId = "R-PRESALES") => {
  const values = candidate && typeof candidate === "object" ? [candidate.roleId,candidate.role] : [candidate];
  const entry=values.map(roleCatalogEntry).find(Boolean) || roleCatalogEntry(fallbackId);
  return PHASE_ONE_MANAGEMENT_ROLES.find(r=>r.id===entry?.id) || PHASE_ONE_MANAGEMENT_ROLES.find(r=>r.id==='R-PRESALES');
};

export const clonePhaseOneManagementRoles = () => PHASE_ONE_MANAGEMENT_ROLES.map((role) => ({
  ...role,
  permissions:[...role.permissions]
}));

export const initialState = {
  meta: { version: 8, businessCopyVersion: 2, catalogOperatingModelVersion: 4, catalogPriceReferenceVersion: "20260831.3", managementDataModelVersion: 2, tenant: "上海华美医疗美容医院", knowledgeDataset: PROJECT_KNOWLEDGE_DATASET.id, knowledgeCatalogImportVersion: KNOWLEDGE_CATALOG_IMPORT.schemaVersion, physicianAvatarDataset: "photoreal-v1", lastSync: iso(0, -1) },
  handovers: [],
  currentRole: "系统管理员",
  managementUsers: [
    { id:"U-001", name:"许宁", nickname:"许宁", staffId:"HM-ADM-001", account:"xuning", department:"运营中心", roleId:"R-ADMIN", role:"系统管理员", status:"启用", updatedAt:iso(0, -1) },
    { id:"U-002", name:"周妍", nickname:"妍妍", staffId:"HM-PS-001", account:"zhouyan", department:"在线咨询组", roleId:"R-PRESALES", role:"售前顾问", status:"启用", updatedAt:iso(-1) },
    { id:"U-003", name:"顾薇", nickname:"顾薇", staffId:"HM-ADM-002", account:"guwei", department:"医务与合规", roleId:"R-ADMIN", role:"系统管理员", status:"启用", updatedAt:iso(-2) }
  ],
  managementRoles: clonePhaseOneManagementRoles(),
  products: KNOWLEDGE_CATALOG_IMPORT.products.map((item) => ({
    ...item,
    productCode:"待编",
    serviceType:"医美项目",
    salesStatus:"待维护",
    status:"草稿",
    approvalStatus:"待审核",
    // 价格是产品档案的组成字段；有明确价格值即代表一条当前价格记录。
    priceCount:item.referencePrice ? 1 : 0,
    owner:"待分配",
    branch:"全院",
    channel:"全渠道",
    highlights:"待维护",
    description:"待完善",
    priceType:item.referencePrice ? "资料参考价" : "未录入价格",
    price:item.referencePrice || "",
    originalPrice:item.referenceOriginalPrice || "",
    priceApplicableScope:item.referencePrice ? "以原始价目资料及审核结果为准" : "",
    priceApprovalStatus:item.referencePrice ? "待业务、医务与合规核验" : "暂无可匹配价格资料",
    priceOrigin:item.referencePrice ? "资料自动匹配" : "未匹配",
    priceEffectiveAt:"",
    priceExpiresAt:"",
    importSource:"华美智能体知识库_v1",
    importStatus:"待医务与合规审核",
    customerFacing:false,
    updatedAt:iso(-17)
  })),
  // 原始价目文件仅作为可追溯的证据资料，而非第二套价格运营表。
  // 正式价格、活动价和有效期统一维护在 products 的价格字段中。
  priceEvidenceSources: KNOWLEDGE_CATALOG_IMPORT.prices.map((item) => ({
    ...item,
    kind:"price_evidence_source",
    importSource:"华美智能体知识库_v1",
    customerFacing:false,
    updatedAt:iso(-17)
  })),
  legacyPriceReferences: [],
  physicians: KNOWLEDGE_CATALOG_IMPORT.physicians.map((item) => ({
    ...item, gender:"待核验", branch:"上海华美医疗美容医院（待院区核验）", status:"资料待审核",
    years:0, education:"待核验", hospitalTenure:"知识库原始资料导入", registrationNo:"待医务核验",
    registrationScope:"待医务核验", mobile:"待核验", schedule:"待排班核验", signatureProjects:item.specialties,
    consultationCount:0, satisfaction:0, avatar:null, avatarIndex:null, importSource:"华美智能体知识库_v1",
    importStatus:"待医务与合规审核", customerFacing:false, updatedAt:iso(-17)
  })),
  customers: [
    {
      id: "C-202608-001", name: "林知夏", age: 36, gender: "女", mobile: "138****4521", city: "上海·浦东",
      source: "百度咨询", firstChannel: "百度", latestChannel: "企业微信", owner: "周妍", agent: "AI邀约专员·小美",
      macroStage: "售前", microStage: "留资待预约", stageEnteredAt: iso(-2), sla: "剩余 1小时42分", score: 86, health: 82,
      photo: portrait("#f2c8b1", "#4b2e2b", "#8f263f", "#eed1d7"), photoConsent: "已授权", photoUpdatedAt: iso(-5),
      tags: ["高意向", "午间可联系", "重视自然感", "价格敏感"],
      interests: [{ name: "热玛吉", score: 92, trend: "+8" }, { name: "线雕", score: 68, trend: "+3" }, { name: "微拉美", score: 41, trend: "0" }],
      pains: ["担心松弛继续加重", "害怕恢复期影响工作"], itches: ["希望下颌缘更清晰", "想在周年纪念日前改善"], delights: ["医生解释清楚", "方案自然且不强推"],
      profile: { budget: "2–4万元", decision: "本人决策，需比较方案", contact: "工作日 12:00–13:30", style: "直接、专业、少营销", concern: "恢复期与自然度", confidence: 88 },
      nextAction: { title: "发送热玛吉到院评估说明并确认周三时段", reason: "连续两次询问恢复期；午间活跃；尚未解决价格范围", owner: "AI邀约专员·小美", channel: "企业微信", dueAt: iso(0, 3), status: "待执行", guardrail: "发送前人工确认价格口径" },
      journeys: [{ id: "J-01", name: "留资未预约培育", node: "价格顾虑分支", status: "运行中" }],
      timeline: [
        event("E-001", "conversation", "企微咨询：热玛吉恢复期", "客户询问多久可以正常见人，并强调近期工作会议较多。AI完成一般流程解释，未做适用性判断。", 0, -1, "AI获客顾问·小美", "企业微信", "positive"),
        event("E-002", "profile", "动态画像更新", "新增标签“午间可联系”；热玛吉兴趣 84 → 92；痛点新增“害怕恢复期影响工作”。", 0, -1, "画像引擎", "系统", "ai"),
        event("E-003", "lead", "百度留资并授权联系", "来自热玛吉项目卡片；授权企业微信客户服务与预约提醒。", -2, 1, "百度连接器", "百度", "neutral"),
        event("E-004", "task", "首次回访完成", "客户希望先了解大致流程和院内评估方式，暂未确认预约。", -1, -2, "周妍", "电话", "positive")
      ]
    },
    {
      id: "C-202608-002", name: "苏曼", age: 42, gender: "女", mobile: "186****7380", city: "上海·静安",
      source: "老客转介绍", firstChannel: "电话", latestChannel: "电话", owner: "陈露", agent: "AI接待助手·小华",
      macroStage: "售中", microStage: "到院面诊", stageEnteredAt: iso(0, -2), sla: "正常", score: 93, health: 91,
      photo: portrait("#efc3aa", "#2a2425", "#33465b", "#e4d8cf"), photoConsent: "已授权", photoUpdatedAt: iso(-12),
      tags: ["今日到院", "重视医生资历", "朋友推荐", "决策谨慎"],
      interests: [{ name: "拉皮/微拉美", score: 95, trend: "+4" }, { name: "线雕", score: 55, trend: "-6" }],
      pains: ["面中部下垂明显", "担心手术风险"], itches: ["希望长期改善", "看重医生案例经验"], delights: ["专人接待", "风险讲解透明"],
      profile: { budget: "8–15万元", decision: "与家人共同决策", contact: "晚间 19:00 后", style: "充分解释、给比较依据", concern: "医生资历与风险", confidence: 92 },
      nextAction: { title: "面诊结束后记录未解决顾虑并生成方案交接", reason: "已到院；需避免AI介入医疗方案；咨询师负责建立信任", owner: "陈露", channel: "线下", dueAt: iso(0, 2), status: "进行中", guardrail: "医疗内容仅记录医生结论引用" },
      journeys: [{ id: "J-02", name: "到院咨询协同", node: "面诊交接", status: "运行中" }],
      timeline: [
        event("E-101", "arrival", "客户已签到到院", "前台完成身份核验并通知咨询师陈露。", 0, -1, "前台/预约系统", "到院", "positive"),
        event("E-102", "handoff", "AI生成到院交接摘要", "汇总项目兴趣、医生资历顾虑、预算区间与家人共同决策信息。", 0, -1, "AI接待助手·小华", "系统", "ai"),
        event("E-103", "appointment", "预约确认", "周一 10:30 拉皮/微拉美到院评估；客户服务授权有效。", -3, 2, "陈露", "电话", "positive")
      ]
    },
    {
      id: "C-202608-003", name: "唐欣怡", age: 31, gender: "女", mobile: "159****2966", city: "杭州·上城",
      source: "官网自然流量", firstChannel: "官网", latestChannel: "官网", owner: "方琳", agent: "AI获客顾问·小美",
      macroStage: "售前", microStage: "需求澄清", stageEnteredAt: iso(-1), sla: "已超时 28分", score: 64, health: 58,
      photo: portrait("#f0cbb7", "#713e32", "#c38c72", "#f0dfd2"), photoConsent: "待确认", photoUpdatedAt: null,
      tags: ["跨城客户", "首次医美", "信息收集中"],
      interests: [{ name: "线雕", score: 77, trend: "+12" }, { name: "热玛吉", score: 62, trend: "+7" }],
      pains: ["不了解项目差异", "担心疼痛"], itches: ["希望轮廓紧致", "想了解非手术方式"], delights: ["不催促留资", "解释通俗"],
      profile: { budget: "未确认", decision: "本人初步了解", contact: "晚间", style: "科普优先", concern: "疼痛与项目差异", confidence: 71 },
      nextAction: { title: "人工接管：解释项目差异并澄清期望", reason: "客户询问‘我适不适合线雕’，触发医疗边界转人工", owner: "方琳", channel: "官网", dueAt: iso(0, 0), status: "已超时", guardrail: "不得判断适用性，需建议到院由医生评估" },
      journeys: [{ id: "J-03", name: "新线索黄金响应", node: "医疗问题转人工", status: "暂停" }],
      timeline: [
        event("E-201", "risk", "触发医疗边界转人工", "客户询问“我这种情况适不适合做线雕？”AI停止自动回答并创建人工任务。", 0, -2, "合规守门员", "官网", "risk"),
        event("E-202", "conversation", "官网咨询：线雕与热玛吉区别", "AI引用已发布知识解释原理和一般流程，不提供个体方案。", -1, 1, "AI获客顾问·小美", "官网", "ai")
      ]
    },
    {
      id: "C-202607-188", name: "顾清雅", age: 39, gender: "女", mobile: "133****0188", city: "上海·徐汇",
      source: "企业微信", firstChannel: "企微", latestChannel: "企业微信", owner: "周妍", agent: "AI售后关怀·安安",
      macroStage: "售后", microStage: "普通随访", stageEnteredAt: iso(-7), sla: "正常", score: 79, health: 88,
      photo: portrait("#eec2a8", "#3a2928", "#765a70", "#ded6e2"), photoConsent: "已授权", photoUpdatedAt: iso(-30),
      tags: ["热玛吉已完成", "恢复正常", "高满意度", "可转介绍"],
      interests: [{ name: "热玛吉", score: 88, trend: "0" }, { name: "眼周管理", score: 45, trend: "+9" }],
      pains: ["担心效果维持"], itches: ["关注眼周精细改善"], delights: ["随访及时", "隐私保护到位"],
      profile: { budget: "3–5万元/年", decision: "本人决策", contact: "周末下午", style: "关怀式、不过度营销", concern: "维持周期", confidence: 90 },
      nextAction: { title: "发送第7天一般随访问卷", reason: "处于标准随访时间点；无异常信号；客户授权有效", owner: "AI售后关怀·安安", channel: "企业微信", dueAt: iso(0, 1), status: "待执行", guardrail: "异常选项立即停止并升级售后/医务" },
      journeys: [{ id: "J-04", name: "项目后随访", node: "第7天问卷", status: "运行中" }],
      timeline: [
        event("E-301", "followup", "第3天普通随访完成", "客户反馈恢复正常，无异常描述，满意度 9/10。", -4, 3, "AI售后关怀·安安", "企业微信", "positive"),
        event("E-302", "treatment", "热玛吉项目完成", "项目完成信息已由工作人员登记，待业务系统接入后自动同步。", -7, 0, "售后中心", "系统", "neutral")
      ]
    },
    {
      id: "C-202606-092", name: "叶岚", age: 47, gender: "女", mobile: "177****6312", city: "苏州·工业园",
      source: "抖音留资", firstChannel: "抖音", latestChannel: "电话", owner: "陈露", agent: "AI复购顾问·悦悦",
      macroStage: "售后", microStage: "复购窗口", stageEnteredAt: iso(-4), sla: "剩余 18小时", score: 74, health: 69,
      photo: portrait("#e9bfa9", "#302829", "#5d745e", "#d7e4d5"), photoConsent: "已撤回", photoUpdatedAt: iso(-40),
      tags: ["线雕老客", "跨城", "关注维持", "营销授权有效"],
      interests: [{ name: "线雕", score: 72, trend: "-3" }, { name: "拉皮/微拉美", score: 67, trend: "+14" }],
      pains: ["维持时间不确定", "跨城到院成本"], itches: ["希望更长期方案"], delights: ["能一次说清后续计划"],
      profile: { budget: "5–10万元", decision: "需与家人讨论", contact: "周末", style: "方案比较、少频次触达", concern: "维持与跨城", confidence: 84 },
      nextAction: { title: "人工电话了解长期改善计划", reason: "复购窗口开启；对拉皮/微拉美兴趣上升；不适合自动营销", owner: "陈露", channel: "电话", dueAt: iso(1, 0), status: "待执行", guardrail: "照片授权已撤回，不展示历史照片" },
      journeys: [{ id: "J-05", name: "复购窗口培育", node: "人工意向确认", status: "运行中" }],
      timeline: [
        event("E-401", "consent", "客户撤回照片授权", "停止展示历史照片并记录审计；不影响客户服务授权。", -3, 1, "叶岚", "企业微信", "risk"),
        event("E-402", "profile", "复购兴趣变化", "拉皮/微拉美兴趣由 53 升至 67，来源于电话沟通摘要。", -4, 0, "画像引擎", "系统", "ai")
      ]
    },
    {
      id: "C-202608-006", name: "沈微澜", age: 34, gender: "女", mobile: "180****8307", city: "上海·闵行",
      source: "百度咨询", firstChannel: "百度", latestChannel: "企业微信", owner: "方琳", agent: "AI邀约专员·小美",
      macroStage: "售前", microStage: "沉默培育", stageEnteredAt: iso(-9), sla: "正常", score: 51, health: 44,
      photo: portrait("#f3ceb8", "#292323", "#b86b58", "#ead1c8"), photoConsent: "未上传", photoUpdatedAt: null,
      tags: ["已读未回", "价格顾虑", "夜间活跃"],
      interests: [{ name: "热玛吉", score: 69, trend: "-8" }, { name: "线雕", score: 39, trend: "0" }],
      pains: ["预算不确定"], itches: ["希望活动前改善"], delights: ["价格透明"],
      profile: { budget: "1–3万元", decision: "本人决策", contact: "21:00 后", style: "简短，不连续追问", concern: "价格", confidence: 76 },
      nextAction: { title: "等待至晚间再发送一次价值型内容", reason: "连续静默6天；夜间活跃；需遵守频控并避免价格诱导", owner: "AI邀约专员·小美", channel: "企业微信", dueAt: iso(0, 12), status: "计划中", guardrail: "本周最后一次自动触达" },
      journeys: [{ id: "J-06", name: "沉默客户唤醒", node: "等待窗口", status: "运行中" }],
      timeline: [event("E-501", "journey", "进入沉默培育", "连续72小时未回复，自动退出邀约旅程并进入低频培育。", -6, 0, "旅程引擎", "系统", "neutral")]
    }
  ],
  tasks: [
    { id: "T-001", customerId: "C-202608-003", title: "人工接管：线雕适用性问题", type: "AI转人工", priority: "紧急", dueAt: iso(0, -1), assignee: "方琳", status: "待处理", reason: "医疗边界", source: "官网会话" },
    { id: "T-002", customerId: "C-202608-001", title: "确认热玛吉到院评估时段", type: "待邀约", priority: "高", dueAt: iso(0, 3), assignee: "周妍", status: "待处理", reason: "高意向", source: "下一最佳动作", sourceCode: "next_best_action" },
    { id: "T-003", customerId: "C-202608-002", title: "面诊后完成咨询交接记录", type: "到院", priority: "高", dueAt: iso(0, 2), assignee: "陈露", status: "进行中", reason: "今日到院", source: "预约系统" },
    { id: "T-004", customerId: "C-202607-188", title: "审核第7天随访问卷", type: "AI审批", priority: "中", dueAt: iso(0, 1), assignee: "周妍", status: "待审批", reason: "自动触达", source: "旅程" },
    { id: "T-005", customerId: "C-202606-092", title: "电话了解长期改善计划", type: "复购", priority: "中", dueAt: iso(1), assignee: "陈露", status: "待处理", reason: "复购窗口", source: "下一最佳动作", sourceCode: "next_best_action" },
    { id: "T-006", customerId: "C-202608-006", title: "晚间价值内容触达", type: "沉默唤醒", priority: "低", dueAt: iso(0, 12), assignee: "AI邀约专员·小美", status: "计划中", reason: "夜间活跃", source: "旅程" }
  ],
  conversations: [
    { id: "V-01", customerId: "C-202608-003", channel: "官网", status: "待人工", unread: 3, mode: "人工", lastMessage: "那我这种情况适不适合做线雕？", updatedAt: iso(0, -2), messages: [
      { from: "customer", text: "线雕和热玛吉主要有什么区别？", at: iso(-1, 1) },
      { from: "ai", text: "两者在作用方式、一般流程和恢复安排上有所不同。我可以先为您做项目科普，但具体是否适合仍需要医生结合实际情况评估。", at: iso(-1, 1) },
      { from: "customer", text: "那我这种情况适不适合做线雕？", at: iso(0, -2) },
      { from: "system", text: "触发医疗适用性规则，AI已停止自动回答并转人工。", at: iso(0, -2) }
    ] },
    { id: "V-02", customerId: "C-202608-001", channel: "企业微信", status: "AI处理中", unread: 1, mode: "AI辅助", lastMessage: "周三中午能过去吗？", updatedAt: iso(0, -1), messages: [
      { from: "customer", text: "热玛吉做完多久可以正常见人？", at: iso(0, -2) },
      { from: "ai", text: "多数人会先安排院内评估，具体恢复感受因人而异。我可以把一般流程和到院评估说明发给您，具体安排以医生评估为准。", at: iso(0, -2) },
      { from: "customer", text: "周三中午能过去吗？", at: iso(0, -1) }
    ] },
    { id: "V-03", customerId: "C-202607-188", channel: "企业微信", status: "待审批", unread: 0, mode: "AI辅助", lastMessage: "目前都挺正常的，谢谢关心", updatedAt: iso(-4, 3), messages: [
      { from: "ai", text: "您好，想简单了解一下这几天的恢复感受。如有任何明显不适，请及时联系工作人员，由专业人员协助处理。", at: iso(-4, 3) },
      { from: "customer", text: "目前都挺正常的，谢谢关心", at: iso(-4, 3) }
    ] },
    { id: "V-04", customerId: "C-202608-006", channel: "企业微信", status: "静默", unread: 0, mode: "AI", lastMessage: "我先考虑下价格", updatedAt: iso(-6), messages: [
      { from: "customer", text: "我先考虑下价格", at: iso(-6) },
      { from: "ai", text: "好的，不着急。您之后如果想了解到院评估流程或项目差异，随时告诉我。", at: iso(-6) }
    ] }
  ],
  journeys: [
    { id: "J-01", name: "留资未预约培育", stage: "售前", status: "运行中", version: "v1.4", members: 0, conversion: 28.6, owner: "运营中心", updatedAt: iso(-2), nodes: ["留资", "授权检查", "黄金5分钟", "兴趣分支", "人工邀约", "预约成功/低频培育"] },
    { id: "J-03", name: "新线索黄金响应", stage: "售前", status: "运行中", version: "v2.1", members: 0, conversion: 41.2, owner: "在线咨询组", updatedAt: iso(-1), nodes: ["新咨询", "身份识别", "知识回答", "医疗边界", "留资", "预约"] },
    { id: "J-02", name: "到院咨询协同", stage: "售中", status: "运行中", version: "v1.2", members: 0, conversion: 57.1, owner: "到院咨询组", updatedAt: iso(-3), nodes: ["预约确认", "到院提醒", "签到", "AI交接摘要", "面诊", "成交/未成交培育"] },
    { id: "J-04", name: "项目后随访", stage: "售后", status: "运行中", version: "v1.8", members: 0, conversion: 92.4, owner: "售后中心", updatedAt: iso(-1), nodes: ["项目完成", "第1天", "第3天", "第7天", "异常分支", "满意度"] },
    { id: "J-05", name: "复购窗口培育", stage: "售后", status: "草稿", version: "v0.9", members: 0, conversion: 0, owner: "会员运营", updatedAt: iso(0), nodes: ["复购窗口", "授权检查", "兴趣识别", "人工确认", "到院评估"] },
    { id: "J-06", name: "沉默客户唤醒", stage: "售前", status: "运行中", version: "v1.0", members: 0, conversion: null, owner: "在线咨询组", updatedAt: iso(-6), nodes: ["沉默识别", "授权检查", "联系时机", "价值内容", "人工复核", "低频培育"] }
  ],
  agents: [
    { id: "A-01", name: "AI获客顾问·小美", role: "项目科普与需求识别", status: "运行中", level: "在规则范围内自动执行", levelCode: "L2_CONTROLLED", activeCustomers: 128, todayActions: 376, successRate: 94.8, takeoverRate: 12.1, knowledge: "项目知识 v3.2", lastEval: 96, skills: ["项目讲解", "需求澄清", "留资引导"], forbidden: ["医疗诊断", "适用性判断", "效果承诺"] },
    { id: "A-02", name: "AI邀约专员·小美", role: "预约推进与提醒", status: "运行中", level: "在规则范围内自动执行", levelCode: "L2_CONTROLLED", activeCustomers: 96, todayActions: 214, successRate: 91.3, takeoverRate: 8.6, knowledge: "邀约策略 v2.6", lastEval: 94, skills: ["时段推荐", "预约提醒", "沉默培育"], forbidden: ["私自报价", "高频触达", "诊疗建议"] },
    { id: "A-03", name: "AI接待助手·小华", role: "到院交接与信息汇总", status: "运行中", level: "经工作人员确认后执行", levelCode: "L1_APPROVAL", activeCustomers: 34, todayActions: 61, successRate: 98.1, takeoverRate: 4.2, knowledge: "到院流程 v1.9", lastEval: 97, skills: ["交接摘要", "签到提醒", "信息补全"], forbidden: ["面诊方案", "价格承诺"] },
    { id: "A-04", name: "AI售后关怀·安安", role: "普通随访与异常识别", status: "运行中", level: "经工作人员确认后执行", levelCode: "L1_APPROVAL", activeCustomers: 87, todayActions: 128, successRate: 95.6, takeoverRate: 15.8, knowledge: "随访知识 v2.2", lastEval: 98, skills: ["一般问卷", "满意度", "异常升级"], forbidden: ["异常处置", "用药建议", "结果判断"] },
    { id: "A-05", name: "AI复购顾问·悦悦", role: "复购窗口与会员关怀", status: "试运行", statusCode: "pilot", level: "经工作人员确认后执行", levelCode: "L1_APPROVAL", activeCustomers: 22, todayActions: 18, successRate: 88.2, takeoverRate: 18.4, knowledge: "复购策略 v0.9", lastEval: 89, skills: ["窗口识别", "兴趣变化", "人工推荐"], forbidden: ["自动优惠", "医疗推荐"] },
    {
      id: "A-06", name: "合规守门员", role: "内容与动作风险控制",
      responsibilities: ["客户回复与动作风险控制", "医疗边界拦截", "审计留痕"],
      status: "运行中", statusCode: "active", level: "核心合规控制（不可停用）", levelCode: "L4_MANDATORY",
      systemManaged: true, mandatory: true, allowDisable: false, allowDelete: false,
      activeCustomers: 0, todayActions: 742, successRate: 99.4, takeoverRate: 0,
      knowledge: "合规规则 v4.1",
      knowledgeScope: {
        labels: ["合规控制规则", "医疗边界规则", "隐私与授权规则"],
        knowledgeIds: ["K-005"],
        projectScopes: ["通用"],
        releaseRequirement: "仅可读取已准入且在有效期内的知识"
      },
      owner: "医务与合规负责人", ownerId: "HM-COMPLIANCE-SYSTEM", version: "v4.1",
      evaluationGate: { suite: "一期固定回归集", minimumScore: 98, lastScore: 99, status: "通过", evidenceRef: "合规控制基线" },
      evaluationThreshold: 98, lastEval: 99,
      skills: ["风险拦截", "医疗边界", "审计记录"],
      forbidden: ["关闭核心门禁", "绕过医疗与隐私规则"],
      disabledCapabilities: ["关闭核心门禁", "绕过医疗与隐私规则"]
    }
  ],
  knowledge: [
    ...projectKnowledge,
    { id: "K-004", title: "项目后普通随访问卷", project: "售后", layer: "客户沟通知识", layerCode: "L3_CUSTOMER", status: "已发布", version: "2.2", risk: "H1", riskCode: "H1", riskLabel: "常规审核", owner: "售后中心", updatedAt: iso(-2), coverage: 96, excerpt: "只采集感受与满意度；任何异常描述立即停止自动化。" },
    { id: "K-005", title: "价格与效果承诺禁用表达", project: "通用", layer: "合规控制规则", layerCode: "L4_CONTROL", status: "已发布", version: "4.1", risk: "H1", riskCode: "H1", riskLabel: "常规审核", owner: "合规部", updatedAt: iso(0, -2), coverage: 100, excerpt: "拦截安全无痛、永久、一定有效、最低价等绝对化和诱导性表达。" }
  ],
  connectors: [
    { id: "I-01", name: "CRM", vendor: "待配置", status: "待接入", statusCode: "not_connected", direction: "双向", lastSync: null, latency: "—", successRate: null, records: 0, telemetryAvailable: false, connectionMessage: "尚未配置连接信息", icon: "database" },
    { id: "I-02", name: "预约系统", vendor: "待配置", status: "待接入", statusCode: "not_connected", direction: "双向", lastSync: null, latency: "—", successRate: null, records: 0, telemetryAvailable: false, connectionMessage: "尚未配置连接信息", icon: "calendar" },
    { id: "I-03", name: "收银系统", vendor: "待配置", status: "待接入", statusCode: "not_connected", direction: "读取", lastSync: null, latency: "—", successRate: null, records: 0, telemetryAvailable: false, connectionMessage: "尚未配置连接信息", icon: "wallet" },
    { id: "I-04", name: "企业微信", vendor: "企业微信", status: "待接入", statusCode: "not_connected", direction: "双向", lastSync: null, latency: "—", successRate: null, records: 0, telemetryAvailable: false, connectionMessage: "尚未配置连接信息", icon: "message" },
    { id: "I-05", name: "百度/官网", vendor: "百度/时代之美官网", status: "待接入", statusCode: "not_connected", direction: "写入", lastSync: null, latency: "—", successRate: null, records: 0, telemetryAvailable: false, connectionMessage: "尚未配置连接信息", icon: "globe" }
  ],
  audit: [
    { id: "L-01", at: iso(0, -1), actor: "合规守门员", action: "拦截回答", object: "V-01", result: "触发个体适用性规则", severity: "高" },
    { id: "L-02", at: iso(0, -2), actor: "管理员·许宁", action: "发布规则", object: "K-005 v4.1", result: "成功", severity: "低" },
    { id: "L-03", at: iso(-1), actor: "周妍", action: "查看客户照片", object: "C-202608-001", result: "授权有效", severity: "中" },
    { id: "L-04", at: iso(-3), actor: "叶岚", action: "撤回照片授权", object: "C-202606-092", result: "历史照片停止展示", severity: "高" }
  ]
};

// `initialState` 仍保留给既有的页面回归测试与资料整理脚本使用，其中含有
// 早期演示用的客户、会话和经营样例。管理后台运行时绝不能把这些样例当成
// 真实业务记录，因此通过这个受控基线明确剥离它们：只保留用户提供的知识库
// 导入成果，以及运营人员后续在服务端新建、审核和维护的真实数据。
//
// 这里不“补造”产品编码、负责人、售价或医生履历。原始资料没有给出的字段
// 保持为空或待审核，避免 UI 把推测信息包装为医院经营事实。
const cloneManagementBaseline = (value) => JSON.parse(JSON.stringify(value));

export const createLocalManagementBaseline = () => {
  const state = cloneManagementBaseline(initialState);
  state.meta = {
    ...state.meta,
    runtimeDataMode:"server_persisted",
    sourceBaseline:"华美智能体知识库_v1",
    lastSync:null
  };
  state.currentRole = "管理员";

  // 后台用户和各类业务记录只能由已认证的操作者、真实售前留资或后续连接器
  // 写入，绝不带入演示账号。两项固定角色属于系统权限基线而非业务样例，必须
  // 保留，才能让新建后台用户只能选择一期已批准的两类角色。
  state.managementUsers = [];
  state.managementRoles = clonePhaseOneManagementRoles();
  state.configurationRecords = [];
  state.customers = [];
  state.tasks = [];
  state.conversations = [];
  state.journeys = [];
  state.agents = [];
  state.connectors = [];
  state.audit = [];
  state.handovers = [];
  // K-004/K-005 were early UI-only demonstrations rather than source-imported
  // knowledge units. Do not carry them into an operational knowledge base.
  state.knowledge = state.knowledge.filter((item) => item?.sourceId);

  state.products = state.products.map((item) => {
    const sourcePrice = String(item.referencePrice || item.price || "").trim();
    const sourceOriginalPrice = String(item.referenceOriginalPrice || item.originalPrice || "").trim();
    return {
      ...item,
      productCode:"",
      owner:"",
      highlights:"",
      description:"",
      salesStatus:sourcePrice ? "待审核" : "待完善",
      status:"待审核",
      approvalStatus:"待审核",
      priceCount:sourcePrice ? 1 : 0,
      priceType:sourcePrice ? "资料参考价" : "未录入价格",
      price:sourcePrice,
      originalPrice:sourceOriginalPrice,
      priceApplicableScope:sourcePrice ? "以原始价目资料与审核结果为准" : "",
      priceApprovalStatus:sourcePrice ? "待业务、医务与合规核验" : "暂无可匹配价格资料",
      priceOrigin:sourcePrice ? "资料自动匹配" : "未匹配",
      priceEffectiveAt:"",
      priceExpiresAt:"",
      customerFacing:false,
      updatedAt:item.updatedAt || ""
    };
  });
  state.physicians = state.physicians.map((item) => ({
    ...item,
    customerFacing:false,
    updatedAt:item.updatedAt || ""
  }));
  return state;
};

export const stageSteps = {
  售前: ["首次咨询", "需求澄清", "有效留资", "留资待预约", "已预约", "沉默培育"],
  售中: ["预约确认", "到院签到", "到院面诊", "方案沟通", "成交/支付", "项目完成"],
  售后: ["普通随访", "异常处理", "满意度", "复购窗口", "会员培育", "转介绍"]
};

export const riskWords = ["适不适合", "禁忌", "治疗参数", "异常", "红肿", "疼痛", "用药", "永久", "一定有效", "保证安全", "无痛", "最低价"];

export const chartData = {
  funnel: [
    { label: "新增咨询", value: 1280, rate: 100 }, { label: "有效留资", value: 896, rate: 70 },
    { label: "预约", value: 412, rate: 32.2 }, { label: "到院", value: 286, rate: 22.3 }, { label: "成交", value: 168, rate: 13.1 }
  ],
  weekly: [42, 58, 51, 76, 69, 88, 94],
  channels: [
    { name: "百度", leads: 468, appointments: 152, rate: 32.5 }, { name: "企业微信", leads: 312, appointments: 126, rate: 40.4 },
    { name: "官网", leads: 204, appointments: 57, rate: 27.9 }, { name: "转介绍", leads: 126, appointments: 62, rate: 49.2 },
    { name: "其他", leads: 170, appointments: 15, rate: 8.8 }
  ],
  projects: [
    { name: "热玛吉", interest: 438, appointment: 142, arrival: 96 }, { name: "线雕", interest: 326, appointment: 91, arrival: 68 },
    { name: "拉皮/微拉美", interest: 214, appointment: 78, arrival: 51 }
  ]
};
