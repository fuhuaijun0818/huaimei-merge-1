import { createHash, randomUUID } from "node:crypto";

import { createFieldEncryption, createFieldRecordId } from "../platform/field-encryption.mjs";
import {
  appendAuditEvent, appendOutboxEvent, jsonValue, postgres
} from "./postgres-helpers.mjs";
import {
  CONTACT_TASK_TYPES_BY_PURPOSE,
  MANDATORY_CONTACT_PURPOSES,
  lockPrivacyContactSubject
} from "./postgres-contact-suppression-guard.mjs";

const PURPOSES = new Set(["service", "marketing", "privacy", "photo", "medical_data", "all"]);
const AUTOMATIC_CONTACT_RESTRICTION_PURPOSES = new Set(["service", "marketing"]);
const CONSENT_PURPOSES = ["service", "marketing", "privacy", "photo", "medical_data"];
const AUTOMATIC_TYPES = new Set(["withdraw_consent", "restrict"]);
const MANUAL_TYPES = new Set(["export", "delete"]);
const ACTION_TYPES = {
  withdraw_consent:"withdraw_consent",
  restrict:"restrict_contact",
  export:"export_plan",
  delete:"delete_plan"
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const safeActor = (value) => String(value || "").trim().slice(0, 160);
const privacyError = (code, message, status = 400) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};
const privacyFieldContext = (tenantId, requestId, field) => ({
  tenantId,
  scope:`privacy.request.${field}`,
  recordId:requestId
});
const consentEvidenceContext = (tenantId, subjectReferenceHmac, consentType, evidenceHash) => ({
  tenantId,
  scope:"lead.consent.evidence",
  recordId:createFieldRecordId("lead.consent", {
    consent_type:consentType,
    evidence_hash:evidenceHash,
    subject_reference_hmac:subjectReferenceHmac
  }),
  legacyRecordId:`${subjectReferenceHmac}:${consentType}:${evidenceHash}`
});
const normalizePurposes = (values = []) => [...new Set((Array.isArray(values) ? values : [])
  .map((value) => String(value || "").trim().toLowerCase())
  .filter(Boolean))].sort();
const canonicalChecksum = (value) => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");
const cancellableTaskTypes = (purposes) => {
  const selected = purposes.includes("all") ? ["marketing", "service"] : purposes;
  return [...new Set(selected.flatMap((purpose) => CONTACT_TASK_TYPES_BY_PURPOSE[purpose] || []))];
};
const policyVersion = () => String(
  process.env.HUAMEI_PRIVACY_POLICY_VERSION || "phase1-consultation-v1"
).slice(0, 64);

const actionFromRow = (row) => row ? {
  action_id:row.action_id,
  tenant_id:row.tenant_id,
  request_id:row.request_id,
  action_type:row.action_type,
  execution_mode:row.execution_mode,
  status:row.status,
  purposes:[...(row.purposes || [])],
  processor_id:row.processor_id,
  approver_id:row.approver_id,
  requirements:clone(jsonValue(row.requirements, {})),
  outcome:clone(jsonValue(row.outcome, {})),
  approved_at:row.approved_at ? new Date(row.approved_at).toISOString() : null,
  completed_at:row.completed_at ? new Date(row.completed_at).toISOString() : null,
  created_at:new Date(row.created_at).toISOString(),
  updated_at:new Date(row.updated_at).toISOString()
} : null;

