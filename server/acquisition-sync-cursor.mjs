// Return the durable messages that must be replayed after a management
// conversation cursor. Customer input and its AI answer share a turn
// sequence, so an answer committed after the input must remain visible at the
// cursor boundary. The client merges all returned rows by stable message ID.
export const messagesChangedSinceCursor = (messages = [], afterSequence = 0) => (Array.isArray(messages) ? messages : [])
  .filter((message) => {
    const sequence = Number(message?.seq);
    return !Number.isInteger(sequence)
      || sequence > afterSequence
      || (sequence === afterSequence && message?.from !== "customer");
  });

// These are all display-affecting fields of a management conversation. In
// particular, customerId changes when an anonymous visitor submits contact
// details and is merged into a formal customer record.
export const conversationSyncSignaturePayload = (conversation = {}, durableCursor = "") => ({
  cursor:String(durableCursor || conversation.cursor || `${conversation.externalConversationId || conversation.id || "conversation"}#0`),
  customerId:conversation.customerId || "",
  updatedAt:conversation.updatedAt || "",
  status:conversation.status || "",
  mode:conversation.mode || "",
  messages:(conversation.messages || []).map((message) => ({
    id:message?.id || "",
    seq:Number(message?.seq) || 0,
    status:message?.status || "",
    delivery:message?.delivery?.delivery_status || ""
  }))
});
