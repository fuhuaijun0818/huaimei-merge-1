import { createHash } from "node:crypto";
import { createFieldEncryption, createFieldRecordId } from "../platform/field-encryption.mjs";
import { redactContactPii, redactContactPiiDeep } from "../platform/contact-pii-redaction.mjs";
import {
  appendAuditEvent, appendOutboxEvent, ensureConversationSession, jsonValue, postgres
} from "./postgres-helpers.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
export const sanitizeConversationSessionStateForPersistence = (value) => redactContactPiiDeep(value);
export const sanitizeConversationMessageForPersistence = (value) => redactContactPii(value);
const hashPattern = /^[0-9a-f]{64}$/;
const positiveInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
};

const messageIdFor = (value) => {
  const messageId = String(value || "").trim();
  if (!messageId || messageId.length > 160) {
    const error = new Error("A channel message id of at most 160 characters is required");
    error.code = "CONVERSATION_MESSAGE_ID_REQUIRED";
    throw error;
  }
  return messageId;
};

const payloadHashFor = (value) => {
  const payloadHash = String(value || "").trim().toLowerCase();
  if (!hashPattern.test(payloadHash)) {
    const error = new Error("A SHA-256 payload hash is required for conversation idempotency");
    error.code = "CONVERSATION_PAYLOAD_HASH_REQUIRED";
    throw error;
  }
  return payloadHash;
};

const assistantMessageIdFor = (sessionId, inboundMessageId) => `reply_${createHash("sha256")
  .update(`${sessionId}\u0000${inboundMessageId}\u0000assistant`)
  .digest("hex")}`;

const reusedMessageId = () => {
  const error = new Error("The channel message id was already used with different content");
  error.code = "CONVERSATION_MESSAGE_ID_REUSED";
  throw error;
};

const sequencePending = ({ expected, actual }) => {
  const error = new Error(`Conversation turn ${actual} cannot commit before turn ${expected}`);
  error.code = "POSTGRES_CONVERSATION_SEQUENCE_PENDING";
  error.retryable = true;
  error.details = { expected_sequence:expected, actual_sequence:actual };
  throw error;
};

const receiptFrom = (row) => {
  const metadata = jsonValue(row?.metadata, {});
  return {
    message_id:row?.message_id || null,
    turn_sequence:Number(row?.turn_sequence || 0),
    processing_state:row?.processing_state || metadata.processing_state || "received",
    processing_attempts:Number(row?.processing_attempts || metadata.processing_attempts || 1),
    processing_deadline_at:row?.processing_deadline_at
      ? new Date(row.processing_deadline_at).toISOString()
      : metadata.processing_deadline_at || null,
    payload_hash:metadata.payload_hash || null,
    assistant_message_id:metadata.assistant_message_id || null,
    received_at:metadata.received_at || null,
    completed_at:metadata.completed_at || null
  };
};

const lockConversationIdentity = async (
  client,
  { tenantId, channel, sessionId, externalConversationId }
) => {
  const keys = [...new Set([
    `conversation-session:${tenantId}:${channel}:${sessionId}`,
    `conversation-external:${tenantId}:${channel}:${externalConversationId || sessionId}`
  ])].sort();
  for (const key of keys) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
};

