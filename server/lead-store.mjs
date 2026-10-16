import { appendPersistedHumanReply, readPersistedConversations, localConversationView, recordPersistedHumanReplyDelivery } from "./local-conversation-store.mjs";
import { hasPhaseOneCapability } from "./platform/phase-one-role-policy.mjs";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTenantId } from "./platform/tenant-context.mjs";
import { postgres, postgresPersistenceEnabled } from "./persistence/postgres-helpers.mjs";
import { getPostgresLeadStore } from "./persistence/postgres-lead-store.mjs";
import { persistDevelopmentMemoryContact, readDevelopmentContactCapture, resetDevelopmentContactVaultForTest } from "./contact-vault.mjs";
import { redactContactPii } from "./platform/contact-pii-redaction.mjs";
import { getMemberRepeatCheckClient } from "./integrations/member-repeatcheck-client.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const configuredStoreFile = String(process.env.HUAMEI_LEAD_STORE_FILE || "").trim();
const storeFile = configuredStoreFile === ":memory:"
  ? null
  : isAbsolute(configuredStoreFile)
    ? configuredStoreFile
    : join(projectRoot, configuredStoreFile || ".local-data/acquisition-leads.json");
let memoryState = { version:2, leads:[], candidates:[] };
let mutationQueue = Promise.resolve();

const clone = (value) => JSON.parse(JSON.stringify(value));
const openHandoverStatus = (status) => ["pending", "claimed", "active"].includes(status);
const cleanText = (value, limit = 500) => redactContactPii(String(value || ""))
  .replace(/[<>]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);

// Operators paste numbers from chat, CRM exports and e-mail signatures, so the
// accepted shapes are "+86 138 0000 0001", "0086 138-0000-0001" and
// "13800000001".  Everything normalizes to the same eleven mainland digits and
// no other input is silently truncated: unparsable values are returned as their
// digits so validation can reject them explicitly.
const mobileDigits = (value = "") => String(value ?? "").normalize("NFKC").replace(/\D/g, "");
export const normalizeMobile = (value = "") => {
  const digits = mobileDigits(value);
  if (/^1[3-9]\d{9}$/.test(digits)) return digits;
  return digits.replace(/^(?:00)?86/, "");
};

export const isValidMainlandMobile = (value = "") => /^1[3-9]\d{9}$/.test(normalizeMobile(value));

const maskMobile = (mobile) => `${mobile.slice(0, 3)}****${mobile.slice(-4)}`;
const stableId = (prefix, value, length = 12) => `${prefix}-${createHash("sha256").update(String(value)).digest("hex").slice(0, length).toUpperCase()}`;

const readState = async () => {
  if (!storeFile) return clone(memoryState);
  try {
    const parsed = JSON.parse(await readFile(storeFile, "utf8"));
    return {
      version:2,
      leads:Array.isArray(parsed.leads) ? parsed.leads : [],
      candidates:Array.isArray(parsed.candidates) ? parsed.candidates : []
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version:2, leads:[], candidates:[] };
  }
};

