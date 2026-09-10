import assert from "node:assert/strict";
import {
  ACQUISITION_CHANNELS,
  formatChannelOutbound,
  getAcquisitionChannelStatus,
  getChannelOutboundDeliveryState,
  listAcquisitionChannelStatuses,
  normalizeAcquisitionChannel,
  normalizeChannelInbound
} from "../server/acquisition-channel-adapters.mjs";

const noCredentials = {};
const channels = listAcquisitionChannelStatuses({ env:noCredentials });
assert.deepEqual(channels.map((item) => item.id), ["web", "wecom", "douyin", "xiaohongshu", "api"]);
for (const id of ["wecom", "douyin", "xiaohongshu"]) {
  const channel = getAcquisitionChannelStatus(id, { env:noCredentials });
  assert.equal(channel.status, "not_configured", `${id}缺少官方凭据必须显示未配置`);
  assert.equal(channel.enabled, false, `${id}未实现官方适配器不得标记为启用`);
  assert.equal(channel.configuration_ready, false);
  assert.ok(channel.missing_configuration.length > 0);
  const delivery = getChannelOutboundDeliveryState(id, { env:noCredentials });
  assert.equal(delivery.status, "not_configured");
  assert.equal(delivery.delivered, false);
  assert.equal(delivery.external_message_id, null);
}

assert.equal(normalizeAcquisitionChannel("抖音私信"), "douyin");
assert.equal(normalizeAcquisitionChannel("xhs"), "xiaohongshu");
assert.equal(normalizeAcquisitionChannel("小红书"), "xiaohongshu");
assert.equal(ACQUISITION_CHANNELS.filter((item) => item.external).length, 3);

const douyinInbound = normalizeChannelInbound("抖音", {
  tenant_id:"tenant-channel",
  event_id:"dy-event-1",
  conversation_id:"dy-conversation-1",
  open_id:"dy-open-1",
  text:"想了解隆鼻项目",
  context:{ request_token:"must-not-pass", campaign:"organic" }
});
assert.equal(douyinInbound.channel, "douyin");
assert.equal(douyinInbound.conversation_id, "dy-conversation-1");
assert.equal(douyinInbound.message.id, "dy-event-1");
assert.equal(douyinInbound.actor.external_user_id, "dy-open-1");
assert.equal(douyinInbound.context.campaign, "organic");
assert.equal("request_token" in douyinInbound.context, false, "凭据不得进入标准化消息上下文");

const xiaohongshuInbound = normalizeChannelInbound("小红书", {
  tenant_id:"tenant-channel",
  message:{ id:"xhs-message-1", content:"想预约面诊", timestamp:"2026-09-07T10:00:00.000Z" },
  sender:{ user_id:"xhs-user-1", nickname:"小红书用户" },
  thread_id:"xhs-thread-1",
  context:{ signature:"must-not-pass", source:"organic" }
});
assert.equal(xiaohongshuInbound.channel, "xiaohongshu");
assert.equal(xiaohongshuInbound.conversation_id, "xhs-thread-1");
assert.equal(xiaohongshuInbound.message.id, "xhs-message-1");
assert.equal(xiaohongshuInbound.actor.external_user_id, "xhs-user-1");
assert.equal("signature" in xiaohongshuInbound.context, false);

const agentResult = {
  request_id:"req-channel-1",
  tenant_id:"tenant-channel",
  channel:"douyin",
  conversation_id:"conversation-channel-1",
  status:"completed",
  reply:{ text:"您好，先和您确认一下关注点。", segments:["您好。", "先和您确认一下关注点。"], citations:[], media:[], suggestions:[] },
  delivery:{ mode:"agent_reply" }
};
for (const channel of ["wecom", "douyin", "xiaohongshu"]) {
  const outbound = formatChannelOutbound(channel, { ...agentResult, channel });
  assert.equal(outbound.delivery.status, "not_configured", `${channel}未配置时不得模拟投递`);
  assert.equal(outbound.delivery.delivered, false);
  assert.equal(outbound.delivery.external_message_id, null);
  assert.equal(outbound.delivery.sent_at, null);
}
const douyinOutbound = formatChannelOutbound("douyin", agentResult);
assert.equal(douyinOutbound.outbound.message_type, "text");
assert.deepEqual(douyinOutbound.outbound.segments, ["您好。", "先和您确认一下关注点。"]);
const xiaohongshuOutbound = formatChannelOutbound("xiaohongshu", agentResult);
assert.equal(xiaohongshuOutbound.outbound.text, agentResult.reply.text);

const fullyConfiguredWecom = {
  HUAMEI_CHANNEL_WECOM_CORP_ID:"corp",
  HUAMEI_CHANNEL_WECOM_AGENT_ID:"agent",
  HUAMEI_CHANNEL_WECOM_SECRET:"secret",
  HUAMEI_CHANNEL_WECOM_TOKEN:"token",
  HUAMEI_CHANNEL_WECOM_ENCODING_AES_KEY:"aes"
};
const configuredWecom = getAcquisitionChannelStatus("wecom", { env:fullyConfiguredWecom });
assert.equal(configuredWecom.status, "configured");
assert.equal(configuredWecom.configuration_ready, true);
assert.equal(configuredWecom.enabled, false, "仅配置凭据不能伪装为可投递适配器");
const configuredWecomOutbound = formatChannelOutbound("wecom", agentResult, { env:fullyConfiguredWecom });
assert.equal(configuredWecomOutbound.msgtype, "text");
assert.equal(configuredWecomOutbound.delivery.status, "adapter_not_implemented");
assert.equal(configuredWecomOutbound.delivery.delivered, false);

console.log("✓ 统一 IM 渠道状态、标准化入站和未配置投递保护通过");
