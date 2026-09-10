import { randomUUID } from "node:crypto";
import { normalizeAcquisitionSessionId } from "./acquisition-session.mjs";
import { tenantIdFromPayload } from "./platform/tenant-context.mjs";

// This file deliberately owns protocol normalization only. A configured
// channel is not the same thing as a message that has been delivered. Official
// webhook verification and outbound transport must be implemented by the
// channel-specific connector before an external message can be marked sent.
const CHANNEL_DEFINITIONS = Object.freeze([
  {
    id:"web",
    name:"网页应用",
    transport:"HTTP JSON",
    external:false,
    required_env:[]
  },
  {
    id:"wecom",
    name:"企业微信",
    transport:"官方 IM adapter",
    external:true,
    required_env:[
      "HUAMEI_CHANNEL_WECOM_CORP_ID",
      "HUAMEI_CHANNEL_WECOM_AGENT_ID",
      "HUAMEI_CHANNEL_WECOM_SECRET",
      "HUAMEI_CHANNEL_WECOM_TOKEN",
      "HUAMEI_CHANNEL_WECOM_ENCODING_AES_KEY"
    ]
  },
  {
    id:"douyin",
    name:"抖音私信",
    transport:"官方 IM adapter",
    external:true,
    required_env:[
      "HUAMEI_CHANNEL_DOUYIN_APP_ID",
      "HUAMEI_CHANNEL_DOUYIN_APP_SECRET",
      "HUAMEI_CHANNEL_DOUYIN_WEBHOOK_SECRET"
    ]
  },
  {
    id:"xiaohongshu",
    name:"小红书私信",
    transport:"官方 IM adapter",
    external:true,
    required_env:[
      "HUAMEI_CHANNEL_XIAOHONGSHU_APP_ID",
      "HUAMEI_CHANNEL_XIAOHONGSHU_APP_SECRET",
      "HUAMEI_CHANNEL_XIAOHONGSHU_WEBHOOK_SECRET"
    ]
  },
  {
    id:"api",
    name:"通用 API",
    transport:"统一消息协议",
    external:false,
    required_env:[]
  }
]);

const channelAliases = new Map([
  ["web", "web"], ["public_web", "web"], ["website", "web"],
  ["wecom", "wecom"], ["wechat_work", "wecom"], ["enterprise_wechat", "wecom"], ["企业微信", "wecom"],
  ["douyin", "douyin"], ["douyin_im", "douyin"], ["douyin_message", "douyin"], ["抖音", "douyin"], ["抖音私信", "douyin"],
  ["xiaohongshu", "xiaohongshu"], ["xhs", "xiaohongshu"], ["xiao_hong_shu", "xiaohongshu"], ["小红书", "xiaohongshu"], ["小红书私信", "xiaohongshu"],
  ["api", "api"], ["generic", "api"]
]);

const channelDefinitionsById = new Map(CHANNEL_DEFINITIONS.map((item) => [item.id, item]));
const trimmed = (value, maxLength = 1_000) => typeof value === "string" ? value.trim().slice(0, maxLength) : "";
const identifier = (value, maxLength = 160) => value === undefined || value === null
  ? ""
  : String(value).trim().slice(0, maxLength);
const firstText = (...values) => values.map((value) => trimmed(value)).find(Boolean) || "";
const firstIdentifier = (...values) => values.map((value) => identifier(value)).find(Boolean) || "";
const normalizeInterests = (value) => Array.isArray(value)
  ? value.slice(0, 10).map((item) => typeof item === "string" ? trimmed(item, 80) : trimmed(item?.name, 80)).filter(Boolean)
  : [];

const cleanContext = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const forbidden = /(?:secret|token|signature|authorization|password|private[_-]?key|access[_-]?key)/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !forbidden.test(key))
    .slice(0, 32)
    .map(([key, item]) => [String(key).slice(0, 80), item]));
};

export const normalizeAcquisitionChannel = (value) => channelAliases.get(String(value || "api").trim().toLowerCase()) || "";