const manualRequirements = (requestType, legalHold, purposes = []) => requestType === "export"
  ? {
      automatic_execution:false,
      required_controls:[
        "approved_export_scope",
        "third_party_redaction",
        "encrypted_private_object_storage",
        "controlled_delivery",
        "expiry_and_destruction_evidence"
      ]
    }
  : requestType === "restrict"
    ? {
        automatic_execution:false,
        restriction_scope:[...purposes],
        required_controls:[
          "approved_data_category_inventory",
          "processing_path_disable_controls",
          "downstream_processor_restriction_receipts",
          "legal_hold_and_retention_review",
          "independent_completion_evidence"
        ],
        legal_hold_active:Boolean(legalHold)
      }
    : {
      automatic_execution:false,
      required_controls:[
        "approved_retention_schedule",
        "legal_hold_review",
        "complete_system_inventory",
        "contact_vault_ciphertext_and_key_inventory",
        "contact_vault_cryptographic_erasure_or_record_deletion",
        "object_storage_and_graphrag_plan",
        "backup_replay_plan",
        "downstream_receipts"
      ],
      legal_hold_active:Boolean(legalHold)
    };

const readVerifiedRequest = (row, fieldEncryption) => {
  const identityEvidence = fieldEncryption.decryptJson(
    jsonValue(row.identity_evidence, {}),
    privacyFieldContext(row.tenant_id, row.request_id, "identity_evidence")
  );
  const scope = fieldEncryption.decryptJson(
    jsonValue(row.scope, {}),
    privacyFieldContext(row.tenant_id, row.request_id, "scope")
  );
  if (identityEvidence?.status !== "verified") {
    throw privacyError(
      "PRIVACY_IDENTITY_VERIFICATION_REQUIRED",
      "执行个人信息权利请求前必须完成身份核验",
      409
    );
  }
  if (row.status !== "in_progress") {
    throw privacyError(
      "PRIVACY_EXECUTION_REQUEST_NOT_IN_PROGRESS",
      "个人信息权利请求必须处于处理中才能准备或批准执行",
      409
    );
  }
  return { identityEvidence, scope };
};

