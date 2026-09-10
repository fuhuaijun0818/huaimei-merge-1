import { createHash } from "node:crypto";
import { assertLangGraphTurnDecision } from "../langgraph-orchestrator-contract.mjs";
import { appendAuditEvent, appendOutboxEvent, jsonValue, postgres } from "./postgres-helpers.mjs";

const opaqueIdPattern = /^[A-Za-z0-9._:-]{1,160}$/;
const engineNames = new Set(["legacy", "shadow", "langgraph"]);

const protocolError = (code, message, details = undefined) => {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};
const opaque = (name, value) => {
  const normalized = String(value || "").trim();
  if (!opaqueIdPattern.test(normalized)) throw protocolError("LANGGRAPH_TURN_FIELD_INVALID", `${name} is invalid`, { field:name });
  return normalized;
};
const positiveInt = (name, value, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw protocolError("LANGGRAPH_TURN_FIELD_INVALID", `${name} is invalid`, { field:name });
  }
  return normalized;
};
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalize(value[key]);
    return result;
  }, {});
  return value;
};
const jsonHash = (value) => createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
const sameJson = (left, right) => jsonHash(left) === jsonHash(right);
const normalizeEnginePin = (value = {}) => {
  const engine = String(value.engine || "").trim();
  if (!engineNames.has(engine)) throw protocolError("LANGGRAPH_ENGINE_PIN_INVALID", "engine pin is invalid");
  return {
    engine,
    graph_version:opaque("graph_version", value.graph_version),
    state_schema_version:opaque("state_schema_version", value.state_schema_version)
  };
};
const normalizeStoredPin = (value) => {
  try { return normalizeEnginePin(jsonValue(value, {})); }
  catch { throw protocolError("LANGGRAPH_ENGINE_PIN_INVALID", "stored session engine pin is invalid"); }
};
const normalizeLeaseMs = (value) => Math.min(Math.max(Number(value) || 15_000, 1_000), 120_000);

