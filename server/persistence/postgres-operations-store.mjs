import { createHash, randomUUID } from "node:crypto";
import { createFieldEncryption, createFieldRecordId } from "../platform/field-encryption.mjs";
import {
  appendAuditEvent, appendOutboxEvent, ensureConversationSession, ensureTenant,
  jsonValue, postgres
} from "./postgres-helpers.mjs";
import {
  assertPrivacyContactPurposeAllowed,
  contactPurposeForTaskType
} from "./postgres-contact-suppression-guard.mjs";
import { redactContactPii } from "../platform/contact-pii-redaction.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const apiStatus = (status) => status === "claimed" ? "active" : status;
const databaseStatus = (status) => status === "active" ? "claimed" : status;
const apiPriority = (value) => Number(value) >= 90 ? "urgent" : "high";
const databasePriority = (value) => value === "urgent" ? 100 : 80;
const messagePayloadHash = (value) => createHash("sha256").update(String(value || "")).digest("hex");
const sessionStateContext = (tenantId, channel, sessionId) => ({
  tenantId,
  scope:"conversation.session.state",
  recordId:createFieldRecordId("conversation.session", { channel, session_id:sessionId }),
  legacyRecordId:`${channel}:${sessionId}`
});
const handoverSnapshotContext = (tenantId, handoverId) => ({
  tenantId,
  scope:"handover.snapshot",
  recordId:createFieldRecordId("handover", { handover_id:handoverId }),
  legacyRecordId:handoverId
});
const conversationMessageContext = (tenantId, channel, sessionId, messageId) => ({
  tenantId,
  scope:"conversation.message.content",
  recordId:createFieldRecordId("conversation.message", { channel, message_id:messageId, session_id:sessionId }),
  legacyRecordId:`${channel}:${sessionId}:${messageId}`
});
const humanWorkNotesContext = (tenantId, conversationId, staffId, recordedAt) => ({
  tenantId,
  scope:"human_work.notes",
  recordId:createFieldRecordId("human_work", {
    conversation_id:conversationId,
    recorded_at:recordedAt,
    staff_id:staffId
  }),
  legacyRecordId:`${conversationId}:${staffId}:${recordedAt}`
});
const completionPayloadHash = ({ actor, resolution, minutes, notes }) => createHash("sha256")
  .update(JSON.stringify({ actor, resolution, minutes:Number(minutes), notes:String(notes || "") }))
  .digest("hex");
const contactSafeText = (value, limit = 500, provided = null) => redactContactPii(
  typeof provided === "function" ? provided(value, limit) : String(value || "").trim().slice(0, limit)
).slice(0, limit);

const humanWorkFromRow = (row, { tenantId, conversationId }) => row ? ({
  id:`work_${row.id}`,
  tenant_id:tenantId,
  conversation_id:conversationId,
  handover_id:row.handover_id || null,
  staff_id:row.staff_id,
  work_type:row.work_type,
  minutes:Number(row.minutes),
  occurred_at:new Date(row.recorded_at).toISOString(),
  created_at:new Date(row.created_at).toISOString()
}) : null;