const writeState = async (state) => {
  if (!storeFile) {
    memoryState = clone(state);
    return;
  }
  await mkdir(dirname(storeFile), { recursive:true });
  const temporaryFile = `${storeFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { encoding:"utf8", mode:0o600 });
  await rename(temporaryFile, storeFile);
};

const normalizeInterests = (values = []) => [...new Set(values
  .map((value) => typeof value === "string" ? value : value?.name)
  .map((value) => cleanText(value, 40).replace(/[｜|]\s*项目知识.*$/, "").trim())
  .filter((value) => value && value !== "待识别"))].slice(0, 6);

const normalizeMessages = (values = []) => values.slice(-16).map((message, index) => ({
  id:cleanText(message.id, 80) || `M-${index + 1}`,
  from:message.role === "user" || message.from === "customer" ? "customer" : "ai",
  text:cleanText(message.content || message.text, 1200),
  at:message.at && !Number.isNaN(Date.parse(message.at)) ? new Date(message.at).toISOString() : new Date().toISOString()
})).filter((message) => message.text);

const inferCustomerSignals = (messages, interests) => {
  const customerText = messages.filter((message) => message.from === "customer").map((message) => message.text).join(" ");
  const pains = [];
  const itches = [];
  if (/(松弛|下垂|皱纹|法令纹)/.test(customerText)) pains.push("关注面部松弛与轮廓变化");
  if (/(暗沉|发黄|色斑|痘印)/.test(customerText)) pains.push("关注肤色暗沉与肤质状态");
  if (/(疼|痛|恢复|风险)/.test(customerText)) pains.push("担心体验、恢复期或风险");
  if (/(区别|对比|怎么选)/.test(customerText)) pains.push("需要理解项目差异");
  if (/(提升|紧致|抗老|抗衰)/.test(customerText)) itches.push("希望获得紧致与轮廓改善信息");
  if (/(提亮|美白|嫩肤)/.test(customerText)) itches.push("希望改善肤色与肤质观感");
  if (!pains.length) pains.push("具体顾虑待人工进一步澄清");
  if (!itches.length) itches.push(interests.length ? `希望深入了解${interests[0]}` : "希望获得项目知识讲解");
  return {
    pains:pains.slice(0, 3),
    itches:itches.slice(0, 3),
    delights:["讲解清楚且不做强推", "可随时转人工继续咨询"],
    concern:pains[0]
  };
};

const mergeInterestScores = (previous = [], incoming = []) => {
  const scores = new Map(previous.map((item) => [item.name, item]));
  incoming.forEach((name, index) => {
    const current = scores.get(name);
    const nextScore = Math.max(current?.score || 0, 86 - index * 8);
    scores.set(name, { name, score:nextScore, trend:current ? `+${Math.max(1, nextScore - current.score)}` : "+12" });
  });
  const merged = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  return merged.length ? merged : [{ name:"待进一步识别", score:55, trend:"+5" }];
};

const publicLead = (lead) => {
  const { phone_hash: _phoneHash, ...safe } = lead;
  return clone(safe);
};

// 质检不是客户运营岗位。质量视图必须在服务端生成，不能依赖浏览器隐藏
// 联系方式、备注或会话正文。对于无法确定脱敏安全性的自由文本，一律不给出
// 原文；这也意味着将来新增字段时不会默认落入质量视图。
const qualityRedactedPrincipal = (principal) => Boolean(principal)
  && hasPhaseOneCapability(principal, "conversations:read_redacted")
  && !hasPhaseOneCapability(principal, "customers:read_all")
  && !hasPhaseOneCapability(principal, "customers:read_assigned");

const validIsoOrNull = (value) => {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const redactedQualityConversation = (tenantId, conversation = {}) => {
  const sourceId = String(conversation.externalConversationId || conversation.id || "");
  const customerId = String(conversation.customerId || sourceId || "anonymous");
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  return {
    id:stableId("QCON", `${tenantId}:${sourceId}`, 24),
    customer_reference:stableId("QCU", `${tenantId}:${customerId}`, 24),
    channel:cleanText(conversation.channel || "web", 48) || "web",
    updated_at:validIsoOrNull(conversation.updatedAt || conversation.updated_at),
    message_count:messages.length,
    last_message:"[会话内容已脱敏]",
    content_redacted:true,
    messages:messages.map((message, index) => ({
      id:stableId("QMSG", `${tenantId}:${sourceId}:${message?.id || index}`, 24),
      from:["customer", "ai", "staff"].includes(message?.from) ? message.from : "system",
      at:validIsoOrNull(message?.at),
      text:"[会话内容已脱敏]",
      content_redacted:true
    }))
  };
};

const qualityHandoverInScope = (handover, principal) => {
  const departments = Array.isArray(principal?.departmentIds) ? principal.departmentIds : [];
  // 没有归属科室的历史记录不能被有限科室的质检账号读取；只有全院范围
  // 才可读取，并且仍然仅返回下方的脱敏投影。
  return departments.includes("*") || Boolean(handover?.department && departments.includes(handover.department));
};

const profileVersionOf = (lead) => Math.max(1, Number(lead?.profile_version || lead?.customer?.profileVersion || 1));

const profileUpdateError = (code, message, status = 409, details = []) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};

const normalizeProfileUpdate = (patch = {}) => {
  const result = {};
  if (Object.hasOwn(patch, "name")) {
    const name = cleanText(patch.name, 40);
    if (String(patch.name || "").trim().length > 40) throw profileUpdateError("INVALID_CUSTOMER_NAME", "称呼不能超过40个字符", 400);
    result.name = name;
  }
  if (Object.hasOwn(patch, "mobile") && String(patch.mobile || "").trim()) {
    const mobile = normalizeMobile(patch.mobile);
    if (!isValidMainlandMobile(mobile)) throw profileUpdateError("INVALID_MOBILE", "请输入有效的11位中国大陆手机号", 400);
    result.mobile = mobile;
  }
  if (patch.profile && typeof patch.profile === "object" && !Array.isArray(patch.profile)) {
    result.profile = {};
    for (const key of ["budget", "decision", "contact", "style", "concern"]) {
      if (Object.hasOwn(patch.profile, key)) result.profile[key] = cleanText(patch.profile[key], 240);
    }
  }
  if (patch.contact_preferences && typeof patch.contact_preferences === "object" && !Array.isArray(patch.contact_preferences)) {
    // 只写入本次明确提交的子字段，其余保留原值：联系偏好是逐项口径，
    // 部分更新不应该把没提到的“禁止联系/时段/备注”清空。
    const preferences = {};
    if (Object.hasOwn(patch.contact_preferences, "preferred_time")) {
      preferences.preferred_time = cleanText(patch.contact_preferences.preferred_time, 80);
    }
    if (Object.hasOwn(patch.contact_preferences, "preferred_channels")) {
      preferences.preferred_channels = Array.isArray(patch.contact_preferences.preferred_channels)
        ? [...new Set(patch.contact_preferences.preferred_channels.map((item) => cleanText(item, 40)).filter(Boolean))].slice(0, 6)
        : [];
    }
    if (Object.hasOwn(patch.contact_preferences, "do_not_contact")) {
      preferences.do_not_contact = Boolean(patch.contact_preferences.do_not_contact);
    }
    if (Object.hasOwn(patch.contact_preferences, "note")) {
      preferences.note = cleanText(patch.contact_preferences.note, 240);
    }
    if (Object.keys(preferences).length) result.contactPreferences = preferences;
  }
  if (Object.hasOwn(patch, "customer_note")) {
    const customerNote = cleanText(patch.customer_note, 500);
    if (!customerNote) throw profileUpdateError("CUSTOMER_NOTE_REQUIRED", "请填写客户备注内容", 400);
    result.customerNote = customerNote;
  }
  if (Object.hasOwn(patch, "tags")) {
    const tags = Array.isArray(patch.tags) ? patch.tags : String(patch.tags || "").split(/[、,，]/);
    result.tags = [...new Set(tags.map((item) => cleanText(item, 40)).filter(Boolean))].slice(0, 10);
  }
  return result;
};

const changedProfileFields = (patch) => [
  ...(Object.hasOwn(patch, "name") ? ["name"] : []),
  ...(Object.hasOwn(patch, "mobile") ? ["mobile"] : []),
  ...(patch.profile ? Object.keys(patch.profile).map((key) => `profile.${key}`) : []),
  ...(patch.contactPreferences ? ["contact_preferences"] : []),
  ...(patch.customerNote ? ["customer_note"] : []),
  ...(Object.hasOwn(patch, "tags") ? ["tags"] : [])
];

const DATA_CLASSIFICATIONS = new Set(["production", "test", "unclassified"]);
const explicitTestName = (value = "") => /(测试|演示|样例|样本|fixture|sample|\btest\b)/i.test(cleanText(value, 80));

// Historical local records predate data classification.  Only records with an
// explicit test marker in the customer name are classified automatically; all
// other historical records remain unclassified until an operator reviews them.
// This keeps operations data safe without silently treating real customers as
// test data.
export const leadDataClassification = (lead = {}) => {
  const stored = String(lead.data_classification || lead.customer?.dataClassification || "").trim();
  if (DATA_CLASSIFICATIONS.has(stored)) return stored;
  return explicitTestName(lead.customer?.name) ? "test" : "unclassified";
};

const identityPepper = (env = process.env) => String(
  env.HUAMEI_IDENTITY_PEPPER || "times-beauty-local-mvp-v1"
);

export const mobileIdentityHmac = (mobile, tenantId, env = process.env) => createHmac(
  "sha256",
  identityPepper(env)
).update(`${tenantId}:${normalizeMobile(mobile)}`).digest("hex");

const candidateSessionReferenceHash = (tenantId, sessionId, env = process.env) => createHmac(
  "sha256",
  identityPepper(env)
).update(`lead-candidate-session:${tenantId}:${sessionId}`).digest("hex");

const formatValidatedCapture = ({ tenantId, identity, sessionId }) => Object.freeze({
  schema:"huamei.contact-capture.v1",
  verified:false,
  status:"pending_manual",
  method:"format_validation",
  tenant_id:tenantId,
  subject_reference_hmac:identity,
  session_id:sessionId,
  verification_id:stableId("format", `${tenantId}:${identity}:${sessionId}`, 32),
  captured_at:new Date().toISOString()
});

const publicCandidate = (candidate) => ({
  candidate_id:candidate.candidate_id,
  masked_mobile:candidate.masked_mobile,
  verification_status:"unverified",
  created_at:candidate.created_at,
  updated_at:candidate.updated_at
});

export async function upsertAcquisitionLead(payload = {}, { memberCheckClient = getMemberRepeatCheckClient() } = {}) {
  const tenantId = normalizeTenantId(payload.tenant_id);
  const mobile = normalizeMobile(payload.mobile);
  if (!isValidMainlandMobile(mobile)) {
    const error = new Error("请输入有效的11位中国大陆手机号");
    error.code = "INVALID_MOBILE";
    throw error;
  }
  if (payload.service_consent !== true) {
    const error = new Error("需要同意本次咨询服务联系授权");
    error.code = "SERVICE_CONSENT_REQUIRED";
    throw error;
  }
  const sessionId = cleanText(payload.session_id, 128) || `candidate-${randomUUID()}`;
  const normalizedPayload = { ...payload, session_id:sessionId };
  const identity = mobileIdentityHmac(mobile, tenantId);
  const sessionReferenceHash = candidateSessionReferenceHash(tenantId, sessionId);
  const verification = formatValidatedCapture({ tenantId, identity, sessionId });

  const captureId=randomUUID();
  let previousMemberCheck;
  const memberCheckFailure = (reasonCode) => ({
    schema:"huamei.member-repeatcheck.v1", provider:"huamei_repeatcheck", status:"failed",
    is_repeat:null, member_status:"unknown", reason_code:reasonCode,
    attempted_at:new Date().toISOString(), checked_at:null, capture_id:captureId
  });
  const finishMemberCheck = async result => {
    let memberCheck;
    try { memberCheck=await memberCheckClient.check({tenantId,sessionId,mobile,subjectReferenceHmac:identity,verification,name:cleanText(payload.name,40),previous:previousMemberCheck}); }
    catch { memberCheck=memberCheckFailure("PROVIDER_UNAVAILABLE"); }
    try {
      if(postgresPersistenceEnabled()) {
        const current=await getPostgresLeadStore().updateMemberCheck({tenantId,identity,captureId,memberCheck});
        if(current) result.lead=publicLead(current);
      } else {
        const update=async()=>{ const state=await readState(); const lead=state.leads.find(v=>v.tenant_id===tenantId&&v.phone_hash===identity);
          if(lead?.customer?.memberCheck?.capture_id===captureId){lead.customer.memberCheck={ ...memberCheck, capture_id:captureId }; await writeState(state);result.lead=publicLead(lead);} };
        const pending=mutationQueue.then(update,update);mutationQueue=pending.then(()=>undefined,()=>undefined);await pending;
      }
    } catch { /* Capture is already durable. Preserve pending status for reconciliation. */ }
    result.member_check_status = memberCheck.status;
    return result;
  };
  const buildLead = async (existing) => {
    const now = new Date().toISOString();
    const messages = normalizeMessages(payload.messages);
    const interests = normalizeInterests(payload.interests);
    const interestScores = mergeInterestScores(existing?.customer?.interests, interests);
    const signals = inferCustomerSignals(messages, interests);
    const customerId = existing?.customer?.id || stableId("C-AI", identity, 10);
    // A stored 禁止联系 preference stops any new proactive callback task; the
    // customer may keep consulting online and no callback is promised.
    if (existing?.customer?.contactPreferences?.do_not_contact === true) {
      throw profileUpdateError("PRIVACY_CONTACT_SUPPRESSED", "当前联系偏好不允许新建人工回访，您仍可继续在线咨询", 409);
    }
    // An omitted name is valid lead data. Do not fabricate a customer name
    // from the phone suffix; presentation layers may show a placeholder.
    // A public capture is not authoritative enough to replace a stored name:
    // keep the existing name and create a review record when the two disagree.
    const submittedName = cleanText(payload.name, 40);
    const existingName = cleanText(existing?.customer?.name, 40);
    const hasNameConflict = Boolean(existing && submittedName && existingName && submittedName !== existingName);
    const name = hasNameConflict ? existingName : submittedName || existingName;
    const dataClassification = existing
      ? leadDataClassification(existing)
      : "production";
    // Commit the capture before any external lookup. A slow provider must never
    // hold a lead/consent transaction or prevent the phone from being stored.
    previousMemberCheck = existing?.customer?.memberCheck;
    const memberCheck = {schema:"huamei.member-repeatcheck.v1",provider:"huamei_repeatcheck",
      status:"pending",is_repeat:null,member_status:"unknown",reason_code:null,
      attempted_at:now,checked_at:null,capture_id:captureId};
    const conversationId = stableId("V-AI", `${identity}:${sessionId}`, 10);
    const latestCustomerMessage = [...messages].reverse().find((message) => message.from === "customer")?.text || "客户完成在线留资";
    const createdAt = existing?.created_at || now;
    const nameConflict = hasNameConflict ? {
      id:stableId("NC", `${identity}:${sessionId}:${submittedName}`, 16),
      status:"pending_manual",
      existing_name:existingName,
      submitted_name:submittedName,
      session_id:sessionId,
      source:"获客顾问 Web",
      captured_at:now
    } : null;
    const priorNameConflicts = Array.isArray(existing?.customer?.nameConflicts)
      ? existing.customer.nameConflicts
      : [];
    const nameConflicts = nameConflict
      ? [nameConflict, ...priorNameConflicts.filter((item) => item?.id !== nameConflict.id)].slice(0, 20)
      : priorNameConflicts.slice(0, 20);
    const hasPendingNameConflict = nameConflicts.some((item) => item?.status === "pending_manual");
    const identityDetail = hasNameConflict
      ? `手机号强标识哈希与已有档案一致，但本次称呼“${submittedName}”与现有称呼“${existingName}”不一致；已保留原称呼，待人工复核。`
      : existing
      ? "手机号强标识哈希与已有档案一致，系统已合并本次咨询，不创建重复客户。"
      : "客户授权提供手机号，系统以手机号强标识建立唯一客户360档案。";
    const timelineEvent = {
      id:stableId("E", `${identity}:${now}`, 14),
      type:hasNameConflict ? "profile" : "lead",
      title:hasNameConflict ? "姓名信息冲突，待人工复核" : existing ? "同一客户再次咨询，已合并客户360" : "获客顾问留资，创建客户360",
      detail:`${identityDetail} 主要兴趣：${interestScores.slice(0, 3).map((item) => item.name).join("、")}。`,
      occurredAt:now,
      actor:"AI获客顾问·小美",
      channel:"获客顾问 Web",
      tone:"ai"
    };
    const conversationEvent = {
      id:stableId("E", `${conversationId}:${now}`, 14),
      type:"conversation",
      title:"在线项目咨询已沉淀",
      detail:`最近问题：${latestCustomerMessage}`,
      occurredAt:now,
      actor:"AI获客顾问·小美",
      channel:"获客顾问 Web",
      tone:"positive"
    };
    const customer = {
      ...(existing?.customer || {}),
      id:customerId,
      origin:"acquisition_advisor",
      dataClassification,
      name,
      age:existing?.customer?.age || null,
      gender:existing?.customer?.gender || "待补充",
      mobile:maskMobile(mobile),
      city:existing?.customer?.city || "待补充",
      source:"AI获客顾问 Web",
      firstChannel:existing?.customer?.firstChannel || "获客顾问 Web",
      latestChannel:"获客顾问 Web",
      owner:existing?.customer?.owner || "在线咨询组",
      agent:"AI获客顾问·小美",
      macroStage:"售前",
      microStage:"留资待预约",
      stageEnteredAt:existing?.customer?.stageEnteredAt || createdAt,
      sla:"剩余 30分钟",
      score:Math.min(92, (existing?.customer?.score || 68) + (existing ? 3 : 4)),
      health:existing?.customer?.health || 70,
      photo:null,
      photoConsent:"未上传",
      photoUpdatedAt:null,
      tags:[...new Set([...(existing?.customer?.tags || []), "AI获客", "已留资", "待人工跟进", ...interestScores.slice(0, 2).map((item) => `关注${item.name}`)])].slice(0, 8),
      interests:interestScores,
      pains:[...new Set([...(existing?.customer?.pains || []), ...signals.pains])].slice(0, 4),
      itches:[...new Set([...(existing?.customer?.itches || []), ...signals.itches])].slice(0, 4),
      delights:[...new Set([...(existing?.customer?.delights || []), ...signals.delights])].slice(0, 4),
      profile:{
        budget:existing?.customer?.profile?.budget || "待确认",
        decision:existing?.customer?.profile?.decision || "本人初步了解",
        contact:existing?.customer?.profile?.contact || "已授权人工顾问联系，具体时段待确认",
        style:existing?.customer?.profile?.style || "先科普、后人工跟进",
        concern:signals.concern,
        confidence:Math.min(88, (existing?.customer?.profile?.confidence || 58) + (existing ? 4 : 8))
      },
      nextAction:{
        title:`30分钟内人工回访，继续说明${interestScores[0].name}并确认到院评估意愿`,
        reason:"客户已完成手机号留资并授权本次咨询联系；应延续当前兴趣，避免重复询问已沟通信息。",
        owner:"在线咨询组",
        channel:"电话",
        dueAt:new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        status:"待执行",
        guardrail:"仅用于本次咨询服务；不得自动判断个体适用性或发送未授权营销内容"
      },
      journeys:[{ id:"J-01", name:"新线索黄金响应", node:"留资后30分钟人工跟进", status:"运行中" }],
      serviceConsent:true,
      marketingConsent:false,
      phoneVerificationStatus:"pending_manual",
      memberCheck,
      nameConflicts,
      profileVersion:Math.max(1, Number(existing?.customer?.profileVersion || existing?.profile_version || 1)),
      timeline:[timelineEvent, conversationEvent, ...(existing?.customer?.timeline || [])].slice(0, 80)
    };
    const conversation = {
      id:conversationId,
      externalConversationId:sessionId,
      customerId,
      channel:"获客顾问 Web",
      status:"待人工",
      mode:"AI辅助",
      unread:1,
      updatedAt:now,
      lastMessage:latestCustomerMessage,
      // 表单/接口留资可能不带聊天记录：留一条系统说明，接待工作台就不会出现空白会话。
      messages:messages.length ? messages : [{
        id:`lead-${sessionId}`,
        from:"system",
        text:"客户通过留资表单提交了联系方式，本次未附带聊天记录。",
        at:now
      }]
    };
    const conversations = [...(existing?.conversations || []).filter((item) => item.id !== conversationId), conversation]
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 20);
    const task = {
      id:stableId("T-AI", customerId, 10),
      customerId,
      title:hasPendingNameConflict ? "人工复核：客户姓名冲突" : `人工跟进：${interestScores[0].name}留资客户`,
      type:hasPendingNameConflict ? "人工资料复核" : "待邀约",
      priority:"高",
      dueAt:customer.nextAction.dueAt,
      assignee:"在线咨询组",
      status:"待处理",
      reason:hasPendingNameConflict ? "同一手机号提交了不同姓名；请人工核对后再更正客户称呼。" : existing ? "同客再次咨询" : "新线索黄金响应",
      source:"AI获客顾问·小美"
    };
    const lead = {
      tenant_id:tenantId,
      phone_hash:identity,
      data_classification:dataClassification,
      created_at:createdAt,
      updated_at:now,
      profile_version:Math.max(1, Number(existing?.profile_version || existing?.customer?.profileVersion || 1)),
      interactions:(existing?.interactions || 0) + 1,
      customer,
      conversations,
      task
    };
    return lead;
  };
  if (postgresPersistenceEnabled()) {
    const result = await getPostgresLeadStore().upsert({
      tenantId,
      identity,
      payload:normalizedPayload,
      buildLead,
      verification,
      candidateSessionReferenceHash:sessionReferenceHash
    });
    return finishMemberCheck({ ...result, verification_status:"pending_manual", lead:publicLead(result.lead) });
  }
  const operation = async () => {
    const state = await readState();
    const existingIndex = state.leads.findIndex((item) => item.tenant_id === tenantId && item.phone_hash === identity);
    const existing = existingIndex >= 0 ? state.leads[existingIndex] : null;
    const lead = await buildLead(existing);
    if (existingIndex >= 0) state.leads[existingIndex] = lead;
    else state.leads.unshift(lead);
    await writeState(state);
    const contact = persistDevelopmentMemoryContact({
      tenantId,
      sessionId,
      mobile,
      subjectReferenceHmac:identity,
      verification
    });
    return {
      verification_status:"pending_manual",
      is_existing:Boolean(existing),
      matched_by:"mobile_hash",
      lead:publicLead(lead),
      contact
    };
  };
  const resultPromise = mutationQueue.then(operation, operation);
  mutationQueue = resultPromise.then(() => undefined, () => undefined);
  return finishMemberCheck(await resultPromise);
}

// Update an already captured customer profile.  This is deliberately separate
// from public lead capture: operators may correct facts only with an explicit
// expected profile version, and a phone change creates a fresh member-check
// capture instead of carrying the previous hospital result forward.
export async function updateAcquisitionCustomer({
  tenant_id, customer_id, patch = {}, expected_version, actor = "当前用户", source = "management"
} = {}, { memberCheckClient = getMemberRepeatCheckClient() } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const customerId = cleanText(customer_id, 120);
  if (!customerId) throw profileUpdateError("CUSTOMER_ID_REQUIRED", "客户编号不能为空", 400);
  const normalizedPatch = normalizeProfileUpdate(patch);
  if (!Object.keys(normalizedPatch).length) throw profileUpdateError("NO_CUSTOMER_CHANGES", "没有可保存的客户资料变更", 400);
  const suppliedVersion = expected_version === undefined || expected_version === null || expected_version === ""
    ? null : Number(expected_version);
  if (suppliedVersion !== null && (!Number.isInteger(suppliedVersion) || suppliedVersion < 1)) {
    throw profileUpdateError("INVALID_PROFILE_VERSION", "客户资料版本无效", 400);
  }

  if (postgresPersistenceEnabled()) {
    const result = await getPostgresLeadStore().updateCustomer({
      tenantId, customerId, patch:normalizedPatch, expectedVersion:suppliedVersion,
      actor:cleanText(actor, 160), source:cleanText(source, 80)
    });
    if (!result?.lead) throw profileUpdateError("CUSTOMER_NOT_FOUND", "未找到客户档案", 404);
    if (!result.phoneChanged) return { status:"accepted", member_check_status:result.lead.customer?.memberCheck?.status, lead:publicLead(result.lead) };
    const mobile = result.mobile;
    const verification = result.verification;
    let memberCheck;
    try {
      memberCheck = await memberCheckClient.check({
        tenantId, sessionId:result.sessionId, mobile, subjectReferenceHmac:result.identity,
        verification, name:result.lead.customer?.name, previous:undefined
      });
    } catch {
      memberCheck = { schema:"huamei.member-repeatcheck.v1", provider:"huamei_repeatcheck", status:"failed",
        is_repeat:null, member_status:"unknown", reason_code:"PROVIDER_UNAVAILABLE",
        attempted_at:new Date().toISOString(), checked_at:null, capture_id:verification.verification_id };
    }
    const updated = await getPostgresLeadStore().updateMemberCheck({
      tenantId, identity:result.identity, captureId:verification.verification_id, memberCheck
    });
    return { status:"accepted", member_check_status:memberCheck.status, lead:publicLead(updated || result.lead) };
  }

  let updateResult;
  const operation = async () => {
    const state = await readState();
    const index = state.leads.findIndex((item) => item.tenant_id === tenantId && item.customer?.id === customerId);
    if (index < 0) throw profileUpdateError("CUSTOMER_NOT_FOUND", "未找到客户档案", 404);
    const current = state.leads[index];
    const currentVersion = profileVersionOf(current);
    if (suppliedVersion !== null && suppliedVersion !== currentVersion) {
      throw profileUpdateError("PROFILE_VERSION_CONFLICT", "客户资料已被其他人员更新，请刷新后重试", 409, [{ expected_version:suppliedVersion, current_version:currentVersion }]);
    }
    // Full phone values are intentionally never kept in the public lead
    // document. A non-empty mobile patch is therefore always treated as an
    // explicit replacement and is rechecked independently.
    const mobile = normalizedPatch.mobile || "";
    const phoneChanged = Boolean(normalizedPatch.mobile);
    const identity = mobileIdentityHmac(mobile, tenantId);
    if (phoneChanged && state.leads.some((item, itemIndex) => itemIndex !== index && item.tenant_id === tenantId && item.phone_hash === identity)) {
      throw profileUpdateError("MOBILE_ALREADY_LINKED", "该手机号已关联其他客户，请先核对客户档案", 409);
    }
    const now = new Date().toISOString();
    const nextVersion = currentVersion + 1;
    const changed = changedProfileFields(normalizedPatch);
    const profileUpdate = { version:nextVersion, fields:changed, source:cleanText(source, 80) || "management",
      actor:cleanText(actor, 160) || "当前用户", at:now };
    const customerNote = normalizedPatch.customerNote ? {
      id:stableId("N", `${customerId}:note:${now}`, 14), customer_id:customerId,
      content:normalizedPatch.customerNote, author:cleanText(actor, 160) || "当前用户",
      created_at:now, source:cleanText(source, 80) || "management"
    } : null;
    const priorPreferences = current.customer?.contactPreferences || {};
    const customer = {
      ...current.customer,
      ...(Object.hasOwn(normalizedPatch, "name") ? { name:normalizedPatch.name } : {}),
      ...(phoneChanged ? {
        mobile:maskMobile(mobile), phoneVerificationStatus:"pending_manual",
        memberCheck:{ schema:"huamei.member-repeatcheck.v1", provider:"huamei_repeatcheck", status:"pending",
          is_repeat:null, member_status:"unknown", reason_code:null, attempted_at:now, checked_at:null,
          capture_id:randomUUID()
        }
      } : {}),
      ...(normalizedPatch.profile ? { profile:{ ...(current.customer?.profile || {}), ...normalizedPatch.profile } } : {}),
      ...(normalizedPatch.contactPreferences ? { contactPreferences:{ ...priorPreferences, ...normalizedPatch.contactPreferences,
        updated_at:now, updated_by:cleanText(actor, 160), source:cleanText(source, 80) } } : {}),
      ...(customerNote ? { customerNotes:[customerNote, ...(current.customer?.customerNotes || [])].slice(0, 100) } : {}),
      ...(normalizedPatch.tags ? { tags:normalizedPatch.tags } : {}),
      profileVersion:nextVersion,
      profileUpdatedAt:now,
      profileUpdatedBy:cleanText(actor, 160),
      profileUpdateSource:cleanText(source, 80),
      profileUpdateHistory:[profileUpdate, ...(current.customer?.profileUpdateHistory || [])].slice(0, 50)
    };
    const event = {
      id:stableId("E", `${customerId}:${customerNote ? "note" : "profile"}:${now}`, 14), type:customerNote ? "note" : "profile", title:customerNote ? "新增客户备注" : "客户资料由人工更正",
      detail:customerNote ? customerNote.content : `已更新${changed.join("、")}。${phoneChanged ? "手机号变更后将重新查询会员状态。" : ""}`,
      occurredAt:now, actor:cleanText(actor, 160) || "当前用户", channel:cleanText(source, 80) || "管理后台", tone:"neutral",
      source:cleanText(source, 80) || "management", fields:changed
    };
    const next = {
      ...current, phone_hash:phoneChanged ? identity : current.phone_hash, updated_at:now,
      profile_version:nextVersion, customer:{ ...customer, timeline:[event, ...(customer.timeline || [])].slice(0, 80) }
    };
    state.leads[index] = next;
    await writeState(state);
    if (phoneChanged) {
      const sessionId = cleanText(current.conversations?.[0]?.externalConversationId || `profile-${randomUUID()}`, 128);
      const captureId = next.customer.memberCheck.capture_id;
      const verificationBase = formatValidatedCapture({ tenantId, identity, sessionId });
      const verification = { ...verificationBase, verification_id:captureId };
      // Keep the durable contact capture aligned with the new identity. The
      // member check uses the same capture id and never reuses old results.
      for (const conversation of current.conversations || []) {
        const sessionId = cleanText(conversation.externalConversationId || conversation.id, 128);
        if (sessionId) persistDevelopmentMemoryContact({ tenantId, sessionId, mobile, subjectReferenceHmac:identity,
          verification:formatValidatedCapture({ tenantId, identity, sessionId }) });
      }
      updateResult = { lead:next, phoneChanged:true, mobile, identity, sessionId:verification.session_id, verification };
    } else updateResult = { lead:next, phoneChanged:false };
    return updateResult;
  };
  const pending = mutationQueue.then(operation, operation);
  mutationQueue = pending.then(() => undefined, () => undefined);
  const result = await pending;
  if (!result.phoneChanged) return { status:"accepted", lead:publicLead(result.lead), member_check_status:result.lead.customer?.memberCheck?.status };
  let memberCheck;
  try {
    memberCheck = await memberCheckClient.check({ tenantId, sessionId:result.sessionId, mobile:result.mobile,
      subjectReferenceHmac:result.identity, verification:result.verification, name:result.lead.customer?.name, previous:undefined });
  } catch {
    memberCheck = { schema:"huamei.member-repeatcheck.v1", provider:"huamei_repeatcheck", status:"failed", is_repeat:null,
      member_status:"unknown", reason_code:"PROVIDER_UNAVAILABLE", attempted_at:new Date().toISOString(), checked_at:null,
      capture_id:result.verification.verification_id };
  }
  const complete = async () => {
    const state = await readState();
    const lead = state.leads.find((item) => item.tenant_id === tenantId && item.phone_hash === result.identity);
    if (!lead || lead.customer?.memberCheck?.capture_id !== result.verification.verification_id) return null;
    lead.customer.memberCheck = memberCheck;
    await writeState(state);
    return lead;
  };
  const completion = mutationQueue.then(complete, complete);
  mutationQueue = completion.then(() => undefined, () => undefined);
  const lead = await completion;
  return { status:"accepted", member_check_status:memberCheck.status, lead:publicLead(lead || result.lead) };
}

const memberCheckStatusText = (check) => {
  if (!check) return "尚无查询结果";
  if (check.status === "checked") return check.result_semantics === "membership"
    ? (check.is_repeat ? "院方已有记录（会员）" : "院方无记录（非会员）")
    : (check.is_repeat ? "院方已有客户记录" : "院方未找到客户记录");
  if (check.status === "failed") return `查询失败（${check.reason_code || "PROVIDER_UNAVAILABLE"}）`;
  if (check.status === "not_configured") return "院方接口未配置";
  if (check.status === "capture_required") return "缺少有效的手机号保存记录";
  if (check.status === "pending") return "查询中";
  return "查询未完成";
};

// Manual, capability-checked re-query of the hospital directory.  It re-uses the
// capture currently bound to the stored number, runs a fresh query (no cached
// result), and writes back only while that same capture is still current, so an
// older number's result can never overwrite a newer number's state. The
// plaintext number is read from the contact vault inside the server and is never
// returned to the browser.
export async function recheckAcquisitionCustomerMember({
  tenant_id, customer_id, actor = "当前用户", request_id = null
} = {}, { memberCheckClient = getMemberRepeatCheckClient() } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const customerId = cleanText(customer_id, 120);
  const safeActor = cleanText(actor, 160) || "当前用户";
  const safeRequestId = cleanText(request_id, 120) || null;
  if (!customerId) throw profileUpdateError("CUSTOMER_ID_REQUIRED", "客户编号不能为空", 400);
  const now = new Date().toISOString();

  const runCheck = async ({ mobile, identity, sessionId, captureId, name, previous }) => {
    const verification = {
      ...formatValidatedCapture({ tenantId, identity, sessionId }),
      verification_id:captureId
    };
    try {
      const check = await memberCheckClient.check({
        tenantId, sessionId, mobile, subjectReferenceHmac:identity, verification,
        // Manual rechecks bypass a cached successful result, but preserve the
        // failure budget and retry-after time stored for this phone capture.
        name, previous, forceRefresh:true
      });
      return { ...check, capture_id:captureId };
    } catch {
      return {
        schema:"huamei.member-repeatcheck.v1", provider:"huamei_repeatcheck", status:"failed",
        is_repeat:null, member_status:"unknown", reason_code:"PROVIDER_UNAVAILABLE",
        attempted_at:now, checked_at:null, capture_id:captureId
      };
    }
  };

  if (postgresPersistenceEnabled()) {
    const target = await getPostgresLeadStore().readCustomerContactForMemberCheck({
      tenantId, customerId, actor:safeActor, requestId:safeRequestId
    });
    if (!target) throw profileUpdateError("CUSTOMER_NOT_FOUND", "未找到客户档案", 404);
    const memberCheck = await runCheck(target);
    const lead = await getPostgresLeadStore().updateMemberCheck({
      tenantId, identity:target.identity, captureId:target.captureId, memberCheck,
      timelineEvent:{
        id:stableId("E", `${customerId}:member-check:${now}`, 14),
        type:"member_check",
        title:"人工触发院方会员状态重查",
        detail:`查询结果：${memberCheckStatusText(memberCheck)}。仅用于本次咨询服务判断，不代表会员权益或手机号归属。`,
        occurredAt:now, actor:safeActor, channel:"管理后台", tone:memberCheck.status === "failed" ? "risk" : "neutral"
      }
    });
    if (!lead) throw profileUpdateError("MEMBER_CHECK_CAPTURE_STALE", "客户手机号已变更，请刷新后重新查询", 409);
    return { status:"accepted", member_check:memberCheck, member_check_status:memberCheck.status, lead:publicLead(lead) };
  }

  let target;
  const locate = async () => {
    const state = await readState();
    const lead = state.leads.find((item) => item.tenant_id === tenantId && item.customer?.id === customerId);
    if (!lead) throw profileUpdateError("CUSTOMER_NOT_FOUND", "未找到客户档案", 404);
    // 早期档案可能没有 capture 绑定，首次重查时补上，之后保持稳定。
    let captureId = lead.customer?.memberCheck?.capture_id;
    if (!captureId) {
      captureId = randomUUID();
      lead.customer.memberCheck = {
        schema:"huamei.member-repeatcheck.v1", provider:"huamei_repeatcheck", status:"pending",
        is_repeat:null, member_status:"unknown", reason_code:null,
        attempted_at:new Date().toISOString(), checked_at:null,
        ...(lead.customer?.memberCheck || {}), capture_id:captureId
      };
      await writeState(state);
    }
    const sessionId = (lead.conversations || [])
      .map((conversation) => cleanText(conversation.externalConversationId || conversation.id, 128))
      .filter(Boolean)
      .find((candidate) => readDevelopmentContactCapture({ tenantId, sessionId:candidate })?.subject_reference_hmac === lead.phone_hash);
    const mobile = sessionId ? readDevelopmentContactCapture({ tenantId, sessionId })?.value || "" : "";
    if (!mobile) {
      throw profileUpdateError("CONTACT_VAULT_UNAVAILABLE", "本机开发保险库中没有该号码，重新留资后可再次查询", 409);
    }
    target = {
      mobile, identity:lead.phone_hash, sessionId, captureId,
      name:lead.customer?.name || "", previous:lead.customer?.memberCheck
    };
    return target;
  };
  const located = mutationQueue.then(locate, locate);
  mutationQueue = located.then(() => undefined, () => undefined);
  await located;

  const memberCheck = await runCheck(target);
  const complete = async () => {
    const state = await readState();
    const lead = state.leads.find((item) => item.tenant_id === tenantId && item.phone_hash === target.identity);
    if (!lead || lead.customer?.memberCheck?.capture_id !== target.captureId) return null;
    lead.customer.memberCheck = { ...memberCheck, capture_id:target.captureId };
    lead.customer.timeline = [{
      id:stableId("E", `${customerId}:member-check:${now}`, 14),
      type:"member_check",
      title:"人工触发院方会员状态重查",
      detail:`查询结果：${memberCheckStatusText(memberCheck)}。仅用于本次咨询服务判断，不代表会员权益或手机号归属。`,
      occurredAt:now, actor:safeActor, channel:"管理后台", tone:memberCheck.status === "failed" ? "risk" : "neutral"
    }, ...(lead.customer.timeline || [])].slice(0, 80);
    lead.updated_at = now;
    await writeState(state);
    return lead;
  };
  const completion = mutationQueue.then(complete, complete);
  mutationQueue = completion.then(() => undefined, () => undefined);
  const lead = await completion;
  if (!lead) throw profileUpdateError("MEMBER_CHECK_CAPTURE_STALE", "客户手机号已变更，请刷新后重新查询", 409);
  return { status:"accepted", member_check:memberCheck, member_check_status:memberCheck.status, lead:publicLead(lead) };
}

// Append a staff reply to a captured acquisition conversation.  The message is
// stored in the same tenant-scoped lead document that powers both management
// views, so a refresh cannot discard the reply or recreate an unread item.
export async function appendAcquisitionConversationReply({ tenant_id, conversation_id, text, actor = "当前售前顾问", idempotency_key = "" } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const conversationId = cleanText(conversation_id, 160);
  const safeText = cleanText(text, 4000);
  const idempotencyKey = String(idempotency_key || "").trim().slice(0, 128);
  if (!conversationId || !safeText) {
    const error = new Error("会话和回复内容不能为空");
    error.code = "CONVERSATION_REPLY_REQUIRED";
    error.status = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const message = {
    id:`staff-${randomUUID()}`,
    from:"staff",
    text:safeText,
    at:now,
    actor:cleanText(actor, 120) || "当前售前顾问",
    // The key is tenant/conversation scoped by the caller.  Persisting it
    // alongside the message makes a retry safe even after the short-lived
    // request-coordination cache has been restarted.
    idempotency_key:idempotencyKey || null,
    delivery:{
      submission_status:"submitted",
      delivery_status:"pending",
      delivered_at:null,
      read_status:"not_reported",
      channel:"web"
    }
  };
  const updateLead = (lead) => {
    const index = (lead?.conversations || []).findIndex((conversation) =>
      conversation.id === conversationId || conversation.externalConversationId === conversationId
    );
    if (index < 0) return null;
    const currentConversation = lead.conversations[index];
    const existing = idempotencyKey
      ? (currentConversation.messages || []).find((item) => item.from === "staff" && item.idempotency_key === idempotencyKey)
      : null;
    if (existing) {
      if (existing.text !== safeText || existing.actor !== message.actor) {
        const error = new Error("同一发送标识不能用于不同的人工回复内容");
        error.code = "IDEMPOTENCY_PAYLOAD_MISMATCH";
        error.status = 409;
        throw error;
      }
      return { lead, conversation:currentConversation, message:existing, replayed:true };
    }
    const conversation = { ...currentConversation, messages:[...(currentConversation.messages || []), message], lastMessage:safeText, updatedAt:now, status:"人工处理中", mode:"人工", unread:0 };
    const conversations = lead.conversations.slice();
    conversations[index] = conversation;
    return {
      lead:{ ...lead, conversations, updated_at:now, customer:{ ...lead.customer, microStage:"人工跟进", latestChannel:lead.customer?.latestChannel || "获客顾问 Web", timeline:[{ id:`E-${Date.now()}`, type:"conversation", title:"人工回复已发送", detail:safeText, occurredAt:now, actor:message.actor, channel:conversation.channel, tone:"neutral" }, ...(lead.customer?.timeline || [])].slice(0, 80) } },
      conversation,
      message,
      replayed:false
    };
  };
  if (postgresPersistenceEnabled()) {
    const result = await getPostgresLeadStore().appendConversationReply({ tenantId, conversationId, message, updateLead });
    if (result) return { ...result, delivery:clone(result.message?.delivery || message.delivery), replayed:Boolean(result.replayed) };
    const persisted = await appendPersistedHumanReply({ tenant_id:tenantId, conversation_id:conversationId, message });
    if (persisted) return { ...persisted, delivery:clone(persisted.message?.delivery || message.delivery), replayed:Boolean(persisted.replayed) };
    const error = new Error("未找到可回复的获客顾问会话");
    error.code = "CONVERSATION_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  const resultPromise = mutationQueue.then(async () => {
    const state = await readState();
    const index = state.leads.findIndex((lead) => lead.tenant_id === tenantId && (lead.conversations || []).some((conversation) => conversation.id === conversationId || conversation.externalConversationId === conversationId));
    if (index < 0) return null;
    const next = updateLead(state.leads[index]);
    if (next.replayed) return next;
    state.leads[index] = next.lead;
    await writeState(state);
    return next;
  });
  mutationQueue = resultPromise.then(() => undefined, () => undefined);
  const updated = await resultPromise;
  if (!updated) {
    const persisted = await appendPersistedHumanReply({ tenant_id:tenantId, conversation_id:conversationId, message });
    if (persisted) return { ...persisted, delivery:clone(persisted.message?.delivery || message.delivery), replayed:Boolean(persisted.replayed) };
    const error = new Error("未找到可回复的获客顾问会话");
    error.code = "CONVERSATION_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  return {
    conversation:clone(updated.conversation),
    customer:clone(updated.lead.customer),
    message:clone(updated.message),
    delivery:clone(updated.message?.delivery || message.delivery),
    replayed:Boolean(updated.replayed)
  };
}

// The public history endpoint calls this only after it has resolved a signed
// browser session.  It returns no customer profile data, just staff messages
// for that exact public conversation.
export async function getAcquisitionConversationStaffMessages({ tenant_id, conversation_id } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const conversationId = cleanText(conversation_id, 160);
  if (!conversationId) return [];
  const leads = postgresPersistenceEnabled()
    ? (await getPostgresLeadStore().snapshot(tenantId)).map(publicLead)
    : (await readState()).leads.filter((item) => (item.tenant_id || tenantId) === tenantId).map(publicLead);
  const conversation = leads.flatMap((lead) => lead.conversations || [])
    .find((item) => item.id === conversationId || item.externalConversationId === conversationId);
  const staffMessages = (conversation?.messages || []).filter((message) => message?.from === "staff");
  if (staffMessages.length) return clone(staffMessages);
  const persisted = (await readPersistedConversations(tenantId)).find((item) => item.externalId === conversationId);
  return clone((persisted?.messages || []).filter((message) => message?.from === "staff"));
}

// A browser receipt means the authenticated public web client obtained this
// message through its history request. It is deliberately not a read receipt.
export async function recordAcquisitionConversationDelivery({ tenant_id, conversation_id, message_id } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const conversationId = cleanText(conversation_id, 160);
  const messageId = cleanText(message_id, 160);
  if (!conversationId || !messageId) {
    const error = new Error("会话和消息编号不能为空");
    error.code = "CONVERSATION_DELIVERY_REQUIRED";
    error.status = 400;
    throw error;
  }
  const deliveredAt = new Date().toISOString();
  const updateLead = (lead) => {
    const conversationIndex = (lead?.conversations || []).findIndex((conversation) =>
      conversation.id === conversationId || conversation.externalConversationId === conversationId
    );
    if (conversationIndex < 0) return null;
    const conversation = lead.conversations[conversationIndex];
    const messageIndex = (conversation.messages || []).findIndex((message) => message?.id === messageId && message?.from === "staff");
    if (messageIndex < 0) return null;
    const currentMessage = conversation.messages[messageIndex];
    const delivered = currentMessage.delivery?.delivery_status === "delivered";
    const message = {
      ...currentMessage,
      delivery:{
        ...(currentMessage.delivery || {}),
        submission_status:"submitted",
        delivery_status:"delivered",
        delivered_at:currentMessage.delivery?.delivered_at || deliveredAt,
        read_status:"not_reported",
        channel:"web"
      }
    };
    const messages = conversation.messages.slice();
    messages[messageIndex] = message;
    const conversations = lead.conversations.slice();
    conversations[conversationIndex] = { ...conversation, messages };
    return { lead:{ ...lead, conversations, updated_at:delivered ? lead.updated_at : deliveredAt }, message, replayed:delivered };
  };
  if (postgresPersistenceEnabled()) {
    const result = await getPostgresLeadStore().recordConversationDelivery({ tenantId, conversationId, messageId, updateLead });
    if (result) return result;
    const persisted = await recordPersistedHumanReplyDelivery({ tenant_id:tenantId, conversation_id:conversationId, message_id:messageId });
    if (persisted) return persisted;
    const error = new Error("未找到可确认送达的人工消息");
    error.code = "CONVERSATION_DELIVERY_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  const operation = mutationQueue.then(async () => {
    const state = await readState();
    const index = state.leads.findIndex((lead) => lead.tenant_id === tenantId && (lead.conversations || []).some((conversation) => conversation.id === conversationId || conversation.externalConversationId === conversationId));
    if (index < 0) return null;
    const next = updateLead(state.leads[index]);
    if (!next) return null;
    state.leads[index] = next.lead;
    await writeState(state);
    return { message:clone(next.message), replayed:next.replayed };
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  const result = await operation;
  if (!result) {
    const persisted = await recordPersistedHumanReplyDelivery({ tenant_id:tenantId, conversation_id:conversationId, message_id:messageId });
    if (persisted) return persisted;
    const error = new Error("未找到可确认送达的人工消息");
    error.code = "CONVERSATION_DELIVERY_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  return result;
}

export async function acquisitionCustomerSnapshot(tenantId, { operationalOnly = false, principal = null, includeLiveConversations = false } = {}) {
  const tenant = normalizeTenantId(tenantId);
  const leads = postgresPersistenceEnabled()
    ? (await getPostgresLeadStore().snapshot(tenant)).map(publicLead)
    : (await readState()).leads.filter((item) => (item.tenant_id || tenant) === tenant).map(publicLead);
  leads.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const {listHandovers}=await import("./acquisition-operations-store.mjs");
  const handovers=await listHandovers({tenant_id:tenant,limit:500});
  let scopedLeads=leads;
  const qualityView = qualityRedactedPrincipal(principal);
  if (qualityView) {
    const permittedConversationIds = new Set(handovers
      .filter((handover) => qualityHandoverInScope(handover, principal))
      .map((handover) => handover.conversation_id));
    scopedLeads = leads
      .filter((lead) => (lead.conversations || []).some((conversation) => permittedConversationIds.has(conversation.externalConversationId)))
      .map((lead) => ({
        ...lead,
        conversations:(lead.conversations || []).filter((conversation) => permittedConversationIds.has(conversation.externalConversationId))
      }));
  } else if(principal && !hasPhaseOneCapability(principal,"customers:read_all")){
    // Pending tasks have no assignee yet, so filtering to the current assignee
    // made every newly escalated web conversation disappear from a presales
    // workspace.  An unassigned task is claimable by the authorized operations
    // scope; legacy tasks without a department remain visible until routing
    // metadata is available.  Once claimed, it is restricted to that assignee.
    const canSeeHandover=(h) => {
      const inDepartment=principal.departmentIds?.includes("*") || !h.department || principal.departmentIds?.includes(h.department);
      return inDepartment && (h.assignee===principal.subject || (!h.assignee && openHandoverStatus(h.status)));
    };
    const owned=new Set(handovers
      .filter(canSeeHandover)
      .map(h=>h.conversation_id));
    scopedLeads=leads.filter(l=>(l.conversations||[]).some(c=>owned.has(c.externalConversationId)))
      .map(l=>({...l,conversations:(l.conversations||[]).filter(c=>owned.has(c.externalConversationId))}));
  }
  const classifiedLeads = scopedLeads.map((lead) => ({ ...lead, data_classification:leadDataClassification(lead) }));
  const visibleLeads = operationalOnly
    ? classifiedLeads.filter((lead) => lead.data_classification !== "test")
    : classifiedLeads;
  if (qualityView) {
    const permittedConversationIds = new Set(visibleLeads.flatMap((lead) => (lead.conversations || [])
      .map((conversation) => conversation.externalConversationId)));
    const archived = visibleLeads.flatMap((lead) => lead.conversations || []);
    const liveRows = includeLiveConversations ? await readPersistedConversations(tenant) : [];
    const conversationsBySourceId = new Map(archived.map((conversation) => [
      String(conversation.externalConversationId || conversation.id || ""), conversation
    ]));
    for (const row of liveRows) {
      if (!permittedConversationIds.has(row.externalId)) continue;
      const handover = handovers.find((item) => item.conversation_id === row.externalId);
      const view = localConversationView(row, undefined, handover);
      conversationsBySourceId.set(String(row.externalId), view.conversation);
    }
    return {
      customers:[],
      conversations:[...conversationsBySourceId.values()].map((conversation) => redactedQualityConversation(tenant, conversation)),
      tasks:[],
      meta:{
        tenant_id:tenant,
        total:visibleLeads.length,
        source_total:classifiedLeads.length,
        operational_only:Boolean(operationalOnly),
        excluded_test_total:classifiedLeads.filter((lead) => lead.data_classification === "test").length,
        unclassified_total:classifiedLeads.filter((lead) => lead.data_classification === "unclassified").length,
        view:"quality_redacted",
        plaintext_mobile_stored:false,
        updated_at:classifiedLeads[0]?.updated_at || null
      }
    };
  }
  // The customer snapshot is still useful when the independent appointment
  // persistence is temporarily unavailable.  Do not turn a read-only customer
  // refresh into a failure or synthesize an appointment from stale data.
  let appointmentCustomers = visibleLeads;
  try {
    const [{ listAppointmentIntakes }, { projectAppointmentsOntoCustomers }] = await Promise.all([
      import("./appointment-intake-store.mjs"),
      import("./appointment-customer-projection.mjs")
    ]);
    appointmentCustomers = projectAppointmentsOntoCustomers(
      visibleLeads,
      await listAppointmentIntakes({ tenant_id:tenant, limit:500 })
    );
  } catch {
    // The appointment queue reports its own availability.  Keep the authorized
    // customer snapshot available without claiming a time was synchronized.
  }
  const liveRows=includeLiveConversations ? await readPersistedConversations(tenant) : [];
  const views=liveRows.filter(row=>!principal || hasPhaseOneCapability(principal,'customers:read_all') || handovers.some(h=>h.conversation_id===row.externalId && ((h.assignee===principal.subject || (!h.assignee && openHandoverStatus(h.status))) && (principal.departmentIds?.includes('*')||!h.department||principal.departmentIds?.includes(h.department))))).map(row=>{
    const lead=visibleLeads.find(l=>(l.conversations||[]).some(c=>c.externalConversationId===row.externalId));
    const task=handovers.find(h=>h.conversation_id===row.externalId&&openHandoverStatus(h.status));
    const view=localConversationView(row,lead?.customer,task);
    // A persisted session is authoritative for customer and AI turns.  Human
    // replies are written to the lead archive, however; without this merge the
    // live projection masks the staff message immediately after a refresh.
    // Keep only staff rows from the lead document so earlier customer/AI turns
    // with different transport IDs are never rendered twice.
    const staffMessages=(lead?.conversations || [])
      .find((conversation) => conversation.externalConversationId === row.externalId)
      ?.messages?.filter((message) => message?.from === "staff") || [];
    const messageById=new Map();
    for (const message of [...(view.conversation.messages || []), ...staffMessages]) {
      if (message?.id && !messageById.has(message.id)) messageById.set(message.id, message);
    }
    const messages=[...messageById.values()].sort((left, right) =>
      Date.parse(left.at || 0) - Date.parse(right.at || 0)
    );
    const latest=messages.at(-1);
    return {
      ...view,
      conversation:{
        ...view.conversation,
        messages,
        lastMessage:latest?.text || view.conversation.lastMessage,
        updatedAt:latest?.at || view.conversation.updatedAt
      }
    };
  });
  const liveExternalIds=new Set(views.map(v=>v.conversation.externalConversationId));
  // 客户列表按“来的时间”（首次进入时间）倒序，最新客户排最前，无论它来自留资还是在线会话。
  const arrivalTime = (item) => Date.parse(item?.stageEnteredAt || item?.createdAt || "") || 0;
  const mergedCustomers = [
    ...appointmentCustomers.map((item) => ({ ...item.customer, dataClassification:item.data_classification })),
    ...views.filter((v) => !visibleLeads.some((l) => l.customer.id === v.customer.id)).map((v) => v.customer)
  ].sort((left, right) => arrivalTime(right) - arrivalTime(left));
  return {
    customers:mergedCustomers,
    conversations:[...visibleLeads.flatMap((item) => item.conversations || []).filter(c=>!liveExternalIds.has(c.externalConversationId)),...views.map(v=>v.conversation)],
    tasks:visibleLeads.map((item) => item.task).filter(Boolean),
    meta:{
      tenant_id:tenant,
      total:visibleLeads.length,
      source_total:classifiedLeads.length,
      operational_only:Boolean(operationalOnly),
      excluded_test_total:classifiedLeads.filter((lead) => lead.data_classification === "test").length,
      unclassified_total:classifiedLeads.filter((lead) => lead.data_classification === "unclassified").length,
      identity_rule:"tenant_scoped_normalized_mobile_hmac",
      plaintext_mobile_stored:false,
      updated_at:classifiedLeads[0]?.updated_at || null
    }
  };
}

// Appointment intake needs to know whether the current public conversation has
// a captured, service-authorized contact. It deliberately returns only a
// local opaque customer reference: no telephone, name, hash or existing/new
// customer signal may cross the public appointment boundary.
export async function getCapturedLeadReferenceForSession({ tenant_id, session_id } = {}) {
  const tenantId = normalizeTenantId(tenant_id);
  const sessionId = cleanText(session_id, 128);
  if (!sessionId) return null;
  if (postgresPersistenceEnabled()) {
    const rows = await postgres().tenantQuery(tenantId, `
      SELECT l.id, l.updated_at, c.phone_verification_status
      FROM conversation_sessions s
      JOIN leads l ON l.tenant_id=s.tenant_id AND l.id=s.lead_id
      JOIN contact_vault_entries c ON c.tenant_id=l.tenant_id AND c.lead_record_id=l.id
        AND c.status='active' AND c.contact_type='mobile'
        AND c.subject_reference_hmac=l.normalized_mobile_hmac
      WHERE s.tenant_id=$1 AND s.channel='web' AND (s.session_id=$2 OR s.external_conversation_id=$2)
        AND EXISTS (SELECT 1 FROM consents a WHERE a.tenant_id=l.tenant_id AND a.lead_record_id=l.id
          AND a.consent_type='service' AND a.is_current AND a.granted AND a.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM contact_suppressions x WHERE x.tenant_id=l.tenant_id
          AND x.subject_reference_hmac=l.normalized_mobile_hmac AND x.status='active' AND x.purpose IN ('service','all'))
      LIMIT 2`, [tenantId, sessionId]);
    const lead = rows.rows.length === 1 ? rows.rows[0] : null;
    return lead ? { customer_reference:stableId("APR", `${tenantId}:${lead.id}:${sessionId}`, 24),
      captured_at:lead.updated_at, phone_verification_status:lead.phone_verification_status } : null;
  }
  const state = await readState();
  const lead = state.leads.find((item) => item.tenant_id === tenantId
    && (item.conversations || []).some((conversation) => conversation.externalConversationId === sessionId));
  if (!lead?.customer?.id || lead.customer.serviceConsent !== true) return null;
  return {
    customer_reference:stableId("APR", `${tenantId}:${lead.customer.id}:${sessionId}`, 24),
    captured_at:lead.updated_at || null,
    phone_verification_status:lead.customer.phoneVerificationStatus || "pending_manual"
  };
}

export function resetLeadStoreForTest() {
  memoryState = { version:2, leads:[], candidates:[] };
  mutationQueue = Promise.resolve();
  resetDevelopmentContactVaultForTest();
}