export function createPostgresAcquisitionSessionStore(options = {}) {
  const database = options.postgres || postgres();
  const fieldEncryption = options.fieldEncryption || createFieldEncryption({ env:options.env || process.env });
  const stateContext = ({ tenantId, channel, sessionId }) => ({
    tenantId,
    scope:"conversation.session.state",
    recordId:createFieldRecordId("conversation.session", { channel, session_id:sessionId }),
    legacyRecordId:`${channel}:${sessionId}`
  });
  const messageContext = ({ tenantId, channel, sessionId, messageId }) => ({
    tenantId,
    scope:"conversation.message.content",
    recordId:createFieldRecordId("conversation.message", { channel, message_id:messageId, session_id:sessionId }),
    legacyRecordId:`${channel}:${sessionId}:${messageId}`
  });
  const snapshotContext = ({ tenantId, channel, sessionId, messageId }) => ({
    tenantId,
    scope:"conversation.message.session_snapshot",
    recordId:createFieldRecordId("conversation.message", { channel, message_id:messageId, session_id:sessionId }),
    legacyRecordId:`${channel}:${sessionId}:${messageId}`
  });
  const readState = (value, identity, fallback = {}) => sanitizeConversationSessionStateForPersistence(clone(fieldEncryption.decryptJson(
    jsonValue(value, clone(fallback)),
    stateContext(identity)
  )));
  const encryptState = (value, identity) => fieldEncryption.encryptJson(
    sanitizeConversationSessionStateForPersistence(value),
    stateContext(identity)
  );
  const writeState = (value, identity) => JSON.stringify(fieldEncryption.encryptJson(
    sanitizeConversationSessionStateForPersistence(value),
    stateContext(identity)
  ));
  const receiptTimeoutMs = positiveInteger(
    options.receiptTimeoutMs ?? process.env.HUAMEI_CONVERSATION_RECEIPT_TIMEOUT_MS,
    120_000,
    5_000,
    30 * 60_000
  );

  const mutate = async ({
    tenantId,
    sessionId,
    channel,
    externalConversationId,
    expiresAt,
    initialState,
    operation
  }) => database.tenantTransaction(tenantId, async (client) => {
    await lockConversationIdentity(client, { tenantId, channel, sessionId, externalConversationId });
    const row = await ensureConversationSession(client, {
      tenantId,
      sessionId,
      channel,
      externalConversationId,
      state:encryptState(initialState, { tenantId, channel, sessionId }),
      expiresAt
    });
    const locked = await client.query(
      `SELECT id, state, state_version FROM conversation_sessions
       WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, row.id]
    );
    const current = readState(locked.rows[0]?.state, { tenantId, channel, sessionId }, initialState);
    const mutation = await operation(clone(current), { recordId:row.id, client });
    const nextState = mutation?.state || mutation || current;
    await client.query(
      `UPDATE conversation_sessions
       SET state=$3::jsonb,
           state_version=state_version+1,
           last_activity_at=clock_timestamp(),
           expires_at=$4
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, row.id, writeState(nextState, { tenantId, channel, sessionId }), expiresAt]
    );
    return mutation?.result === undefined ? clone(nextState) : clone(mutation.result);
  });

  const beginTurn = async ({
    tenantId,
    sessionId,
    channel,
    externalConversationId,
    expiresAt,
    initialState,
    messageId:messageIdValue,
    message,
    payloadHash:payloadHashValue,
    occurredAt,
    operation
  }) => {
    const messageId = messageIdFor(messageIdValue);
    const payloadHash = payloadHashFor(payloadHashValue);
    return database.tenantTransaction(tenantId, async (client) => {
      await lockConversationIdentity(client, { tenantId, channel, sessionId, externalConversationId });
      const row = await ensureConversationSession(client, {
        tenantId,
        sessionId,
        channel,
        externalConversationId,
        state:encryptState(initialState, { tenantId, channel, sessionId }),
        expiresAt
      });
      const locked = await client.query(
        `SELECT id, state, next_turn_sequence, next_commit_sequence, state_version
         FROM conversation_sessions
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [tenantId, row.id]
      );
      const sessionRow = locked.rows[0];
      const current = readState(sessionRow?.state, { tenantId, channel, sessionId }, initialState);
      const existingResult = await client.query(
        `SELECT message_id, turn_sequence, metadata, processing_state,
           processing_attempts, processing_deadline_at,
           processing_completed_at, processing_failed_at, failure_code
         FROM conversation_messages
         WHERE tenant_id=$1 AND session_record_id=$2 AND message_id=$3
           AND role='user' AND direction='inbound'
         LIMIT 1`,
        [tenantId, row.id, messageId]
      );
      const existing = existingResult.rows[0];
      if (existing) {
        let receipt = receiptFrom(existing);
        if (receipt.payload_hash !== payloadHash) reusedMessageId();
        if (receipt.processing_state === "failed") {
          if (receipt.turn_sequence !== Number(sessionRow.next_commit_sequence)) {
            const error = new Error("A failed conversation receipt can only be recovered at the current commit sequence");
            error.code = "POSTGRES_CONVERSATION_RECOVERY_ORDER_INVALID";
            throw error;
          }
          const recoveredAt = new Date().toISOString();
          const nextDeadline = new Date(Date.now() + receiptTimeoutMs).toISOString();
          const recovered = await client.query(
            `UPDATE conversation_messages
             SET processing_state='received',
                 processing_attempts=processing_attempts+1,
                 processing_deadline_at=$4,
                 processing_completed_at=NULL,
                 processing_failed_at=NULL,
                 failure_code=NULL,
                 metadata=(metadata - 'failed_at' - 'failure_code' - 'completed_at') || $5::jsonb
             WHERE tenant_id=$1 AND session_record_id=$2 AND message_id=$3
               AND processing_state='failed'
             RETURNING message_id, turn_sequence, metadata, processing_state,
               processing_attempts, processing_deadline_at,
               processing_completed_at, processing_failed_at, failure_code`,
            [tenantId, row.id, messageId, nextDeadline, JSON.stringify({
              processing_state:"received",
              processing_attempts:receipt.processing_attempts + 1,
              processing_deadline_at:nextDeadline,
              recovered_at:recoveredAt
            })]
          );
          receipt = receiptFrom(recovered.rows[0]);
          receipt.recovered = true;
        }
        const preview = await operation(clone(current), {
          recordId:row.id,
          client,
          messageId,
          turnSequence:receipt.turn_sequence,
          isReplay:true
        });
        return {
          result:clone(preview?.result === undefined ? preview?.state || preview || current : preview.result),
          receipt:{ ...receipt, replay:true }
        };
      }

      const turnSequence = Number(sessionRow.next_turn_sequence);
      const mutation = await operation(clone(current), {
        recordId:row.id,
        client,
        messageId,
        turnSequence,
        isReplay:false
      });
      const nextState = mutation?.state || mutation || current;
      const receivedAt = new Date().toISOString();
      const processingDeadlineAt = new Date(Date.now() + receiptTimeoutMs).toISOString();
      await client.query(
        `INSERT INTO conversation_messages
          (tenant_id, session_record_id, message_id, role, direction, content,
           metadata, occurred_at, turn_sequence, processing_state,
           processing_attempts, processing_deadline_at)
         VALUES ($1,$2,$3,'user','inbound',$4,$5::jsonb,$6,$7,'received',1,$8)`,
        [tenantId, row.id, messageId, fieldEncryption.encryptText(sanitizeConversationMessageForPersistence(message), messageContext({ tenantId, channel, sessionId, messageId })),
          JSON.stringify({
            processing_state:"received",
            processing_attempts:1,
            processing_deadline_at:processingDeadlineAt,
            payload_hash:payloadHash,
            received_at:receivedAt
          }),
          occurredAt || receivedAt, turnSequence, processingDeadlineAt]
      );
      await client.query(
        `UPDATE conversation_sessions
         SET state=$3::jsonb,
             next_turn_sequence=$4,
             state_version=state_version+1,
             last_activity_at=clock_timestamp(),
             expires_at=$5
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, row.id, writeState(nextState, { tenantId, channel, sessionId }), turnSequence + 1, expiresAt]
      );
      return {
        result:clone(mutation?.result === undefined ? nextState : mutation.result),
        receipt:{
          message_id:messageId,
          turn_sequence:turnSequence,
          processing_state:"received",
          processing_attempts:1,
          processing_deadline_at:processingDeadlineAt,
          payload_hash:payloadHash,
          assistant_message_id:null,
          received_at:receivedAt,
          completed_at:null,
          replay:false
        }
      };
    });
  };

  const recordTurn = async ({
    tenantId,
    sessionId,
    channel,
    externalConversationId,
    expiresAt,
    initialState,
    messageId:messageIdValue,
    payloadHash:payloadHashValue,
    assistantMessage,
    status,
    operation
  }) => {
    const messageId = messageIdFor(messageIdValue);
    const payloadHash = payloadHashFor(payloadHashValue);
    return database.tenantTransaction(tenantId, async (client) => {
      await lockConversationIdentity(client, { tenantId, channel, sessionId, externalConversationId });
      const row = await ensureConversationSession(client, {
        tenantId,
        sessionId,
        channel,
        externalConversationId,
        state:encryptState(initialState, { tenantId, channel, sessionId }),
        expiresAt
      });
      const locked = await client.query(
        `SELECT id, state, next_commit_sequence, state_version
         FROM conversation_sessions
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [tenantId, row.id]
      );
      const sessionRow = locked.rows[0];
      const inboundResult = await client.query(
        `SELECT message_id, turn_sequence, metadata, processing_state,
           processing_attempts, processing_deadline_at,
           processing_completed_at, processing_failed_at, failure_code
         FROM conversation_messages
         WHERE tenant_id=$1 AND session_record_id=$2 AND message_id=$3
           AND role='user' AND direction='inbound'
         LIMIT 1`,
        [tenantId, row.id, messageId]
      );
      const inbound = inboundResult.rows[0];
      if (!inbound) {
        const error = new Error("The inbound conversation message must be received before its reply is recorded");
        error.code = "POSTGRES_CONVERSATION_RECEIPT_REQUIRED";
        throw error;
      }
      const receipt = receiptFrom(inbound);
      if (receipt.payload_hash !== payloadHash) reusedMessageId();
      if (receipt.processing_state === "completed") {
        const metadata = jsonValue(inbound.metadata, {});
        const replayResult = metadata.session_snapshot === undefined
          ? readState(sessionRow.state, { tenantId, channel, sessionId }, initialState)
          : fieldEncryption.decryptJson(
            metadata.session_snapshot,
            snapshotContext({ tenantId, channel, sessionId, messageId })
          );
        return {
          result:clone(replayResult),
          receipt:{ ...receipt, replay:true }
        };
      }
      if (receipt.processing_state === "failed") {
        const error = new Error("The timed-out conversation message must be explicitly replayed before it can complete");
        error.code = "CONVERSATION_RECEIPT_FAILED_REPLAY_REQUIRED";
        error.retryable = true;
        error.details = {
          message_id:messageId,
          turn_sequence:receipt.turn_sequence
        };
        throw error;
      }
      const expectedSequence = Number(sessionRow.next_commit_sequence);
      if (receipt.turn_sequence !== expectedSequence) {
        const predecessor = await client.query(
          `SELECT message_id, processing_state, processing_failed_at, failure_code
           FROM conversation_messages
           WHERE tenant_id=$1 AND session_record_id=$2 AND turn_sequence=$3
             AND role='user' AND direction='inbound'
           LIMIT 1`,
          [tenantId, row.id, expectedSequence]
        );
        if (predecessor.rows[0]?.processing_state === "failed") {
          const error = new Error("An earlier conversation message timed out and must be replayed before later replies can commit");
          error.code = "CONVERSATION_PREDECESSOR_FAILED";
          error.retryable = true;
          error.details = {
            expected_sequence:expectedSequence,
            actual_sequence:receipt.turn_sequence,
            failed_message_id:predecessor.rows[0].message_id,
            failure_code:predecessor.rows[0].failure_code
          };
          throw error;
        }
        sequencePending({ expected:expectedSequence, actual:receipt.turn_sequence });
      }

      const assistantMessageId = assistantMessageIdFor(sessionId, messageId);
      const current = readState(sessionRow.state, { tenantId, channel, sessionId }, initialState);
      const mutation = await operation(clone(current), {
        recordId:row.id,
        client,
        messageId,
        assistantMessageId,
        turnSequence:receipt.turn_sequence,
        isReplay:false
      });
      const nextState = mutation?.state || mutation || current;
      const sessionSnapshot = sanitizeConversationSessionStateForPersistence(
        mutation?.result === undefined ? clone(nextState) : clone(mutation.result)
      );
      const completedAt = new Date().toISOString();
      const hasAssistantMessage = Boolean(String(assistantMessage || "").trim());
      if (hasAssistantMessage) {
        await client.query(
          `INSERT INTO conversation_messages
            (tenant_id, session_record_id, message_id, role, direction, content,
             metadata, occurred_at, turn_sequence, parent_message_id)
           VALUES ($1,$2,$3,'assistant','outbound',$4,$5::jsonb,$6,$7,$8)`,
          [tenantId, row.id, assistantMessageId, fieldEncryption.encryptText(
            sanitizeConversationMessageForPersistence(assistantMessage),
            messageContext({ tenantId, channel, sessionId, messageId:assistantMessageId })
          ),
            JSON.stringify({ status, inbound_message_id:messageId }), completedAt,
            receipt.turn_sequence, messageId]
        );
      }
      await client.query(
        `UPDATE conversation_messages
         SET processing_state='completed',
             processing_deadline_at=NULL,
             processing_completed_at=$4,
             processing_failed_at=NULL,
             failure_code=NULL,
             metadata=metadata || $5::jsonb
         WHERE tenant_id=$1 AND session_record_id=$2 AND message_id=$3`,
        [tenantId, row.id, messageId, completedAt, JSON.stringify({
          processing_state:"completed",
          processing_deadline_at:null,
          assistant_message_id:hasAssistantMessage ? assistantMessageId : null,
          completed_at:completedAt,
          session_snapshot:fieldEncryption.encryptJson(
            sessionSnapshot,
            snapshotContext({ tenantId, channel, sessionId, messageId })
          )
        })]
      );
      await client.query(
        `UPDATE conversation_sessions
         SET state=$3::jsonb,
             next_commit_sequence=$4,
             state_version=state_version+1,
             last_activity_at=clock_timestamp(),
             expires_at=$5
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, row.id, writeState(nextState, { tenantId, channel, sessionId }), receipt.turn_sequence + 1, expiresAt]
      );
      await appendOutboxEvent(client, {
        tenantId,
        aggregateType:"conversation_session",
        aggregateId:sessionId,
        eventType:"conversation.turn.recorded",
        payload:{
          session_id:sessionId,
          status,
          inbound_message_id:messageId,
          assistant_message_id:hasAssistantMessage ? assistantMessageId : null,
          turn_sequence:receipt.turn_sequence,
          message_count:hasAssistantMessage ? 2 : 1
        }
      });
      return {
        result:sessionSnapshot,
        receipt:{
          ...receipt,
          processing_state:"completed",
          processing_deadline_at:null,
          assistant_message_id:hasAssistantMessage ? assistantMessageId : null,
          completed_at:completedAt,
          replay:false
        }
      };
    });
  };

  const failStaleReceipts = async ({
    tenantId,
    now = new Date().toISOString(),
    limit = 100,
    failureCode = "PROCESSING_TIMEOUT"
  }) => {
    const cutoff = new Date(now);
    if (Number.isNaN(cutoff.getTime())) throw new TypeError("now must be a valid timestamp");
    const boundedLimit = positiveInteger(limit, 100, 1, 500);
    const code = String(failureCode || "PROCESSING_TIMEOUT").trim().slice(0, 96);
    const candidates = await database.tenantQuery(tenantId,
      `SELECT m.message_id, m.turn_sequence, s.id AS session_record_id,
         s.session_id, s.channel, s.external_conversation_id
       FROM conversation_messages m
       JOIN conversation_sessions s
         ON s.tenant_id=m.tenant_id AND s.id=m.session_record_id
       WHERE m.tenant_id=$1
         AND m.role='user' AND m.direction='inbound'
         AND m.processing_state='received'
         AND m.processing_deadline_at <= $2
       ORDER BY m.processing_deadline_at, m.turn_sequence, m.id
       LIMIT $3`,
      [tenantId, cutoff.toISOString(), boundedLimit]
    );
    const failed = [];
    for (const candidate of candidates.rows) {
      const finalized = await database.tenantTransaction(tenantId, async (client) => {
        await lockConversationIdentity(client, {
          tenantId,
          channel:candidate.channel,
          sessionId:candidate.session_id,
          externalConversationId:candidate.external_conversation_id
        });
        await client.query(
          `SELECT id FROM conversation_sessions
           WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [tenantId, candidate.session_record_id]
        );
        const failedAt = cutoff.toISOString();
        const updated = await client.query(
          `UPDATE conversation_messages
           SET processing_state='failed',
               processing_deadline_at=NULL,
               processing_completed_at=NULL,
               processing_failed_at=$4,
               failure_code=$5,
               metadata=(metadata - 'completed_at') || $6::jsonb
           WHERE tenant_id=$1 AND session_record_id=$2 AND message_id=$3
             AND role='user' AND direction='inbound'
             AND processing_state='received'
             AND processing_deadline_at <= $4
           RETURNING turn_sequence, processing_attempts`,
          [tenantId, candidate.session_record_id, candidate.message_id,
            failedAt, code, JSON.stringify({
              processing_state:"failed",
              processing_deadline_at:null,
              failed_at:failedAt,
              failure_code:code
            })]
        );
        if (!updated.rowCount) return null;
        await appendAuditEvent(client, {
          tenantId,
          action:"conversation.turn.failed",
          resourceType:"conversation_message",
          resourceId:`${candidate.session_id}:${candidate.message_id}`,
          actorType:"worker",
          actorId:"conversation-receipt-recovery",
          outcome:"failure",
          details:{
            session_id:candidate.session_id,
            inbound_message_id:candidate.message_id,
            turn_sequence:Number(updated.rows[0].turn_sequence),
            processing_attempts:Number(updated.rows[0].processing_attempts),
            failure_code:code,
            commit_cursor_advanced:false
          }
        });
        await appendOutboxEvent(client, {
          tenantId,
          aggregateType:"conversation_session",
          aggregateId:candidate.session_id,
          eventType:"conversation.turn.failed",
          payload:{
            session_id:candidate.session_id,
            inbound_message_id:candidate.message_id,
            turn_sequence:Number(updated.rows[0].turn_sequence),
            failure_code:code,
            recovery:"replay_same_message_id",
            commit_cursor_advanced:false
          }
        });
        return {
          tenant_id:tenantId,
          session_id:candidate.session_id,
          message_id:candidate.message_id,
          turn_sequence:Number(updated.rows[0].turn_sequence),
          failure_code:code,
          failed_at:failedAt
        };
      });
      if (finalized) failed.push(finalized);
    }
    return failed;
  };

  const get = async ({ tenantId, sessionId, channel = "web" }) => {
    const result = await database.tenantQuery(tenantId,
      `SELECT state FROM conversation_sessions
       WHERE tenant_id=$1 AND channel=$2 AND session_id=$3
       LIMIT 1`,
      [tenantId, channel, sessionId]
    );
    return result.rows[0]
      ? readState(result.rows[0].state, { tenantId, channel, sessionId })
      : null;
  };

  const listStates = async ({ tenantId = null, activeSince = null } = {}) => {
    if (!tenantId) {
      const error = new Error("tenantId is required when listing session states");
      error.code = "POSTGRES_TENANT_CONTEXT_REQUIRED";
      throw error;
    }
    const clauses = [];
    const values = [];
    if (tenantId) {
      values.push(tenantId);
      clauses.push(`tenant_id=$${values.length}`);
    }
    if (activeSince) {
      values.push(activeSince);
      clauses.push(`last_activity_at >= $${values.length}`);
    }
    const result = await database.tenantQuery(tenantId,
      `SELECT state, session_id, channel FROM conversation_sessions
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`,
      values
    );
    return result.rows.map((row) => readState(row.state, {
      tenantId,
      channel:row.channel,
      sessionId:row.session_id
    }));
  };

  return {
    driver:"postgres",
    mutate,
    beginTurn,
    recordTurn,
    failStaleReceipts,
    get,
    listStates,
    status:() => ({
      driver:"postgres", durable:true, shared:true, configured:database.configured,
      field_encryption:fieldEncryption.enabled ? "aes-256-gcm" : "development-plaintext"
    })
  };
}

let defaultStore;
export const getPostgresAcquisitionSessionStore = () => {
  if (!defaultStore) defaultStore = createPostgresAcquisitionSessionStore();
  return defaultStore;
};