const handoverFromRow = (row, fieldEncryption) => {
  if (!row) return null;
  const snapshot = fieldEncryption.decryptJson(
    jsonValue(row.snapshot, {}),
    handoverSnapshotContext(row.tenant_id, row.handover_id)
  );
  return {
    ...snapshot,
    id:row.handover_id,
    task_id:row.task_id || snapshot.task_id || null,
    tenant_id:row.tenant_id,
    channel:row.channel || snapshot.channel,
    conversation_id:row.external_conversation_id || snapshot.conversation_id,
    team:row.team,
    reason:row.reason,
    priority:apiPriority(row.priority),
    status:apiStatus(row.status),
    ai_suspended:row.status === "claimed",
    assignee:row.assignee,
    sla_due_at:row.sla_due_at ? new Date(row.sla_due_at).toISOString() : null,
    created_at:row.created_at ? new Date(row.created_at).toISOString() : snapshot.created_at,
    claimed_at:row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    completed_at:row.completed_at ? new Date(row.completed_at).toISOString() : null,
    updated_at:row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
};

const handoverSelect = `
  SELECT h.*, s.channel, s.external_conversation_id,
    (SELECT t.task_id FROM tasks t
     WHERE t.tenant_id=h.tenant_id AND t.handover_record_id=h.id
     ORDER BY t.created_at ASC LIMIT 1) AS task_id
  FROM handovers h
  JOIN conversation_sessions s ON s.tenant_id=h.tenant_id AND s.id=h.session_record_id`;

export function createPostgresOperationsStore(options = {}) {
  const database = options.postgres || postgres();
  const fieldEncryption = options.fieldEncryption || createFieldEncryption({ env:options.env || process.env });

  const findOpenHandover = async ({ tenantId, channel, conversationId }) => {
    const result = await database.tenantQuery(tenantId,
      `${handoverSelect}
       WHERE h.tenant_id=$1 AND s.channel=$2 AND s.external_conversation_id=$3
         AND h.status IN ('pending','claimed')
       ORDER BY h.created_at DESC LIMIT 1`,
      [tenantId, channel, conversationId]
    );
    return handoverFromRow(result.rows[0], fieldEncryption);
  };

  const ensureHandoverTask = async ({ envelope, result, sessionSnapshot, safeText, contactInitiation = "proactive" }) => {
    if (result?.handover?.required !== true && result?.status !== "handover_required") return null;
    return database.tenantTransaction(envelope.tenant_id, async (client) => {
      const tenantId = envelope.tenant_id;
      const now = new Date();
      const reason = result?.handover?.reason || "human_requested";
      const urgent = ["medical_emergency", "critical_risk_continuity"].includes(reason);
      const priority = urgent ? "urgent" : "high";
      const slaMinutes = urgent ? 1 : 10;
      const session = await ensureConversationSession(client, {
        tenantId,
        sessionId:`${tenantId}:${envelope.channel}:${envelope.conversation_id}`,
        channel:envelope.channel,
        externalConversationId:envelope.conversation_id,
        state:fieldEncryption.encryptJson(
          {},
          sessionStateContext(tenantId, envelope.channel, `${tenantId}:${envelope.channel}:${envelope.conversation_id}`)
        ),
        expiresAt:new Date(now.getTime() + 30 * 60_000).toISOString()
      });
      const existing = await client.query(
        `${handoverSelect}
         WHERE h.tenant_id=$1 AND h.session_record_id=$2
           AND h.status IN ('pending','claimed')
         ORDER BY h.created_at DESC LIMIT 1 FOR UPDATE OF h`,
        [tenantId, session.id]
      );
      if (existing.rows[0]) return handoverFromRow(existing.rows[0], fieldEncryption);

      const taskType = "human_handover";
      const contactPurpose = contactPurposeForTaskType(taskType);
      if (!contactPurpose) {
        const error = new Error("The contact purpose mapping for the task type is missing");
        error.code = "PRIVACY_CONTACT_PURPOSE_MAPPING_REQUIRED";
        error.status = 500;
        throw error;
      }
      const subject = await client.query(
        `SELECT l.normalized_mobile_hmac
         FROM conversation_sessions s
         LEFT JOIN leads l
           ON l.tenant_id=s.tenant_id AND l.id=s.lead_id
         WHERE s.tenant_id=$1 AND s.id=$2`,
        [tenantId, session.id]
      );
      const effectiveContactInitiation = urgent ? "urgent_safety" : contactInitiation;
      const contactGate = await assertPrivacyContactPurposeAllowed(client, {
        tenantId,
        subjectReferenceHmac:subject.rows[0]?.normalized_mobile_hmac,
        purpose:contactPurpose,
        operation:"create_human_handover_task",
        initiation:effectiveContactInitiation
      });

      const handoverId = `ho_${randomUUID()}`;
      const taskId = `task_${randomUUID()}`;
      const slaDueAt = new Date(now.getTime() + slaMinutes * 60_000).toISOString();
      const snapshot = {
        task_id:taskId,
        channel:envelope.channel,
        conversation_id:envelope.conversation_id,
        external_user_id:envelope.actor?.external_user_id
          ? contactSafeText(envelope.actor.external_user_id, 128, safeText)
          : null,
        customer_id:envelope.actor?.customer_id
          ? contactSafeText(envelope.actor.customer_id, 128, safeText)
          : null,
        trigger_message_id:envelope.message.id,
        summary:contactSafeText(sessionSnapshot.conversation_summary || envelope.message.text, 500, safeText),
        known_slots:clone(sessionSnapshot.known_slots || {}),
        slot_sources:clone(sessionSnapshot.slot_sources || {}),
        projects:clone(sessionSnapshot.projects || []),
        doctors:clone(sessionSnapshot.doctors || []),
        pending_fields:clone(sessionSnapshot.pending_fields || []),
        conversation_goal:clone(sessionSnapshot.conversation_goal || {}),
        active_critical_risk:clone(sessionSnapshot.active_critical_risk || null),
        last_intent:sessionSnapshot.last_intent || null
      };
      const handoverInsert = await client.query(
        `INSERT INTO handovers
          (tenant_id, handover_id, session_record_id, status, reason, team,
           priority, snapshot, sla_due_at)
         VALUES ($1,$2,$3,'pending',$4,$5,$6,$7::jsonb,$8)
         RETURNING *`,
        [tenantId, handoverId, session.id, reason,
          result?.handover?.to_team || "人工咨询", databasePriority(priority),
          JSON.stringify(fieldEncryption.encryptJson(
            snapshot,
            handoverSnapshotContext(tenantId, handoverId)
          )), slaDueAt]
      );
      const handoverRecord = handoverInsert.rows[0];
      await client.query(
        `INSERT INTO tasks
          (tenant_id, task_id, handover_record_id, session_record_id, task_type,
           status, priority, payload, due_at)
         VALUES ($1,$2,$3,$4,$5,'pending',$6,$7::jsonb,$8)`,
        [tenantId, taskId, handoverRecord.id, session.id, taskType, databasePriority(priority),
          JSON.stringify({
            title:`${urgent ? "紧急" : "售前"}人工接管：${reason}`,
            team:handoverRecord.team,
            contact_purpose:contactPurpose,
            contact_initiation:effectiveContactInitiation,
            privacy_gate_exemption:contactGate.exemption
          }),
          slaDueAt]
      );
      await appendAuditEvent(client, {
        tenantId, action:"handover.requested", resourceType:"handover", resourceId:handoverId,
        details:{
          task_id:taskId,
          channel:envelope.channel,
          conversation_id:envelope.conversation_id,
          reason,
          priority,
          contact_purpose:contactPurpose,
          contact_initiation:effectiveContactInitiation,
          privacy_gate_exemption:contactGate.exemption
        }
      });
      await appendOutboxEvent(client, {
        tenantId, aggregateType:"handover", aggregateId:handoverId,
        eventType:"handover.requested", payload:{
          handover_id:handoverId,
          task_id:taskId,
          reason,
          priority,
          contact_purpose:contactPurpose,
          contact_initiation:effectiveContactInitiation,
          privacy_gate_exemption:contactGate.exemption
        }
      });
      return handoverFromRow({
        ...handoverRecord,
        task_id:taskId,
        channel:envelope.channel,
        external_conversation_id:envelope.conversation_id
      }, fieldEncryption);
    }).catch(async (error) => {
      if (error?.code !== "23505") throw error;
      return findOpenHandover({ tenantId:envelope.tenant_id, channel:envelope.channel, conversationId:envelope.conversation_id });
    });
  };

  const updateHandover = async ({ handoverId, tenantId, assignee, actor, resolution, action }) => database.tenantTransaction(tenantId, async (client) => {
    await ensureTenant(client, tenantId);
    if (action === "claim" && !String(assignee || "").trim()) {
      const error = new Error("接管任务必须指定assignee");
      error.code = "HANDOVER_ASSIGNEE_REQUIRED";
      throw error;
    }
    const locked = await client.query(
      `SELECT * FROM handovers WHERE tenant_id=$1 AND handover_id=$2 FOR UPDATE`,
      [tenantId, handoverId]
    );
    const current = locked.rows[0];
    if (!current) return null;
    if (action === "claim" && current.status === "claimed") {
      if (current.assignee === assignee) {
        const loaded = await client.query(`${handoverSelect} WHERE h.tenant_id=$1 AND h.handover_id=$2`, [tenantId, handoverId]);
        return handoverFromRow(loaded.rows[0], fieldEncryption);
      }
      const error = new Error("该转人工任务已由其他顾问接管");
      error.code = "HANDOVER_ALREADY_CLAIMED";
      throw error;
    }
    if (action === "complete") {
      if (current.status === "completed") {
        if (actor && actor === current.assignee) {
          const loaded = await client.query(`${handoverSelect} WHERE h.tenant_id=$1 AND h.handover_id=$2`, [tenantId, handoverId]);
          return handoverFromRow(loaded.rows[0], fieldEncryption);
        }
        const error = new Error("只有当前接管顾问可以完成该任务");
        error.code = "HANDOVER_ASSIGNEE_MISMATCH";
        throw error;
      }
      if (current.status !== "claimed" || !current.assignee) {
        const error = new Error("转人工任务必须先被顾问接管后才能完成");
        error.code = "HANDOVER_NOT_CLAIMED";
        throw error;
      }
      if (!actor || actor !== current.assignee) {
        const error = new Error("只有当前接管顾问可以完成该任务");
        error.code = "HANDOVER_ASSIGNEE_MISMATCH";
        throw error;
      }
    }
    if (!["pending", "claimed"].includes(current.status)) {
      if (action === "claim") {
        const error = new Error("该转人工任务已结束，不能再次接管");
        error.code = "HANDOVER_ALREADY_CLOSED";
        throw error;
      }
      const error = new Error("转人工任务必须先被顾问接管后才能完成");
      error.code = "HANDOVER_NOT_CLAIMED";
      throw error;
    }
    const nextStatus = action === "claim" ? "claimed" : "completed";
    const nextAssignee = action === "claim" ? assignee : (current.assignee || actor || "system");
    const currentSnapshot = fieldEncryption.decryptJson(
      jsonValue(current.snapshot, {}),
      handoverSnapshotContext(tenantId, handoverId)
    );
    const nextSnapshot = action === "complete"
      ? { ...currentSnapshot, completed_by:actor || nextAssignee, resolution }
      : currentSnapshot;
    await client.query(
      `UPDATE handovers SET status=$3::varchar, assignee=$4,
        claimed_at=CASE WHEN $3::text='claimed' THEN COALESCE(claimed_at,clock_timestamp()) ELSE claimed_at END,
        completed_at=CASE WHEN $3::text='completed' THEN clock_timestamp() ELSE completed_at END,
        snapshot=$5::jsonb
       WHERE tenant_id=$1 AND handover_id=$2`,
      [tenantId, handoverId, nextStatus, nextAssignee,
        JSON.stringify(fieldEncryption.encryptJson(
          nextSnapshot,
          handoverSnapshotContext(tenantId, handoverId)
        ))]
    );
    await client.query(
      `UPDATE tasks SET status=$3::varchar, assignee=$4,
        started_at=CASE WHEN $3::text='in_progress' THEN COALESCE(started_at,clock_timestamp()) ELSE started_at END,
        completed_at=CASE WHEN $3::text='completed' THEN clock_timestamp() ELSE completed_at END,
        result=CASE WHEN $3::text='completed' THEN $5::jsonb ELSE result END
       WHERE tenant_id=$1 AND handover_record_id=$2`,
      [tenantId, current.id, action === "claim" ? "in_progress" : "completed", nextAssignee,
        JSON.stringify(action === "complete"
          ? { handover_id:handoverId, resolution_recorded:true }
          : {})]
    );
    await appendAuditEvent(client, {
      tenantId, action:`handover.${action === "claim" ? "claimed" : "completed"}`,
      resourceType:"handover", resourceId:handoverId, actorType:"human", actorId:assignee || actor || "unknown",
      details:action === "complete" ? { resolution_recorded:Boolean(resolution) } : {}
    });
    await appendOutboxEvent(client, {
      tenantId, aggregateType:"handover", aggregateId:handoverId,
      eventType:`handover.${action === "claim" ? "claimed" : "completed"}`,
      payload:{ handover_id:handoverId, assignee:nextAssignee, resolution_recorded:Boolean(resolution) }
    });
    const result = await client.query(`${handoverSelect} WHERE h.tenant_id=$1 AND h.handover_id=$2`, [tenantId, handoverId]);
    return handoverFromRow(result.rows[0], fieldEncryption);
  });

  const completeHandoverWithWork = async ({
    handoverId,
    tenantId,
    actor,
    resolution,
    notes,
    minutes,
    workType = "handover_completion",
    completionPayloadHash:providedPayloadHash,
    safeText
  }) => {
    const sanitize = (value, limit = 500) => contactSafeText(value, limit, safeText);
    actor = sanitize(actor, 80);
    resolution = sanitize(resolution || "resolved", 200);
    notes = sanitize(notes, 500);
    minutes = Number(Number(minutes).toFixed(2));
    workType = "handover_completion";
    if (!actor) {
      const error = new Error("完结接管必须绑定实名操作人");
      error.code = "HANDOVER_ACTOR_REQUIRED";
      throw error;
    }
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1_440) {
      const error = new Error("人工付出时间必须是0–1440之间的分钟数");
      error.code = "INVALID_HUMAN_WORK_MINUTES";
      throw error;
    }
    const expectedPayloadHash = providedPayloadHash || completionPayloadHash({ actor, resolution, minutes, notes });
    return database.tenantTransaction(tenantId, async (client) => {
    await ensureTenant(client, tenantId);
    const locked = await client.query(
      `SELECT h.*, s.channel, s.external_conversation_id,
        task.id AS task_record_id, task.task_id
       FROM handovers h
       JOIN conversation_sessions s
         ON s.tenant_id=h.tenant_id AND s.id=h.session_record_id
       LEFT JOIN LATERAL (
         SELECT t.id, t.task_id FROM tasks t
         WHERE t.tenant_id=h.tenant_id AND t.handover_record_id=h.id
         ORDER BY t.created_at ASC LIMIT 1
       ) task ON true
       WHERE h.tenant_id=$1 AND h.handover_id=$2
       FOR UPDATE OF h`,
      [tenantId, handoverId]
    );
    const current = locked.rows[0];
    if (!current) return null;
    const currentSnapshot = fieldEncryption.decryptJson(
      jsonValue(current.snapshot, {}),
      handoverSnapshotContext(tenantId, handoverId)
    );

    if (current.status === "completed") {
      if (!actor || actor !== current.assignee) {
        const error = new Error("只有当前接管顾问可以完成该任务");
        error.code = "HANDOVER_ASSIGNEE_MISMATCH";
        throw error;
      }
      const workId = currentSnapshot.completion_work_id;
      const existing = workId ? await client.query(
        `SELECT w.*, $3::text AS handover_id
         FROM human_work w
         WHERE w.tenant_id=$1 AND w.id=$2 AND w.handover_record_id=$4
         LIMIT 1`,
        [tenantId, workId, handoverId, current.id]
      ) : { rows:[] };
      const existingWork = existing.rows[0];
      if (!existingWork) {
        const error = new Error("该任务曾通过旧流程完结，需由运营负责人补录并复核工时");
        error.code = "HANDOVER_COMPLETION_WORK_MISSING";
        throw error;
      }
      const recordedAt = new Date(existingWork.recorded_at).toISOString();
      const existingNotes = existingWork.notes
        ? fieldEncryption.decryptText(
          existingWork.notes,
          humanWorkNotesContext(tenantId, current.external_conversation_id, existingWork.staff_id, recordedAt)
        )
        : "";
      const actualPayloadHash = completionPayloadHash({
        actor:existingWork.staff_id,
        resolution:currentSnapshot.resolution || "resolved",
        minutes:Number(existingWork.minutes),
        notes:existingNotes
      });
      if (actualPayloadHash !== expectedPayloadHash) {
        const error = new Error("该接管任务已经按另一组处理结果和工时完结");
        error.code = "HANDOVER_COMPLETION_PAYLOAD_MISMATCH";
        throw error;
      }
      return {
        handover:handoverFromRow(current, fieldEncryption),
        human_work:humanWorkFromRow(existingWork, { tenantId, conversationId:current.external_conversation_id }),
        replayed:true
      };
    }
    if (current.status !== "claimed" || !current.assignee) {
      const error = new Error("转人工任务必须先被顾问接管后才能完成");
      error.code = "HANDOVER_NOT_CLAIMED";
      throw error;
    }
    if (!actor || actor !== current.assignee) {
      const error = new Error("只有当前接管顾问可以完成该任务");
      error.code = "HANDOVER_ASSIGNEE_MISMATCH";
      throw error;
    }

    const recordedAt = new Date().toISOString();
    const safeNotes = notes;
    const work = await client.query(
      `INSERT INTO human_work
        (tenant_id, session_record_id, handover_record_id, task_record_id,
         staff_id, work_type, minutes, notes, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, staff_id, work_type, minutes, notes, recorded_at, created_at`,
      [tenantId, current.session_record_id, current.id, current.task_record_id || null,
        actor, workType, minutes,
        safeNotes ? fieldEncryption.encryptText(
          safeNotes,
          humanWorkNotesContext(tenantId, current.external_conversation_id, actor, recordedAt)
        ) : null,
        recordedAt]
    );
    const workRow = { ...work.rows[0], handover_id:handoverId };
    const nextSnapshot = {
      ...currentSnapshot,
      completed_by:actor,
      resolution,
      completion_work_id:String(workRow.id)
    };
    await client.query(
      `UPDATE handovers SET status='completed', assignee=$3,
        completed_at=clock_timestamp(), snapshot=$4::jsonb
       WHERE tenant_id=$1 AND handover_id=$2`,
      [tenantId, handoverId, actor, JSON.stringify(fieldEncryption.encryptJson(
        nextSnapshot,
        handoverSnapshotContext(tenantId, handoverId)
      ))]
    );
    await client.query(
      `UPDATE tasks SET status='completed', assignee=$3,
        completed_at=clock_timestamp(),
        result=$4::jsonb
       WHERE tenant_id=$1 AND handover_record_id=$2`,
      [tenantId, current.id, actor, JSON.stringify({
        handover_id:handoverId,
        resolution_recorded:true,
        human_work_id:`work_${workRow.id}`,
        human_work_minutes:Number(workRow.minutes)
      })]
    );
    await appendAuditEvent(client, {
      tenantId,
      action:"handover.completed_with_work",
      resourceType:"handover",
      resourceId:handoverId,
      actorType:"human",
      actorId:actor,
      details:{
        work_log_id:`work_${workRow.id}`,
        minutes:Number(workRow.minutes),
        resolution_recorded:Boolean(resolution)
      }
    });
    await appendAuditEvent(client, {
      tenantId,
      action:"human_work.recorded",
      resourceType:"human_work",
      resourceId:String(workRow.id),
      actorType:"human",
      actorId:actor,
      details:{
        conversation_id:current.external_conversation_id,
        handover_id:handoverId,
        minutes:Number(workRow.minutes),
        source:"atomic_handover_completion"
      }
    });
    await appendOutboxEvent(client, {
      tenantId,
      aggregateType:"handover",
      aggregateId:handoverId,
      eventType:"handover.completed_with_work",
      payload:{
        handover_id:handoverId,
        assignee:actor,
        work_log_id:`work_${workRow.id}`,
        minutes:Number(workRow.minutes),
        resolution_recorded:Boolean(resolution)
      }
    });
    const completed = await client.query(
      `${handoverSelect} WHERE h.tenant_id=$1 AND h.handover_id=$2`,
      [tenantId, handoverId]
    );
    return {
      handover:handoverFromRow(completed.rows[0], fieldEncryption),
      human_work:humanWorkFromRow(workRow, { tenantId, conversationId:current.external_conversation_id }),
      replayed:false
    };
    });
  };

  const recordInbound = async (handover, envelope, safeText) => database.tenantTransaction(handover.tenant_id, async (client) => {
    const handoverRecord = await client.query(
      `SELECT h.id, h.session_record_id, s.session_id, s.channel
       FROM handovers h
       JOIN conversation_sessions s
         ON s.tenant_id=h.tenant_id AND s.id=h.session_record_id
       WHERE h.tenant_id=$1 AND h.handover_id=$2
       LIMIT 1`,
      [handover.tenant_id, handover.id]
    );
    if (!handoverRecord.rowCount) return null;
    const session = handoverRecord.rows[0];
    const completedAt = new Date().toISOString();
    const payloadHash = messagePayloadHash(envelope.message.text);
    const normalizedContent = contactSafeText(envelope.message.text, 1000, safeText);
    const contentContext = conversationMessageContext(
      handover.tenant_id,
      session.channel,
      session.session_id,
      envelope.message.id
    );
    const inserted = await client.query(
      `INSERT INTO conversation_messages
        (tenant_id, session_record_id, message_id, role, direction, content,
         metadata, occurred_at, processing_state, processing_attempts,
         processing_completed_at)
       VALUES ($1,$2,$3,'user','inbound',$4,$5::jsonb,$6,'completed',1,$6)
       ON CONFLICT (tenant_id, session_record_id, message_id) DO NOTHING
       RETURNING id`,
      [handover.tenant_id, session.session_record_id,
        envelope.message.id, fieldEncryption.encryptText(normalizedContent, contentContext),
        JSON.stringify({
          processing_state:"completed",
          delivery:"human_handover",
          handover_id:handover.id,
          payload_hash:payloadHash,
          completed_at:completedAt
        }), completedAt]
    );
    if (!inserted.rowCount) {
      const existing = await client.query(
        `SELECT role, direction, content, metadata
         FROM conversation_messages
         WHERE tenant_id=$1 AND session_record_id=$2 AND message_id=$3
         LIMIT 1`,
        [handover.tenant_id, session.session_record_id, envelope.message.id]
      );
      const metadata = jsonValue(existing.rows[0]?.metadata, {});
      const inboundIdentityMatches = existing.rows[0]?.role === "user"
        && existing.rows[0]?.direction === "inbound";
      const legacyContentMatches = !metadata.payload_hash
        && fieldEncryption.decryptText(existing.rows[0]?.content, contentContext) === normalizedContent;
      if (!inboundIdentityMatches || (metadata.payload_hash !== payloadHash && !legacyContentMatches)) {
        const error = new Error("The channel message id was already used with different content");
        error.code = "CONVERSATION_MESSAGE_ID_REUSED";
        throw error;
      }
      return { duplicate:true, message_id:envelope.message.id };
    }
    await appendAuditEvent(client, {
      tenantId:handover.tenant_id,
      action:"handover.inbound_received",
      resourceType:"handover",
      resourceId:handover.id,
      details:{
        channel:envelope.channel,
        conversation_id:envelope.conversation_id,
        message_id:envelope.message.id,
        message_hash:payloadHash,
        message_length:normalizedContent.length
      }
    });
    await appendOutboxEvent(client, {
      tenantId:handover.tenant_id,
      aggregateType:"handover",
      aggregateId:handover.id,
      eventType:"handover.inbound_received",
      payload:{
        handover_id:handover.id,
        channel:envelope.channel,
        conversation_id:envelope.conversation_id,
        message_id:envelope.message.id
      }
    });
    return { duplicate:false, message_id:envelope.message.id };
  });

  const recordHumanWork = async (payload, safeText) => database.tenantTransaction(payload.tenant_id, async (client) => {
    const tenantId = payload.tenant_id;
    await ensureTenant(client, tenantId);
    const channel = payload.channel || "api";
    const sessionId = `${tenantId}:${channel}:${payload.conversation_id}`;
    const recordedAt = new Date(payload.occurred_at || Date.now()).toISOString();
    const session = await ensureConversationSession(client, {
      tenantId,
      sessionId,
      channel,
      externalConversationId:payload.conversation_id,
      state:fieldEncryption.encryptJson({}, sessionStateContext(tenantId, channel, sessionId)),
      expiresAt:null
    });
    const handoverResult = payload.handover_id
      ? await client.query(`SELECT id FROM handovers WHERE tenant_id=$1 AND handover_id=$2`, [tenantId, payload.handover_id])
      : { rows:[] };
    const work = await client.query(
      `INSERT INTO human_work
        (tenant_id, session_record_id, handover_record_id, staff_id, work_type, minutes, notes, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, staff_id, work_type, minutes, notes, recorded_at, created_at`,
      [tenantId, session.id, handoverResult.rows[0]?.id || null, payload.staff_id,
        payload.work_type || "presales_service", payload.minutes,
        contactSafeText(payload.notes || "", 500, safeText)
          ? fieldEncryption.encryptText(
            contactSafeText(payload.notes || "", 500, safeText),
            humanWorkNotesContext(tenantId, payload.conversation_id, payload.staff_id, recordedAt)
          )
          : null,
        recordedAt]
    );
    const row = work.rows[0];
    await appendAuditEvent(client, {
      tenantId, action:"human_work.recorded", resourceType:"human_work", resourceId:String(row.id),
      actorType:"human", actorId:payload.staff_id,
      details:{ conversation_id:payload.conversation_id, handover_id:payload.handover_id || null, minutes:Number(row.minutes) }
    });
    return {
      id:`work_${row.id}`,
      tenant_id:tenantId,
      conversation_id:payload.conversation_id,
      handover_id:payload.handover_id || null,
      staff_id:row.staff_id,
      work_type:row.work_type,
      minutes:Number(row.minutes),
      occurred_at:new Date(row.recorded_at).toISOString(),
      created_at:new Date(row.created_at).toISOString()
    };
  });

  const listHandovers = async ({ tenantId, status = "", limit = 100 }) => {
    const values = [tenantId];
    const statusClause = status ? `AND h.status=$${values.push(databaseStatus(status))}` : "";
    values.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    const result = await database.tenantQuery(tenantId,
      `${handoverSelect} WHERE h.tenant_id=$1 ${statusClause}
       ORDER BY h.created_at DESC LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => handoverFromRow(row, fieldEncryption));
  };

  const getHandover = async ({ tenantId, handoverId }) => {
    const result = await database.tenantQuery(tenantId, `${handoverSelect} WHERE h.tenant_id=$1 AND h.handover_id=$2`, [tenantId, handoverId]);
    return handoverFromRow(result.rows[0], fieldEncryption);
  };

  const listTasks = async ({ tenantId, status = "", limit = 100 }) => {
    const values = [tenantId];
    const mappedStatus = status === "active" ? "in_progress" : status;
    const statusClause = mappedStatus ? `AND status=$${values.push(mappedStatus)}` : "";
    values.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    const result = await database.tenantQuery(tenantId,
      `SELECT task_id AS id, tenant_id, task_type AS type, status, priority,
        assignee, payload, result, due_at, created_at, updated_at
       FROM tasks WHERE tenant_id=$1 ${statusClause}
       ORDER BY created_at DESC LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => ({
      ...row,
      status:row.status === "in_progress" ? "active" : row.status,
      priority:apiPriority(row.priority),
      ...(jsonValue(row.payload, {})),
      due_at:row.due_at ? new Date(row.due_at).toISOString() : null,
      created_at:new Date(row.created_at).toISOString(),
      updated_at:new Date(row.updated_at).toISOString()
    }));
  };

  const metrics = async (tenantId) => {
    const result = await database.tenantQuery(tenantId,
      `SELECT
         count(*)::int AS handovers_total,
         count(*) FILTER (WHERE status IN ('pending','claimed'))::int AS handovers_open,
         count(*) FILTER (WHERE status='completed')::int AS handovers_completed,
         count(*) FILTER (WHERE claimed_at IS NOT NULL AND claimed_at <= sla_due_at)::int AS accepted_within_sla,
         (SELECT COALESCE(sum(minutes),0) FROM human_work w WHERE w.tenant_id=$1)::numeric AS human_work_minutes,
         (SELECT count(*) FROM human_work w WHERE w.tenant_id=$1)::int AS human_work_records
       FROM handovers WHERE tenant_id=$1`,
      [tenantId]
    );
    const row = result.rows[0];
    return {
      tenant_id:tenantId,
      handovers_total:row.handovers_total,
      handovers_open:row.handovers_open,
      handovers_completed:row.handovers_completed,
      forced_handover_sla_recall:row.handovers_total ? Number((row.accepted_within_sla / row.handovers_total).toFixed(4)) : null,
      human_work_minutes:Number(Number(row.human_work_minutes || 0).toFixed(2)),
      human_work_records:row.human_work_records,
      measurement_note:"需与同口径基线、服务量和连续4周数据结合，才能计算人均客户付出时间下降比例。",
      storage:{ driver:"postgres", durable:true, shared:true }
    };
  };

  const status = async (tenantId) => {
    if (!tenantId) {
      const error = new Error("tenantId is required for operations status");
      error.code = "POSTGRES_TENANT_CONTEXT_REQUIRED";
      throw error;
    }
    const result = await database.tenantQuery(tenantId,
      `SELECT
        (SELECT count(*) FROM handovers WHERE tenant_id=$1)::int AS handovers,
        (SELECT count(*) FROM tasks WHERE tenant_id=$1)::int AS tasks,
        (SELECT count(*) FROM audit_events WHERE tenant_id=$1)::int AS events,
        (SELECT count(*) FROM human_work WHERE tenant_id=$1)::int AS human_work_logs`,
      [tenantId]
    );
    return {
      driver:"postgres", durable:true, shared:true, ...result.rows[0],
      field_encryption:fieldEncryption.enabled ? "aes-256-gcm" : "development-plaintext"
    };
  };

  return {
    findOpenHandover,
    ensureHandoverTask,
    claimHandover:(input) => updateHandover({ ...input, action:"claim" }),
    completeHandover:(input) => updateHandover({ ...input, action:"complete" }),
    completeHandoverWithWork,
    recordInbound,
    recordHumanWork,
    listHandovers,
    getHandover,
    listTasks,
    metrics,
    status
  };
}

let defaultStore;
export const getPostgresOperationsStore = () => {
  if (!defaultStore) defaultStore = createPostgresOperationsStore();
  return defaultStore;
};
