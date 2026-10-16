const safeText = (value, length = 160) => String(value || "").replace(/[<>]/g, "").trim().slice(0, length);

const latestFirst = (left, right) => Date.parse(right?.updated_at || 0) - Date.parse(left?.updated_at || 0);

const publicAppointmentSummary = (appointment) => ({
  appointment_no:safeText(appointment.appointment_no, 64),
  time_preference:safeText(appointment.time_preference, 80),
  status:safeText(appointment.status, 40),
  followup_status:safeText(appointment.followup_status, 40),
  next_followup_at:appointment.next_followup_at || null,
  version:Number(appointment.version) || 1,
  updated_at:appointment.updated_at || null
});

const appointmentEvent = (appointment) => ({
  id:`appointment-${safeText(appointment.id, 80)}-v${Number(appointment.version) || 1}`,
  type:"appointment",
  title:appointment.followup_status === "completed" || appointment.followup_status === "needs_customer_info"
    ? "到院登记跟进已更新"
    : Number(appointment.version) > 1 ? "到院意向已更新" : "到院意向已登记",
  detail:appointment.status === "cancelled"
    ? "本次到院意向已取消；如需新的安排，请由客户重新确认。"
    : `期望到院：${safeText(appointment.time_preference, 80) || "待确认"}；当前由人工跟进，不代表指定医生或接诊名额已锁定。`,
  occurredAt:appointment.updated_at || appointment.created_at || new Date(0).toISOString(),
  actor:"客户确认",
  channel:"到院意向登记",
  tone:appointment.status === "cancelled" ? "risk" : "positive"
});

const followupEvents = (appointment) => (Array.isArray(appointment.followup_history) ? appointment.followup_history : []).map((followup) => ({
  id:`appointment-${safeText(appointment.id, 80)}-followup-${safeText(followup.id, 80)}`,
  type:"followup",
  title:followup.status === "completed" ? "到院登记跟进完成" : "到院登记待客户补充信息",
  detail:`跟进说明：${safeText(followup.note, 500) || "已记录"}${followup.next_followup_at ? `；下次跟进：${safeText(followup.next_followup_at, 40)}` : "；本次跟进未设置下一步"}。仅表示人工跟进结果，不代表客户已到院、成交或付款。`,
  occurredAt:followup.occurred_at || appointment.updated_at || new Date(0).toISOString(),
  actor:safeText(followup.actor, 120) || "当前顾问",
  channel:"到院登记跟进",
  tone:followup.status === "completed" ? "positive" : "neutral"
}));

// The appointment store keeps an opaque internal contact reference.  Customer
// 360 deliberately joins through the already-authorized conversation ID, so a
// contact value, its hash, or that internal reference never enters the browser
// snapshot.
export function projectAppointmentsOntoCustomers(customers = [], appointments = []) {
  const byConversation = new Map();
  for (const appointment of appointments) {
    const conversationId = safeText(appointment?.conversation_id, 128);
    if (!conversationId) continue;
    const entries = byConversation.get(conversationId) || [];
    entries.push(appointment);
    byConversation.set(conversationId, entries);
  }
  for (const entries of byConversation.values()) entries.sort(latestFirst);

  return customers.map((entry) => {
    const conversationIds = new Set((entry?.conversations || [])
      .map((conversation) => safeText(conversation?.externalConversationId || conversation?.id, 128))
      .filter(Boolean));
    const matching = [...conversationIds]
      .flatMap((conversationId) => byConversation.get(conversationId) || [])
      .sort(latestFirst);
    const appointment = matching[0];
    if (!appointment) return entry;
    const event = appointmentEvent(appointment);
    const timeline = [event, ...followupEvents(appointment), ...(entry.customer?.timeline || [])]
      .filter((item, index, values) => item?.id && values.findIndex((candidate) => candidate.id === item.id) === index)
      .sort((left, right) => Date.parse(right?.occurredAt || 0) - Date.parse(left?.occurredAt || 0))
      .slice(0, 80);
    return {
      ...entry,
      customer:{
        ...entry.customer,
        appointment:publicAppointmentSummary(appointment),
        timeline
      }
    };
  });
}