export function createPostgresPrivacyExecutionStore(options = {}) {
  const database = options.postgres || postgres();
  const fieldEncryption = options.fieldEncryption || createFieldEncryption({ env:options.env || process.env });

  const prepare = async ({ tenantId, requestId, processorId }) => database.tenantTransaction(
    tenantId,
    async (client) => {
      const processor = safeActor(processorId);
      if (!processor) throw privacyError("PRIVACY_PROCESSOR_ID_REQUIRED", "处理人实名身份缺失", 403);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `privacy-execution:${tenantId}:${requestId}`
      ]);
      const selected = await client.query(
        `SELECT * FROM data_subject_requests
         WHERE tenant_id=$1 AND request_id=$2
         FOR UPDATE`,
        [tenantId, requestId]
      );
      if (!selected.rowCount) {
        throw privacyError("PRIVACY_REQUEST_NOT_FOUND", "未找到个人信息权利请求", 404);
      }
      const request = selected.rows[0];
      if (!AUTOMATIC_TYPES.has(request.request_type) && !MANUAL_TYPES.has(request.request_type)) {
        throw privacyError(
          "PRIVACY_EXECUTION_TYPE_UNSUPPORTED",
          "当前请求类型不在一期受控执行范围内",
          409
        );
      }
      const { scope } = readVerifiedRequest(request, fieldEncryption);
      const purposes = normalizePurposes(scope?.purposes);
      if (AUTOMATIC_TYPES.has(request.request_type)) {
        if (!purposes.length || purposes.some((purpose) => !PURPOSES.has(purpose))) {
          throw privacyError(
            "PRIVACY_PURPOSE_SCOPE_REQUIRED",
            "撤回同意或限制联系必须在原请求中明确具体用途范围",
            409
          );
        }
        if (purposes.includes("all") && purposes.length > 1) {
          throw privacyError(
            "PRIVACY_PURPOSE_SCOPE_AMBIGUOUS",
            "用途范围不能同时包含all和其他用途",
            409
          );
        }
      }
      const actionType = ACTION_TYPES[request.request_type];
      const processingRestrictionRequiresManualExecution = request.request_type === "restrict"
        && purposes.some((purpose) => !AUTOMATIC_CONTACT_RESTRICTION_PURPOSES.has(purpose));
      const executionMode = MANUAL_TYPES.has(request.request_type)
        || processingRestrictionRequiresManualExecution
        ? "manual"
        : "automatic";
      const checksum = canonicalChecksum({ request_id:requestId, request_type:request.request_type, purposes });
      const existing = await client.query(
        `SELECT * FROM privacy_execution_actions
         WHERE tenant_id=$1 AND request_id=$2 AND action_type=$3`,
        [tenantId, requestId, actionType]
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.input_checksum !== checksum || row.processor_id !== processor) {
          throw privacyError(
            "PRIVACY_EXECUTION_REPLAY_CONFLICT",
            "该请求已由另一处理人或另一范围准备",
            409
          );
        }
        return actionFromRow(row);
      }
      const actionId = `privacy_action_${randomUUID()}`;
      const requirements = executionMode === "manual"
        ? manualRequirements(request.request_type, request.legal_hold, purposes)
        : { automatic_execution:true, two_person_approval:true };
      const inserted = await client.query(
        `INSERT INTO privacy_execution_actions
          (tenant_id,action_id,request_id,action_type,execution_mode,status,purposes,
           input_checksum,processor_id,requirements)
         VALUES ($1,$2,$3,$4,$5,'planned',$6::text[],$7,$8,$9::jsonb)
         RETURNING *`,
        [tenantId, actionId, requestId, actionType, executionMode, purposes,
          checksum, processor, JSON.stringify(requirements)]
      );
      await appendAuditEvent(client, {
        tenantId,
        eventId:`audit_privacy_execution_prepared_${actionId}`,
        action:"privacy.execution.prepared",
        resourceType:"privacy_execution_action",
        resourceId:actionId,
        actorType:"human",
        actorId:processor,
        details:{ request_id:requestId, action_type:actionType, execution_mode:executionMode, purpose_count:purposes.length }
      });
      await appendOutboxEvent(client, {
        tenantId,
        eventId:`outbox_privacy_execution_prepared_${actionId}`,
        aggregateType:"privacy_execution_action",
        aggregateId:actionId,
        eventType:"privacy.execution.prepared",
        payload:{ request_id:requestId, action_id:actionId, action_type:actionType, execution_mode:executionMode }
      });
      return actionFromRow(inserted.rows[0]);
    }
  );

  const approve = async ({ tenantId, requestId, approverId }) => database.tenantTransaction(
    tenantId,
    async (client) => {
      const approver = safeActor(approverId);
      if (!approver) throw privacyError("PRIVACY_APPROVER_ID_REQUIRED", "复核人实名身份缺失", 403);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `privacy-execution:${tenantId}:${requestId}`
      ]);
      const selected = await client.query(
        `SELECT a.*, r.request_type, r.status AS request_status, r.legal_hold,
           r.subject_reference_hmac, r.identity_evidence, r.scope
         FROM privacy_execution_actions a
         JOIN data_subject_requests r
           ON r.tenant_id=a.tenant_id AND r.request_id=a.request_id
         WHERE a.tenant_id=$1 AND a.request_id=$2
         FOR UPDATE OF a, r`,
        [tenantId, requestId]
      );
      if (!selected.rowCount) {
        throw privacyError(
          "PRIVACY_EXECUTION_NOT_PREPARED",
          "请先由隐私处理人准备执行范围",
          409
        );
      }
      const row = selected.rows[0];
      if (row.processor_id === approver) {
        throw privacyError(
          "PRIVACY_SEPARATION_OF_DUTIES_REQUIRED",
          "处理人与复核人必须是两个不同的实名账号",
          403
        );
      }
      const identityEvidence = fieldEncryption.decryptJson(
        jsonValue(row.identity_evidence, {}),
        privacyFieldContext(tenantId, requestId, "identity_evidence")
      );
      if (safeActor(identityEvidence?.verified_by) === approver) {
        throw privacyError(
          "PRIVACY_SEPARATION_OF_DUTIES_REQUIRED",
          "身份核验人与终态复核人必须是两个不同的实名账号",
          403
        );
      }
      if (["executed", "manual_pending"].includes(row.status)) return actionFromRow(row);
      readVerifiedRequest({
        ...row,
        status:row.request_status,
        request_id:requestId,
        tenant_id:tenantId
      }, fieldEncryption);

      const now = new Date().toISOString();
      if (row.execution_mode === "manual") {
        const processingRestrictionPlan = row.action_type === "restrict_contact";
        const outcome = {
          automatic_execution:false,
          physical_deletion_performed:false,
          export_artifact_created:false,
          processing_restriction_applied:false,
          manual_plan_pending:true,
          legal_hold_active:Boolean(row.legal_hold)
        };
        const updated = await client.query(
          `UPDATE privacy_execution_actions
           SET status='manual_pending', approver_id=$3, approved_at=clock_timestamp(),
             completed_at=clock_timestamp(), outcome=$4::jsonb
           WHERE tenant_id=$1 AND request_id=$2
           RETURNING *`,
          [tenantId, requestId, approver, JSON.stringify(outcome)]
        );
        const encryptedResult = fieldEncryption.encryptJson({
          action_reference:row.action_id,
          summary:processingRestrictionPlan
            ? "已生成受控处理限制计划，尚未声称完成任何处理路径限制"
            : "已生成受控人工执行计划，未自动导出或删除任何数据",
          retained_categories:[],
          retention_basis_reference:row.legal_hold ? "legal_hold_review_required" : "retention_review_required"
        }, privacyFieldContext(tenantId, requestId, "result"));
        await client.query(
          `UPDATE data_subject_requests
           SET result=$3::jsonb
           WHERE tenant_id=$1 AND request_id=$2`,
          [tenantId, requestId, JSON.stringify(encryptedResult)]
        );
        await appendAuditEvent(client, {
          tenantId,
          eventId:`audit_privacy_manual_pending_${row.action_id}`,
          action:"privacy.execution.manual_pending",
          resourceType:"privacy_execution_action",
          resourceId:row.action_id,
          actorType:"human",
          actorId:approver,
          details:{
            request_id:requestId,
            action_type:row.action_type,
            physical_action_performed:false,
            processing_restriction_applied:false
          }
        });
        await appendOutboxEvent(client, {
          tenantId,
          eventId:`outbox_privacy_manual_pending_${row.action_id}`,
          aggregateType:"privacy_execution_action",
          aggregateId:row.action_id,
          eventType:"privacy.execution.manual_pending",
          payload:{ request_id:requestId, action_id:row.action_id, action_type:row.action_type, physical_action_performed:false }
        });
        return actionFromRow(updated.rows[0]);
      }

      const purposes = [...(row.purposes || [])];
      const expandedConsentPurposes = purposes.includes("all") ? CONSENT_PURPOSES : purposes;
      const reason = row.action_type === "withdraw_consent" ? "consent_withdrawn" : "processing_restricted";
      // Serialize suppression activation with every lead/consent/task write for
      // the same tenant-scoped subject. This closes the check-then-insert race.
      await lockPrivacyContactSubject(client, {
        tenantId,
        subjectReferenceHmac:row.subject_reference_hmac
      });
      for (const purpose of purposes) {
        await client.query(
          `INSERT INTO contact_suppressions
            (tenant_id,subject_reference_hmac,purpose,status,reason,
             origin_request_id,last_request_id,last_action_id,created_by)
           VALUES ($1,$2,$3,'active',$4,$5,$5,$6,$7)
           ON CONFLICT (tenant_id,subject_reference_hmac,purpose) WHERE status='active'
           DO UPDATE SET reason=EXCLUDED.reason, last_request_id=EXCLUDED.last_request_id,
             last_action_id=EXCLUDED.last_action_id`,
          [tenantId, row.subject_reference_hmac, purpose, reason, requestId, row.action_id, approver]
        );
      }

      let revokedConsentCount = 0;
      if (row.action_type === "withdraw_consent") {
        const leads = await client.query(
          `SELECT id FROM leads
           WHERE tenant_id=$1 AND normalized_mobile_hmac=$2
           FOR UPDATE`,
          [tenantId, row.subject_reference_hmac]
        );
        for (const lead of leads.rows) {
          for (const consentType of expandedConsentPurposes) {
            await client.query(
              `UPDATE consents
               SET is_current=false,
                 revoked_at=CASE WHEN granted THEN COALESCE(revoked_at,clock_timestamp()) ELSE revoked_at END
               WHERE tenant_id=$1 AND lead_record_id=$2 AND consent_type=$3 AND is_current`,
              [tenantId, lead.id, consentType]
            );
            const evidence = {
              source:"privacy_request",
              request_id:requestId,
              action_id:row.action_id,
              decision:"withdrawn",
              approved_at:now
            };
            const evidenceHash = canonicalChecksum(evidence);
            const encryptedEvidence = fieldEncryption.encryptJson(
              evidence,
              consentEvidenceContext(tenantId, row.subject_reference_hmac, consentType, evidenceHash)
            );
            await client.query(
              `INSERT INTO consents
                (tenant_id,lead_record_id,consent_type,granted,policy_version,source,
                 evidence_hash,evidence,is_current,effective_at,revoked_at)
               VALUES ($1,$2,$3,false,$4,'privacy_request',$5,$6::jsonb,true,$7,NULL)`,
              [tenantId, lead.id, consentType, policyVersion(), evidenceHash,
                JSON.stringify(encryptedEvidence), now]
            );
            revokedConsentCount += 1;
          }
        }
      }

      const taskTypes = cancellableTaskTypes(purposes);
      const cancelledTasks = taskTypes.length
        ? await client.query(
            `UPDATE tasks t
             SET status='cancelled', completed_at=clock_timestamp(),
               result=jsonb_build_object('cancelled_by_privacy_action',true,'action_id',$3::text)
             FROM conversation_sessions s
             JOIN leads l ON l.tenant_id=s.tenant_id AND l.id=s.lead_id
             WHERE t.tenant_id=$1
               AND t.tenant_id=s.tenant_id AND t.session_record_id=s.id
               AND l.normalized_mobile_hmac=$2
               AND t.status IN ('pending','ready')
               AND t.task_type = ANY($4::text[])
             RETURNING t.id`,
            [tenantId, row.subject_reference_hmac, row.action_id, taskTypes]
          )
        : { rowCount:0 };
      const serviceContactRestricted = purposes.includes("service") || purposes.includes("all");
      const cancelledHandovers = serviceContactRestricted
        ? await client.query(
            `UPDATE handovers h
             SET status='cancelled', completed_at=clock_timestamp()
             FROM conversation_sessions s
             JOIN leads l ON l.tenant_id=s.tenant_id AND l.id=s.lead_id
             WHERE h.tenant_id=$1
               AND h.tenant_id=s.tenant_id AND h.session_record_id=s.id
               AND l.normalized_mobile_hmac=$2
               AND h.status='pending'
             RETURNING h.id`,
            [tenantId, row.subject_reference_hmac]
          )
        : { rowCount:0 };
      const outcome = {
        automatic_execution:true,
        purposes_applied:purposes,
        suppressions_active:purposes.length,
        consent_records_withdrawn:revokedConsentCount,
        pending_tasks_cancelled:cancelledTasks.rowCount,
        pending_handovers_cancelled:cancelledHandovers.rowCount,
        active_human_work_terminated:false
      };
      const updated = await client.query(
        `UPDATE privacy_execution_actions
         SET status='executed', approver_id=$3, approved_at=clock_timestamp(),
           completed_at=clock_timestamp(), outcome=$4::jsonb
         WHERE tenant_id=$1 AND request_id=$2
         RETURNING *`,
        [tenantId, requestId, approver, JSON.stringify(outcome)]
      );
      const encryptedResult = fieldEncryption.encryptJson({
        action_reference:row.action_id,
        summary:row.action_type === "withdraw_consent"
          ? "已按明确用途撤回同意并停止相应用途联系"
          : "已按明确用途限制联系和未开始的主动触达",
        retained_categories:["minimal_audit_evidence"],
        retention_basis_reference:"approved_privacy_retention_policy"
      }, privacyFieldContext(tenantId, requestId, "result"));
      await client.query(
        `UPDATE data_subject_requests
         SET status='fulfilled', result=$3::jsonb, completed_at=clock_timestamp()
         WHERE tenant_id=$1 AND request_id=$2`,
        [tenantId, requestId, JSON.stringify(encryptedResult)]
      );
      await appendAuditEvent(client, {
        tenantId,
        eventId:`audit_privacy_executed_${row.action_id}`,
        action:"privacy.execution.executed",
        resourceType:"privacy_execution_action",
        resourceId:row.action_id,
        actorType:"human",
        actorId:approver,
        details:{
          request_id:requestId,
          action_type:row.action_type,
          purpose_count:purposes.length,
          pending_tasks_cancelled:cancelledTasks.rowCount,
          active_human_work_terminated:false
        }
      });
      await appendAuditEvent(client, {
        tenantId,
        eventId:`audit_privacy_fulfilled_${row.action_id}`,
        action:"privacy.request.fulfilled",
        resourceType:"data_subject_request",
        resourceId:requestId,
        actorType:"human",
        actorId:approver,
        details:{ action_id:row.action_id, action_type:row.action_type, execution_mode:"automatic" }
      });
      await appendOutboxEvent(client, {
        tenantId,
        eventId:`outbox_privacy_executed_${row.action_id}`,
        aggregateType:"privacy_execution_action",
        aggregateId:row.action_id,
        eventType:row.action_type === "withdraw_consent" ? "consent.withdrawn" : "privacy.processing.restricted",
        payload:{ request_id:requestId, action_id:row.action_id, purposes, active_human_work_terminated:false }
      });
      await appendOutboxEvent(client, {
        tenantId,
        eventId:`outbox_contact_suppressed_${row.action_id}`,
        aggregateType:"privacy_execution_action",
        aggregateId:row.action_id,
        eventType:"contact.suppressed",
        payload:{ request_id:requestId, action_id:row.action_id, purposes }
      });
      return actionFromRow(updated.rows[0]);
    }
  );

  const getByRequest = async ({ tenantId, requestId }) => {
    const result = await database.tenantQuery(
      tenantId,
      `SELECT * FROM privacy_execution_actions
       WHERE tenant_id=$1 AND request_id=$2`,
      [tenantId, requestId]
    );
    return actionFromRow(result.rows[0]);
  };

  const isSuppressed = async ({ tenantId, subjectReferenceHmac, purpose }) => {
    const normalizedPurpose = String(purpose || "").trim().toLowerCase();
    if (MANDATORY_CONTACT_PURPOSES.has(normalizedPurpose)) return false;
    if (!PURPOSES.has(normalizedPurpose) || normalizedPurpose === "all") {
      throw privacyError("PRIVACY_PURPOSE_INVALID", "联系用途无效");
    }
    const result = await database.tenantQuery(
      tenantId,
      `SELECT 1 FROM contact_suppressions
       WHERE tenant_id=$1 AND subject_reference_hmac=$2 AND status='active'
         AND purpose = ANY($3::text[])
       LIMIT 1`,
      [tenantId, subjectReferenceHmac, [normalizedPurpose, "all"]]
    );
    return result.rowCount > 0;
  };

  return { prepare, approve, getByRequest, isSuppressed };
}

let defaultStore;
export const getPostgresPrivacyExecutionStore = (options = {}) => {
  if (!defaultStore) defaultStore = createPostgresPrivacyExecutionStore(options);
  return defaultStore;
};
export const resetPostgresPrivacyExecutionStoreForTest = () => { defaultStore = undefined; };