const configurationFor = (definition, env = process.env) => {
  if (!definition) return null;
  if (!definition.external) {
    return {
      id:definition.id,
      name:definition.name,
      transport:definition.transport,
      status:"ready",
      enabled:true,
      external:false,
      inbound:{ normalization:"ready", official_webhook_verification:"not_required" },
      outbound:{ formatting:"ready", delivery:"caller_or_response_owned" },
      required_configuration:[],
      missing_configuration:[]
    };
  }
  const missing = definition.required_env.filter((key) => !String(env?.[key] || "").trim());
  const configured = missing.length === 0;
  const partial = !configured && missing.length < definition.required_env.length;
  return {
    id:definition.id,
    name:definition.name,
    transport:definition.transport,
    // `configured` only means the minimum secret material is present. It does
    // not mean official webhook verification or outbound delivery has been
    // implemented, so no state below can be interpreted as delivery success.
    status:configured ? "configured" : partial ? "misconfigured" : "not_configured",
    // Credential presence alone must not make a channel deliverable. The
    // official verifier/transport implementation is the only thing allowed to
    // switch an external connector into an enabled delivery state.
    enabled:false,
    configuration_ready:configured,
    external:true,
    inbound:{ normalization:"ready", official_webhook_verification:"not_implemented" },
    outbound:{ formatting:"ready", delivery:"not_implemented" },
    required_configuration:[...definition.required_env],
    missing_configuration:missing
  };
};

export function getAcquisitionChannelStatus(channelValue, { env = process.env } = {}) {
  const channel = normalizeAcquisitionChannel(channelValue);
  return configurationFor(channelDefinitionsById.get(channel), env);
}

export function listAcquisitionChannelStatuses({ env = process.env } = {}) {
  return CHANNEL_DEFINITIONS.map((definition) => configurationFor(definition, env));
}

// This snapshot is consumed by the existing service discovery endpoint. A
// process restart is intentionally required after credential changes.
export const ACQUISITION_CHANNELS = Object.freeze(listAcquisitionChannelStatuses().map((item) => Object.freeze(item)));

export function getChannelOutboundDeliveryState(channelValue, { env = process.env } = {}) {
  const configuration = getAcquisitionChannelStatus(channelValue, { env });
  if (!configuration) {
    const error = new Error("不支持该接入渠道");
    error.code = "UNSUPPORTED_CHANNEL";
    throw error;
  }
  if (!configuration.external) {
    return {
      channel:configuration.id,
      status:configuration.id === "web" ? "response_ready" : "caller_delivery_required",
      delivery_enabled:false,
      delivered:false,
      external_message_id:null,
      reason:configuration.id === "web" ? "HTTP_RESPONSE_IS_NOT_EXTERNAL_DELIVERY" : "GENERIC_API_CALLER_OWNS_DELIVERY"
    };
  }
  if (configuration.status !== "configured") {
    return {
      channel:configuration.id,
      status:"not_configured",
      delivery_enabled:false,
      delivered:false,
      external_message_id:null,
      reason:"OFFICIAL_CREDENTIALS_NOT_CONFIGURED",
      missing_configuration:configuration.missing_configuration
    };
  }
  return {
    channel:configuration.id,
    status:"adapter_not_implemented",
    delivery_enabled:false,
    delivered:false,
    external_message_id:null,
    reason:"OFFICIAL_ADAPTER_DELIVERY_NOT_IMPLEMENTED"
  };
}

const baseEnvelope = ({ tenantId, channel, conversationId, messageId, text, timestamp, actor = {}, context = {}, interests = [] }) => ({
  schema_version:"1.1",
  tenant_id:tenantId,
  channel,
  conversation_id:normalizeAcquisitionSessionId(conversationId, `${channel}-${randomUUID()}`),
  message:{
    id:normalizeAcquisitionSessionId(messageId, `msg-${randomUUID()}`),
    text:trimmed(text),
    timestamp:timestamp || new Date().toISOString()
  },
  actor:{
    ...(trimmed(actor.external_user_id, 128) ? { external_user_id:trimmed(actor.external_user_id, 128) } : {}),
    ...(trimmed(actor.customer_id, 128) ? { customer_id:trimmed(actor.customer_id, 128) } : {}),
    ...(trimmed(actor.display_name, 80) ? { display_name:trimmed(actor.display_name, 80) } : {})
  },
  context:cleanContext(context),
  interests:normalizeInterests(interests)
});

const normalizeWebInbound = (payload = {}) => baseEnvelope({
  tenantId:tenantIdFromPayload(payload),
  channel:"web",
  conversationId:payload.session_id || payload.conversation_id,
  messageId:payload.message_id || payload.event_id,
  text:payload.message,
  timestamp:payload.timestamp,
  actor:{ customer_id:payload.customer_id },
  interests:payload.interests
});

