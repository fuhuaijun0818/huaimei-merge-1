import { readLocalConversations, localConversationView } from "./local-conversation-store.mjs";
import { hasPhaseOneCapability } from "./platform/phase-one-role-policy.mjs";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTenantId } from "./platform/tenant-context.mjs";
import { postgres, postgresPersistenceEnabled } from "./persistence/postgres-helpers.mjs";
import { getPostgresLeadStore } from "./persistence/postgres-lead-store.mjs";
import { persistDevelopmentMemoryContact, resetDevelopmentContactVaultForTest } from "./contact-vault.mjs";
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
const cleanText = (value, limit = 500) => redactContactPii(String(value || ""))
  .replace(/[<>]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);

export const normalizeMobile = (value = "") => String(value)
  .replace(/^\+?86/, "")
  .replace(/[\s()-]/g, "");

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
  const finishMemberCheck = async result => {
    let memberCheck;
    try { memberCheck=await memberCheckClient.check({tenantId,sessionId,mobile,subjectReferenceHmac:identity,verification,name:cleanText(payload.name,40),previous:previousMemberCheck}); }
    catch { memberCheck={schema:"huamei.member-repeatcheck.v1",provider:"huamei_repeatcheck",status:"failed",is_repeat:null,member_status:"unknown",reason_code:"PROVIDER_UNAVAILABLE",attempted_at:new Date().toISOString(),checked_at:null}; }
    try {
      if(postgresPersistenceEnabled()) {
        const current=await getPostgresLeadStore().updateMemberCheck({tenantId,identity,captureId,memberCheck});
        if(current) result.lead=publicLead(current);
      } else {
        const update=async()=>{ const state=await readState(); const lead=state.leads.find(v=>v.tenant_id===tenantId&&v.phone_hash===identity);
          if(lead?.customer?.memberCheck?.capture_id===captureId){lead.customer.memberCheck=memberCheck; await writeState(state);result.lead=publicLead(lead);} };
        const pending=mutationQueue.then(update,update);mutationQueue=pending.then(()=>undefined,()=>undefined);await pending;
      }
    } catch { /* Capture is already durable. Preserve pending status for reconciliation. */ }
    return result;
  };
  const buildLead = async (existing) => {
    const now = new Date().toISOString();
    const messages = normalizeMessages(payload.messages);
    const interests = normalizeInterests(payload.interests);
    const interestScores = mergeInterestScores(existing?.customer?.interests, interests);
    const signals = inferCustomerSignals(messages, interests);
    const customerId = existing?.customer?.id || stableId("C-AI", identity, 10);
    // An omitted name is valid lead data. Do not fabricate a customer name
    // from the phone suffix; presentation layers may show a placeholder.
    const name = cleanText(payload.name, 40) || existing?.customer?.name || "";
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
    const identityDetail = existing
      ? "手机号强标识哈希与已有档案一致，系统已合并本次咨询，不创建重复客户。"
      : "客户授权提供手机号，系统以手机号强标识建立唯一客户360档案。";
    const timelineEvent = {
      id:stableId("E", `${identity}:${now}`, 14),
      type:"lead",
      title:existing ? "同一客户再次咨询，已合并客户360" : "获客顾问留资，创建客户360",
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
      messages
    };
    const conversations = [...(existing?.conversations || []).filter((item) => item.id !== conversationId), conversation]
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 20);
    const task = {
      id:stableId("T-AI", customerId, 10),
      customerId,
      title:`人工跟进：${interestScores[0].name}留资客户`,
      type:"待邀约",
      priority:"高",
      dueAt:customer.nextAction.dueAt,
      assignee:"在线咨询组",
      status:"待处理",
      reason:existing ? "同客再次咨询" : "新线索黄金响应",
      source:"AI获客顾问·小美"
    };
    const lead = {
      tenant_id:tenantId,
      phone_hash:identity,
      data_classification:dataClassification,
      created_at:createdAt,
      updated_at:now,
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

export async function acquisitionCustomerSnapshot(tenantId, { operationalOnly = false, principal = null, includeLiveConversations = false } = {}) {
  const tenant = normalizeTenantId(tenantId);
  const leads = postgresPersistenceEnabled()
    ? (await getPostgresLeadStore().snapshot(tenant)).map(publicLead)
    : (await readState()).leads.filter((item) => (item.tenant_id || tenant) === tenant).map(publicLead);
  leads.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  let scopedLeads=leads;
  if(principal && !hasPhaseOneCapability(principal,"customers:read_all")){
    const {listHandovers}=await import("./acquisition-operations-store.mjs");
    const owned=new Set((await listHandovers({tenant_id:tenant,limit:500}))
      .filter(h=>h.assignee===principal.subject && (principal.departmentIds?.includes("*")||principal.departmentIds?.includes(h.department)))
      .map(h=>h.conversation_id));
    scopedLeads=leads.filter(l=>(l.conversations||[]).some(c=>owned.has(c.externalConversationId)))
      .map(l=>({...l,conversations:(l.conversations||[]).filter(c=>owned.has(c.externalConversationId))}));
  }
  const classifiedLeads = scopedLeads.map((lead) => ({ ...lead, data_classification:leadDataClassification(lead) }));
  const visibleLeads = operationalOnly
    ? classifiedLeads.filter((lead) => lead.data_classification !== "test")
    : classifiedLeads;
  const liveRows=includeLiveConversations ? readLocalConversations(tenant) : [];
  const {listHandovers}=await import('./acquisition-operations-store.mjs');
  const handovers=liveRows.length?await listHandovers({tenant_id:tenant,limit:500}):[];
  const views=liveRows.filter(row=>!principal || hasPhaseOneCapability(principal,'customers:read_all') || handovers.some(h=>h.conversation_id===row.externalId&&h.assignee===principal.subject&&(principal.departmentIds?.includes('*')||principal.departmentIds?.includes(h.department)))).map(row=>{
    const lead=visibleLeads.find(l=>(l.conversations||[]).some(c=>c.externalConversationId===row.externalId));
    const task=handovers.find(h=>h.conversation_id===row.externalId&&['pending','claimed'].includes(h.status));
    return localConversationView(row,lead?.customer,task);
  });
  const liveExternalIds=new Set(views.map(v=>v.conversation.externalConversationId));
  return {
    customers:[...visibleLeads.map((item) => ({ ...item.customer, dataClassification:item.data_classification })),...views.filter(v=>!visibleLeads.some(l=>l.customer.id===v.customer.id)).map(v=>v.customer)],
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