const lockConversationIdentity = async (client, { tenantId, channel, sessionId }) => {
  const key = `conversation-session:${tenantId}:${channel}:${sessionId}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
};

const loadSessionForUpdate = async (client, { tenantId, channel, sessionId }) => {
  const result = await client.query(
    `SELECT id, session_id, channel, state_version, next_commit_sequence,
            engine_pin, handover_epoch, fencing_counter
       FROM conversation_sessions
      WHERE tenant_id=$1 AND channel=$2 AND session_id=$3
      FOR UPDATE`,
    [tenantId, channel, sessionId]
  );
  if (!result.rows[0]) {
    throw protocolError("LANGGRAPH_TURN_RECEIPT_REQUIRED", "The inbound turn must be durably accepted before orchestration");
  }
  return result.rows[0];
};

const verifyInboundReceipt = async (client, { tenantId, sessionRecordId, messageId, turnSequence }) => {
  const result = await client.query(
    `SELECT message_id, turn_sequence, processing_state, metadata
       FROM conversation_messages
      WHERE tenant_id=$1 AND session_record_id=$2 AND message_id=$3
        AND role='user' AND direction='inbound'
      LIMIT 1`,
    [tenantId, sessionRecordId, messageId]
  );
  const row = result.rows[0];
  if (!row) throw protocolError("LANGGRAPH_TURN_RECEIPT_REQUIRED", "The inbound turn receipt does not exist");
  if (Number(row.turn_sequence) !== turnSequence) {
    throw protocolError("LANGGRAPH_TURN_SEQUENCE_MISMATCH", "Turn sequence does not match the accepted inbound receipt");
  }
  if (row.processing_state !== "received") {
    throw protocolError("LANGGRAPH_TURN_RECEIPT_NOT_ACTIVE", "The inbound turn is no longer available for preparation", {
      processing_state:row.processing_state
    });
  }
  return row;
};

const activeLeaseForUpdate = async (client, { tenantId, sessionRecordId, fencingToken }) => {
  const result = await client.query(
    `SELECT id, fencing_token, holder_id, expires_at
       FROM agent_turn_leases
      WHERE tenant_id=$1 AND session_record_id=$2 AND fencing_token=$3
        AND status='active' AND expires_at > clock_timestamp()
      FOR UPDATE`,
    [tenantId, sessionRecordId, fencingToken]
  );
  if (!result.rows[0]) {
    throw protocolError("LANGGRAPH_TURN_FENCE_STALE", "The turn executor lease is missing, expired, or superseded");
  }
  return result.rows[0];
};

const turnResultFromRow = (row) => ({
  id:row.id,
  inbound_message_id:row.inbound_message_id,
  turn_sequence:Number(row.turn_sequence),
  expected_state_version:Number(row.expected_state_version),
  fencing_token:Number(row.fencing_token),
  engine_pin:jsonValue(row.engine_pin, {}),
  status:row.status,
  decision_status:row.decision_status,
  run_id:row.run_id || null,
  checkpoint_id:row.checkpoint_id || null,
  decision_hash:row.decision_hash,
  decision:jsonValue(row.decision, {}),
  prepared_at:row.prepared_at ? new Date(row.prepared_at).toISOString() : null,
  committed_at:row.committed_at ? new Date(row.committed_at).toISOString() : null,
  expires_at:row.expires_at ? new Date(row.expires_at).toISOString() : null
});

/**
 * Node-owned durable side of the LangGraph turn protocol. This store does not
 * send channel messages, call a model, or execute a business command. P0-A
 * only permits immutable preparation plus a no-effect domain commit marker.
 */
export function createPostgresLangGraphTurnStore(options = {}) {
  const database = options.postgres || postgres();
  const defaultLeaseMs = normalizeLeaseMs(options.leaseMs ?? process.env.HUAMEI_LANGGRAPH_TURN_LEASE_MS);

  const acquireLease = async ({ tenantId, channel, sessionId, holderId, enginePin, leaseMs = defaultLeaseMs }) =>
    database.tenantTransaction(tenantId, async (client) => {
      const normalizedChannel = opaque("channel", channel);
      const normalizedSessionId = opaque("session_id", sessionId);
      const normalizedHolderId = opaque("holder_id", holderId);
      const normalizedPin = normalizeEnginePin(enginePin);
      await lockConversationIdentity(client, { tenantId, channel:normalizedChannel, sessionId:normalizedSessionId });
      const session = await loadSessionForUpdate(client, { tenantId, channel:normalizedChannel, sessionId:normalizedSessionId });
      const storedPin = normalizeStoredPin(session.engine_pin);
      if (!sameJson(storedPin, normalizedPin)) {
        throw protocolError("LANGGRAPH_ENGINE_PIN_MISMATCH", "The session is pinned to a different agent engine", {
          expected:storedPin,
          actual:normalizedPin
        });
      }
      await client.query(
        `UPDATE agent_turn_leases
            SET status='expired', released_at=clock_timestamp()
          WHERE tenant_id=$1 AND session_record_id=$2
            AND status='active' AND expires_at <= clock_timestamp()`,
        [tenantId, session.id]
      );
      const active = await client.query(
        `SELECT fencing_token, holder_id, expires_at
           FROM agent_turn_leases
          WHERE tenant_id=$1 AND session_record_id=$2
            AND status='active' AND expires_at > clock_timestamp()
          LIMIT 1 FOR UPDATE`,
        [tenantId, session.id]
      );
      if (active.rows[0]) {
        throw protocolError("LANGGRAPH_TURN_LEASE_BUSY", "Another executor still owns this conversation turn", {
          holder_id:active.rows[0].holder_id,
          fencing_token:Number(active.rows[0].fencing_token)
        });
      }
      const fenced = await client.query(
        `UPDATE conversation_sessions
            SET fencing_counter=fencing_counter+1,
                last_activity_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2
        RETURNING fencing_counter, state_version, next_commit_sequence, handover_epoch`,
        [tenantId, session.id]
      );
      const fencingToken = Number(fenced.rows[0].fencing_counter);
      const boundedLeaseMs = normalizeLeaseMs(leaseMs);
      const lease = await client.query(
        `INSERT INTO agent_turn_leases
          (tenant_id, session_record_id, fencing_token, holder_id, expires_at)
         VALUES ($1,$2,$3,$4,clock_timestamp() + ($5::bigint * interval '1 millisecond'))
         RETURNING id, fencing_token, holder_id, acquired_at, expires_at`,
        [tenantId, session.id, fencingToken, normalizedHolderId, boundedLeaseMs]
      );
      return {
        lease_id:lease.rows[0].id,
        fencing_token:fencingToken,
        holder_id:normalizedHolderId,
        acquired_at:new Date(lease.rows[0].acquired_at).toISOString(),
        expires_at:new Date(lease.rows[0].expires_at).toISOString(),
        expected_state_version:Number(fenced.rows[0].state_version),
        next_commit_sequence:Number(fenced.rows[0].next_commit_sequence),
        handover_epoch:Number(fenced.rows[0].handover_epoch),
        engine_pin:normalizedPin
      };
    });

  const prepareDecision = async ({
    tenantId, channel, sessionId, messageId, turnSequence, expectedStateVersion,
    fencingToken, enginePin, decision, expiresAt = null, traceId = null
  }) => database.tenantTransaction(tenantId, async (client) => {
    const normalizedChannel = opaque("channel", channel);
    const normalizedSessionId = opaque("session_id", sessionId);
    const normalizedMessageId = opaque("message_id", messageId);
    const normalizedTurnSequence = positiveInt("turn_sequence", turnSequence);
    const normalizedStateVersion = positiveInt("expected_state_version", expectedStateVersion, { minimum:0 });
    const normalizedFencingToken = positiveInt("fencing_token", fencingToken);
    const normalizedPin = normalizeEnginePin(enginePin);
    const validatedDecision = assertLangGraphTurnDecision(decision, {
      stateSchemaVersion:normalizedPin.state_schema_version
    });
    if (validatedDecision.pending_action_preview?.external_effect === true) {
      throw protocolError("LANGGRAPH_DECISION_EFFECT_FORBIDDEN", "P0 decisions may not contain an external effect");
    }
    await lockConversationIdentity(client, { tenantId, channel:normalizedChannel, sessionId:normalizedSessionId });
    const session = await loadSessionForUpdate(client, { tenantId, channel:normalizedChannel, sessionId:normalizedSessionId });
    if (!sameJson(normalizeStoredPin(session.engine_pin), normalizedPin)) {
      throw protocolError("LANGGRAPH_ENGINE_PIN_MISMATCH", "The session is pinned to a different agent engine");
    }
    if (Number(session.state_version) !== normalizedStateVersion) {
      throw protocolError("LANGGRAPH_STATE_VERSION_STALE", "The conversation state changed before the decision could be prepared", {
        expected_state_version:normalizedStateVersion,
        actual_state_version:Number(session.state_version)
      });
    }
    if (Number(session.next_commit_sequence) !== normalizedTurnSequence) {
      throw protocolError("LANGGRAPH_TURN_SEQUENCE_STALE", "This turn is not the next committable conversation sequence", {
        expected_turn_sequence:Number(session.next_commit_sequence),
        actual_turn_sequence:normalizedTurnSequence
      });
    }
    await activeLeaseForUpdate(client, {
      tenantId, sessionRecordId:session.id, fencingToken:normalizedFencingToken
    });
    await verifyInboundReceipt(client, {
      tenantId, sessionRecordId:session.id, messageId:normalizedMessageId, turnSequence:normalizedTurnSequence
    });
    const existing = await client.query(
      `SELECT * FROM agent_turn_results
        WHERE tenant_id=$1 AND session_record_id=$2 AND inbound_message_id=$3
        LIMIT 1 FOR UPDATE`,
      [tenantId, session.id, normalizedMessageId]
    );
    if (existing.rows[0]) {
      const stored = turnResultFromRow(existing.rows[0]);
      if (stored.decision_hash !== validatedDecision.decision_hash || !sameJson(stored.engine_pin, normalizedPin)) {
        throw protocolError("LANGGRAPH_PREPARED_DECISION_CONFLICT", "A different decision is already prepared for this message");
      }
      return { replay:true, turn_result:stored };
    }
    const inserted = await client.query(
      `INSERT INTO agent_turn_results
        (tenant_id, session_record_id, inbound_message_id, turn_sequence,
         expected_state_version, fencing_token, engine_pin, status, decision_status,
         run_id, checkpoint_id, decision_hash, decision, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'prepared',$8,$9,$10,$11,$12::jsonb,$13)
       RETURNING *`,
      [tenantId, session.id, normalizedMessageId, normalizedTurnSequence,
        normalizedStateVersion, normalizedFencingToken, JSON.stringify(normalizedPin),
        validatedDecision.status, validatedDecision.run_id, validatedDecision.checkpoint_id,
        validatedDecision.decision_hash, JSON.stringify(validatedDecision), expiresAt]
    );
    const stored = turnResultFromRow(inserted.rows[0]);
    await appendAuditEvent(client, {
      tenantId,
      action:"langgraph.turn.prepared",
      resourceType:"conversation_message",
      resourceId:`${normalizedSessionId}:${normalizedMessageId}`,
      actorType:"service",
      actorId:"huamei-langgraph-turn-store",
      traceId,
      details:{
        turn_sequence:normalizedTurnSequence,
        state_version:normalizedStateVersion,
        fencing_token:normalizedFencingToken,
        engine_pin:normalizedPin,
        decision_hash:validatedDecision.decision_hash,
        decision_status:validatedDecision.status,
        checkpoint_id:validatedDecision.checkpoint_id
      }
    });
    return { replay:false, turn_result:stored };
  });

  const commitPreparedDecision = async ({
    tenantId, channel, sessionId, messageId, fencingToken, traceId = null, actorId = "huamei-langgraph-turn-store"
  }) => database.tenantTransaction(tenantId, async (client) => {
    const normalizedChannel = opaque("channel", channel);
    const normalizedSessionId = opaque("session_id", sessionId);
    const normalizedMessageId = opaque("message_id", messageId);
    const normalizedFencingToken = positiveInt("fencing_token", fencingToken);
    await lockConversationIdentity(client, { tenantId, channel:normalizedChannel, sessionId:normalizedSessionId });
    const session = await loadSessionForUpdate(client, { tenantId, channel:normalizedChannel, sessionId:normalizedSessionId });
    const result = await client.query(
      `SELECT * FROM agent_turn_results
        WHERE tenant_id=$1 AND session_record_id=$2 AND inbound_message_id=$3
        LIMIT 1 FOR UPDATE`,
      [tenantId, session.id, normalizedMessageId]
    );
    const prepared = result.rows[0];
    if (!prepared) throw protocolError("LANGGRAPH_PREPARED_DECISION_REQUIRED", "No prepared decision exists for this message");
    if (prepared.status === "committed") return { replay:true, turn_result:turnResultFromRow(prepared) };
    if (Number(prepared.fencing_token) !== normalizedFencingToken) {
      throw protocolError("LANGGRAPH_TURN_FENCE_STALE", "Prepared decision belongs to an older executor fence");
    }
    await activeLeaseForUpdate(client, { tenantId, sessionRecordId:session.id, fencingToken:normalizedFencingToken });
    if (prepared.status !== "prepared") {
      throw protocolError("LANGGRAPH_PREPARED_DECISION_NOT_COMMITTABLE", "The prepared decision is no longer committable", {
        status:prepared.status
      });
    }
    if (Number(session.state_version) !== Number(prepared.expected_state_version)
      || Number(session.next_commit_sequence) !== Number(prepared.turn_sequence)) {
      throw protocolError("LANGGRAPH_COMMIT_COMPARE_AND_SET_FAILED", "Conversation state or sequence changed before commit", {
        expected_state_version:Number(prepared.expected_state_version),
        actual_state_version:Number(session.state_version),
        expected_turn_sequence:Number(prepared.turn_sequence),
        actual_next_commit_sequence:Number(session.next_commit_sequence)
      });
    }
    const committed = await client.query(
      `UPDATE agent_turn_results
          SET status='committed', committed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND status='prepared'
      RETURNING *`,
      [tenantId, prepared.id]
    );
    if (!committed.rows[0]) throw protocolError("LANGGRAPH_COMMIT_COMPARE_AND_SET_FAILED", "Prepared decision was changed by another executor");
    await client.query(
      `UPDATE agent_turn_leases
          SET status='released', released_at=clock_timestamp()
        WHERE tenant_id=$1 AND session_record_id=$2 AND fencing_token=$3 AND status='active'`,
      [tenantId, session.id, normalizedFencingToken]
    );
    const stored = turnResultFromRow(committed.rows[0]);
    await appendAuditEvent(client, {
      tenantId,
      action:"langgraph.turn.committed",
      resourceType:"conversation_message",
      resourceId:`${normalizedSessionId}:${normalizedMessageId}`,
      actorType:"service",
      actorId:opaque("actor_id", actorId),
      traceId,
      details:{
        turn_sequence:stored.turn_sequence,
        fencing_token:stored.fencing_token,
        decision_hash:stored.decision_hash,
        decision_status:stored.decision_status,
        no_external_effect:true,
        no_channel_delivery:true
      }
    });
    await appendOutboxEvent(client, {
      tenantId,
      aggregateType:"conversation_session",
      aggregateId:normalizedSessionId,
      eventType:"langgraph.turn.committed",
      payload:{
        session_id:normalizedSessionId,
        inbound_message_id:normalizedMessageId,
        turn_sequence:stored.turn_sequence,
        decision_hash:stored.decision_hash,
        decision_status:stored.decision_status,
        no_external_effect:true,
        no_channel_delivery:true
      }
    });
    return { replay:false, turn_result:stored };
  });

  const releaseLease = async ({ tenantId, channel, sessionId, fencingToken }) =>
    database.tenantTransaction(tenantId, async (client) => {
      const normalizedChannel = opaque("channel", channel);
      const normalizedSessionId = opaque("session_id", sessionId);
      const normalizedFencingToken = positiveInt("fencing_token", fencingToken);
      await lockConversationIdentity(client, { tenantId, channel:normalizedChannel, sessionId:normalizedSessionId });
      const session = await loadSessionForUpdate(client, { tenantId, channel:normalizedChannel, sessionId:normalizedSessionId });
      const released = await client.query(
        `UPDATE agent_turn_leases
            SET status='released', released_at=clock_timestamp()
          WHERE tenant_id=$1 AND session_record_id=$2 AND fencing_token=$3 AND status='active'
        RETURNING id`,
        [tenantId, session.id, normalizedFencingToken]
      );
      return { released:released.rowCount > 0 };
    });

  return { acquireLease, prepareDecision, commitPreparedDecision, releaseLease };
}

let defaultStore;
export const getPostgresLangGraphTurnStore = () => {
  if (!defaultStore) defaultStore = createPostgresLangGraphTurnStore();
  return defaultStore;
};