const normalizeWecomInbound = (payload = {}) => {
  const message = payload.message && typeof payload.message === "object" ? payload.message : {};
  const sender = payload.sender && typeof payload.sender === "object" ? payload.sender : {};
  const text = firstText(payload.text, payload.content, payload.Content, message.text, message.content);
  const externalUserId = firstIdentifier(payload.external_user_id, payload.from_user, payload.FromUserName, sender.id, sender.user_id);
  return baseEnvelope({
    tenantId:tenantIdFromPayload(payload),
    channel:"wecom",
    conversationId:firstIdentifier(payload.conversation_id, payload.chat_id, payload.ChatId, message.conversation_id, externalUserId),
    messageId:firstIdentifier(payload.event_id, payload.message_id, payload.MsgId, message.id),
    text,
    timestamp:payload.timestamp || payload.CreateTime || message.timestamp,
    actor:{ external_user_id:externalUserId, customer_id:payload.customer_id, display_name:payload.display_name || sender.display_name },
    context:{ ...cleanContext(payload.context), enterprise_id:payload.enterprise_id || payload.ToUserName || payload.corp_id || undefined },
    interests:payload.interests
  });
};

const normalizeDouyinInbound = (payload = {}) => {
  const event = payload.event && typeof payload.event === "object" ? payload.event : {};
  const message = payload.message && typeof payload.message === "object" ? payload.message : {};
  const sender = payload.sender && typeof payload.sender === "object" ? payload.sender : {};
  const externalUserId = firstIdentifier(payload.open_id, payload.user_id, payload.from_user_id, sender.open_id, sender.user_id, sender.id);
  return baseEnvelope({
    tenantId:tenantIdFromPayload(payload),
    channel:"douyin",
    conversationId:firstIdentifier(payload.conversation_id, payload.thread_id, payload.session_id, event.conversation_id, message.conversation_id, externalUserId),
    messageId:firstIdentifier(payload.event_id, payload.message_id, payload.msg_id, payload.im_message_id, event.id, message.id),
    text:firstText(payload.text, payload.content, message.text, message.content, event.text, event.content),
    timestamp:payload.timestamp || payload.create_time || payload.created_at || message.timestamp || event.timestamp,
    actor:{ external_user_id:externalUserId, customer_id:payload.customer_id, display_name:payload.display_name || sender.nickname || sender.display_name },
    context:{ ...cleanContext(payload.context), platform_event_type:payload.event_type || event.type || undefined },
    interests:payload.interests
  });
};

const normalizeXiaohongshuInbound = (payload = {}) => {
  const event = payload.event && typeof payload.event === "object" ? payload.event : {};
  const message = payload.message && typeof payload.message === "object" ? payload.message : {};
  const sender = payload.sender && typeof payload.sender === "object" ? payload.sender : {};
  const externalUserId = firstIdentifier(payload.user_id, payload.open_id, payload.from_user_id, sender.user_id, sender.open_id, sender.id);
  return baseEnvelope({
    tenantId:tenantIdFromPayload(payload),
    channel:"xiaohongshu",
    conversationId:firstIdentifier(payload.conversation_id, payload.thread_id, payload.session_id, event.conversation_id, message.conversation_id, externalUserId),
    messageId:firstIdentifier(payload.event_id, payload.message_id, payload.msg_id, payload.im_message_id, event.id, message.id),
    text:firstText(payload.text, payload.content, message.text, message.content, event.text, event.content),
    timestamp:payload.timestamp || payload.create_time || payload.created_at || message.timestamp || event.timestamp,
    actor:{ external_user_id:externalUserId, customer_id:payload.customer_id, display_name:payload.display_name || sender.nickname || sender.display_name },
    context:{ ...cleanContext(payload.context), platform_event_type:payload.event_type || event.type || undefined },
    interests:payload.interests
  });
};

const normalizeApiInbound = (payload = {}) => {
  const message = payload.message && typeof payload.message === "object" ? payload.message : {};
  return baseEnvelope({
    tenantId:tenantIdFromPayload(payload),
    channel:normalizeAcquisitionChannel(payload.channel) || "api",
    conversationId:payload.conversation_id || payload.session_id,
    messageId:message.id || payload.message_id,
    text:firstText(message.text, payload.text, typeof payload.message === "string" ? payload.message : ""),
    timestamp:message.timestamp || payload.timestamp,
    actor:payload.actor || { external_user_id:payload.external_user_id, customer_id:payload.customer_id },
    context:payload.context,
    interests:payload.interests
  });
};

export function normalizeChannelInbound(channelValue, payload = {}) {
  const channel = normalizeAcquisitionChannel(channelValue || payload.channel);
  if (!channel) {
    const error = new Error("不支持该接入渠道");
    error.code = "UNSUPPORTED_CHANNEL";
    throw error;
  }
  const normalizers = {
    web:normalizeWebInbound,
    wecom:normalizeWecomInbound,
    douyin:normalizeDouyinInbound,
    xiaohongshu:normalizeXiaohongshuInbound,
    api:normalizeApiInbound
  };
  // The caller is responsible for passing an already-verified official
  // callback. This pure normalizer never treats a payload as verified or sent.
  const envelope = normalizers[channel]({ ...payload, channel });
  if (!envelope.message.text || envelope.message.text.length > 1_000) {
    const error = new Error("咨询内容不能为空且不能超过1000字符");
    error.code = "VALIDATION_ERROR";
    error.details = [{ field:"message.text", message:"请输入1–1000字符" }];
    throw error;
  }
  return envelope;
}

const outboundSegments = (result = {}) => (result.reply?.segments || [result.reply?.text].filter(Boolean))
  .map((content) => trimmed(content, 1_000))
  .filter(Boolean);

const metadataFor = (result = {}) => ({
  run_id:result.run_id,
  status:result.status,
  agent:result.agent,
  citations:result.reply?.citations || [],
  media:result.reply?.media || [],
  reply_segments:outboundSegments(result),
  suggestions:result.reply?.suggestions || [],
  handover:result.handover,
  profile_signals:result.profile_signals,
  orchestration:result.orchestration,
  lead_capture:result.lead_capture,
      lead_receipt:result.lead_receipt,
  guardrails:result.guardrails
});

const deliveryFor = (channel, result, options = {}) => ({
  ...(result?.delivery && typeof result.delivery === "object" ? result.delivery : {}),
  ...getChannelOutboundDeliveryState(channel, options),
  // Formatting output must never be mistaken for a completed external send.
  delivered:false,
  external_message_id:null,
  sent_at:null
});

const externalOutbound = (channel, result, options) => ({
  request_id:result.request_id,
  tenant_id:result.tenant_id,
  channel,
  conversation_id:result.conversation_id,
  outbound:{
    message_type:"text",
    text:result.reply?.text || "",
    segments:outboundSegments(result)
  },
  metadata:metadataFor(result),
  delivery:deliveryFor(channel, result, options)
});

export function formatChannelOutbound(channelValue, result = {}, options = {}) {
  const channel = normalizeAcquisitionChannel(channelValue || result.channel);
  if (!channel) {
    const error = new Error("不支持该接入渠道");
    error.code = "UNSUPPORTED_CHANNEL";
    throw error;
  }
  if (channel === "web") {
    return {
      tenant_id:result.tenant_id,
      request_id:result.request_id,
      run_id:result.run_id,
      status:result.status,
      agent:result.agent,
      reply:result.reply?.text || "",
      reply_segments:outboundSegments(result),
      citations:result.reply?.citations || [],
      media:result.reply?.media || [],
      suggestions:result.reply?.suggestions || [],
      handover:result.handover,
      profile_signals:result.profile_signals,
      orchestration:result.orchestration,
      lead_capture:result.lead_capture,
      lead_receipt:result.lead_receipt,
      guardrails:result.guardrails,
      delivery:deliveryFor(channel, result, options)
    };
  }
  if (channel === "wecom") {
    return {
      request_id:result.request_id,
      tenant_id:result.tenant_id,
      channel:"wecom",
      conversation_id:result.conversation_id,
      msgtype:"text",
      text:{ content:result.reply?.text || "" },
      messages:outboundSegments(result).map((content, index) => ({
        type:"text",
        content,
        sequence:index + 1
      })),
      metadata:metadataFor(result),
      delivery:deliveryFor(channel, result, options)
    };
  }
  if (["douyin", "xiaohongshu"].includes(channel)) return externalOutbound(channel, result, options);
  return {
    ...result,
    channel:"api",
    delivery:deliveryFor(channel, result, options)
  };
}
