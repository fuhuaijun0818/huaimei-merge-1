import { hasPhaseOneCapability } from "../platform/phase-one-role-policy.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createContactVaultEncryption } from "../platform/contact-vault-encryption.mjs";
import { appendAuditEvent, ensureTenant, jsonValue, postgres } from "./postgres-helpers.mjs";
import { lockAppointmentForContact } from "./appointment-state-store.mjs";
import { lockPrivacyContactSubject } from "./postgres-contact-suppression-guard.mjs";

const sha256Pattern = /^[0-9a-f]{64}$/;
const handoverPattern = /^ho_[a-f0-9-]+$/i;
const actorPattern = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{1,159}$/;
const revealRequestPattern = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{7,159}$/;

const contactError = (code, message, status = 409, details = []) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};

const normalizedMobile = (value) => {
  const digits = String(value ?? "").normalize("NFKC").replace(/\D/g, "");
  if (/^1[3-9]\d{9}$/.test(digits)) return digits;
  return digits.replace(/^(?:00)?86/, "");
};
const maskMobile = (mobile) => `${mobile.slice(0, 3)}****${mobile.slice(-4)}`;
const productionEnvironment = (env) => ["prod", "production"].includes(String(
  env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "development"
).trim().toLowerCase());

const contactContext = (row) => ({
  tenantId:row.tenant_id,
  contactReference:row.contact_reference,
  leadRecordId:row.lead_record_id,
  subjectReferenceHmac:row.subject_reference_hmac
});

const validatePersistInput = ({ tenantId, leadRecordId, subjectReferenceHmac, mobile, verification }, production) => {
  const normalized = normalizedMobile(mobile);
  if (!tenantId || !/^[0-9a-f-]{32,64}$/i.test(String(leadRecordId || ""))
      || !sha256Pattern.test(String(subjectReferenceHmac || ""))
      || !/^1[3-9]\d{9}$/.test(normalized)) {
    throw contactError("CONTACT_VAULT_INPUT_INVALID", "Contact-vault persistence input is invalid", 400);
  }
  if (!String(verification?.verification_id || "").trim()
      || verification?.method !== "format_validation"
      || verification?.status !== "pending_manual") {
    throw contactError("CONTACT_VAULT_CAPTURE_REQUIRED", "A format-validated contact capture is required", 409);
  }
  return normalized;
};

export async function persistContactInLeadTransaction(client, options = {}) {
  const env = options.env || process.env;
  const production = options.production ?? productionEnvironment(env);
  const encryption = options.encryption || createContactVaultEncryption({ env, production });
  const mobile = validatePersistInput(options, production);
  const tenantId = String(options.tenantId).trim().toLowerCase();
  const leadRecordId = String(options.leadRecordId);
  const subjectReferenceHmac = String(options.subjectReferenceHmac).trim().toLowerCase();
  const verificationId = String(options.verification.verification_id).trim().slice(0, 160);
  const verificationMethod = options.verification.method;

  const captureUse = await client.query(
    `SELECT contact_reference,lead_record_id,subject_reference_hmac
     FROM contact_vault_entries
     WHERE tenant_id=$1 AND ownership_verification_id=$2
     FOR UPDATE`,
    [tenantId, verificationId]
  );
  if (captureUse.rowCount
      && (String(captureUse.rows[0].lead_record_id) !== leadRecordId
        || captureUse.rows[0].subject_reference_hmac !== subjectReferenceHmac)) {
    throw contactError(
      "CONTACT_VAULT_CAPTURE_REPLAYED",
      "The contact capture receipt is already bound to another contact",
      409
    );
  }

  const current = await client.query(
    `SELECT * FROM contact_vault_entries
     WHERE tenant_id=$1 AND lead_record_id=$2 AND contact_type='mobile'
     FOR UPDATE`,
    [tenantId, leadRecordId]
  );
  if (current.rowCount && current.rows[0].subject_reference_hmac !== subjectReferenceHmac && options.allowSubjectRotation !== true) {
    throw contactError(
      "CONTACT_VAULT_SUBJECT_CONFLICT",
      "The lead contact vault is already bound to another captured subject",
      409
    );
  }
  const contactReference = current.rows[0]?.contact_reference
    || `contact_${randomUUID().replaceAll("-", "")}`;
  const context = {
    tenantId,
    contactReference,
    leadRecordId,
    subjectReferenceHmac
  };
  const envelope = encryption.encryptMobile(mobile, context);
  const phoneVerificationStatus = "pending_manual";
  const saved = await client.query(
    `INSERT INTO contact_vault_entries
      (tenant_id,contact_reference,lead_record_id,subject_reference_hmac,
       contact_type,purpose,encrypted_value,masked_value,encryption_key_id,
       ownership_verification_id,ownership_verification_method,ownership_verified_at,
       phone_verification_status,status)
     VALUES ($1,$2,$3,$4,'mobile','service_callback',$5::jsonb,$6,$7,$8,$9,NULL,$10,'active')
     ON CONFLICT (tenant_id,lead_record_id,contact_type)
     DO UPDATE SET
       subject_reference_hmac=EXCLUDED.subject_reference_hmac,
       encrypted_value=EXCLUDED.encrypted_value,
       masked_value=EXCLUDED.masked_value,
       encryption_key_id=EXCLUDED.encryption_key_id,
       ownership_verification_id=EXCLUDED.ownership_verification_id,
       ownership_verification_method=EXCLUDED.ownership_verification_method,
       ownership_verified_at=EXCLUDED.ownership_verified_at,
       phone_verification_status=EXCLUDED.phone_verification_status,
       status='active',
       erased_at=NULL
     RETURNING contact_reference,masked_value,encryption_key_id,created_at,updated_at`,
    [tenantId, contactReference, leadRecordId, subjectReferenceHmac,
      JSON.stringify(envelope), maskMobile(mobile), envelope.key_id,
      verificationId, verificationMethod, phoneVerificationStatus]
  );
  await appendAuditEvent(client, {
    tenantId,
    eventId:`audit_contact_persist_${createHash("sha256").update(`${tenantId}:${verificationId}`).digest("hex")}`,
    action:current.rowCount ? "contact.vault_updated" : "contact.vault_created",
    resourceType:"contact_vault_entry",
    resourceId:contactReference,
    actorType:"service",
    actorId:"huamei-acquisition-agent",
    outcome:"success",
    details:{
      contact_type:"mobile",
      purpose:"service_callback",
      capture_method:verificationMethod,
      phone_verification_status:phoneVerificationStatus,
      encrypted:true,
      key_id:envelope.key_id
    }
  });
  return {
    contact_reference:saved.rows[0].contact_reference,
    contact_type:"mobile",
    masked_value:saved.rows[0].masked_value,
    purpose:"service_callback",
    phone_verification_status:phoneVerificationStatus,
    durable:true,
    encrypted:true,
    key_id:saved.rows[0].encryption_key_id,
    created_at:new Date(saved.rows[0].created_at).toISOString(),
    updated_at:new Date(saved.rows[0].updated_at).toISOString()
  };
}

const deniedResult = (code, message, status = 409) => ({ denied:{ code, message, status } });

export function createPostgresContactVaultStore(options = {}) {
  const env = options.env || process.env;
  const production = options.production ?? productionEnvironment(env);
  const database = options.postgres || postgres();
  const encryption = options.encryption || createContactVaultEncryption({ env, production });

  const persistInTransaction = (client, input) => persistContactInLeadTransaction(client, {
    ...input,
    env,
    production,
    encryption
  });

  const revealForClaimedHandover = async ({
    tenantId,
    handoverId,
    appointmentId,
    actor,
    authorizedPrincipal,
    revealRequestId,
    requestId = null
  }) => {
    const normalizedTenant = String(tenantId || "").trim().toLowerCase();
    const normalizedHandover = String(appointmentId || handoverId || "").trim();
    const resourceType = appointmentId ? "appointment_registration" : "handover";
    const normalizedActor = String(actor || "").trim();
    const normalizedRevealRequest = String(revealRequestId || "").trim();
    if (!normalizedTenant || !(appointmentId ? /^apt_[a-f0-9-]+$/i : handoverPattern).test(normalizedHandover)
        || !actorPattern.test(normalizedActor)
        || !revealRequestPattern.test(normalizedRevealRequest)) {
      throw contactError("CONTACT_REVEAL_REQUEST_INVALID", "Contact reveal request is invalid", 400);
    }
    const requestDigest = createHash("sha256")
      .update(`${normalizedTenant}:${normalizedHandover}:${normalizedActor}:${normalizedRevealRequest}`)
      .digest("hex");
    const result = await database.tenantTransaction(normalizedTenant, async (client) => {
      await ensureTenant(client, normalizedTenant);
      const attempt = await client.query(
        `INSERT INTO audit_events
          (tenant_id,event_id,actor_type,actor_id,action,resource_type,
           resource_id,request_id,outcome,details)
         VALUES ($1,$2,'human',$3,'contact.reveal_attempted',$7,$4,$5,'unknown',$6::jsonb)
         ON CONFLICT (tenant_id,event_id) DO NOTHING
         RETURNING id`,
        [normalizedTenant, `audit_contact_reveal_attempt_${requestDigest}`, normalizedActor,
          normalizedHandover, requestId,
          JSON.stringify({ purpose:"service_callback", disclosure_type:"mobile" }), resourceType]
      );
      if (!attempt.rowCount) {
        return deniedResult(
          "CONTACT_REVEAL_REPLAYED",
          "该联系方式查看请求已使用，请重新点击查看",
          409
        );
      }

      const reveal = appointmentId ? { rows:[] } : await client.query(
        `SELECT
           h.handover_id,h.status AS handover_status,h.assignee,
           s.lead_id,
           l.normalized_mobile_hmac,
           c.contact_reference,c.lead_record_id,c.subject_reference_hmac,
           c.contact_type,c.purpose,c.encrypted_value,c.masked_value,
           c.encryption_key_id,c.status AS contact_status
         FROM handovers h
         JOIN conversation_sessions s
           ON s.tenant_id=h.tenant_id AND s.id=h.session_record_id
         LEFT JOIN leads l
           ON l.tenant_id=s.tenant_id AND l.id=s.lead_id
         LEFT JOIN contact_vault_entries c
           ON c.tenant_id=l.tenant_id AND c.lead_record_id=l.id AND c.contact_type='mobile'
         WHERE h.tenant_id=$1 AND h.handover_id=$2
         FOR UPDATE OF h`,
        [normalizedTenant, normalizedHandover]
      );
      let row = reveal.rows[0];
      if (appointmentId) {
        const appointment = await lockAppointmentForContact(client, normalizedTenant, normalizedHandover);
        if (appointment) {
          const contacts = await client.query(`SELECT l.normalized_mobile_hmac, c.* FROM conversation_sessions s
            LEFT JOIN leads l ON l.tenant_id=s.tenant_id AND l.id=s.lead_id
            LEFT JOIN contact_vault_entries c ON c.tenant_id=l.tenant_id AND c.lead_record_id=l.id AND c.contact_type='mobile'
            WHERE s.tenant_id=$1 AND s.channel=$2 AND (s.session_id=$3 OR s.external_conversation_id=$3) LIMIT 2`, [normalizedTenant, appointment.channel, appointment.conversation_id]);
          const contact = (contacts.rows.length === 1 ? contacts.rows[0] : null) || {};
          row = { ...contact, contact_status:contact.status, handover_status:appointment.status === "registered" && appointment.followup_status !== "completed" ? "claimed" : "closed", assignee:appointment.assignee };
        }
      }
      let denial = null;
      if (!row) denial = deniedResult("HANDOVER_NOT_FOUND", "未找到指定转人工任务", 404);
      else if (row.handover_status !== "claimed" || !row.assignee) {
        denial = deniedResult("CONTACT_REVEAL_HANDOVER_NOT_CLAIMED", "必须先由实名顾问接管后才能查看联系方式", 409);
      } else if (row.assignee !== normalizedActor && !hasPhaseOneCapability(authorizedPrincipal,"contacts:reveal_all")) {
        denial = deniedResult("CONTACT_REVEAL_ASSIGNEE_MISMATCH", "只有当前接管顾问可以查看联系方式", 403);
      } else if (!row.contact_reference || row.contact_status !== "active") {
        denial = deniedResult("CONTACT_REVEAL_UNAVAILABLE", "该接管任务没有可用的联系方式", 409);
      } else if (row.normalized_mobile_hmac !== row.subject_reference_hmac) {
        denial = deniedResult("CONTACT_REVEAL_SUBJECT_MISMATCH", "联系方式主体绑定校验失败", 409);
      }

      if (!denial) {
        await lockPrivacyContactSubject(client, {
          tenantId:normalizedTenant,
          subjectReferenceHmac:row.subject_reference_hmac
        });
        const consent = await client.query(
          `SELECT 1 FROM consents
           WHERE tenant_id=$1 AND lead_record_id=$2 AND consent_type='service'
             AND is_current AND granted AND revoked_at IS NULL
           LIMIT 1`,
          [normalizedTenant, row.lead_record_id]
        );
        if (!consent.rowCount) {
          denial = deniedResult("CONTACT_REVEAL_SERVICE_CONSENT_REQUIRED", "本次咨询服务联系授权已失效", 409);
        }
      }
      if (!denial) {
        const suppression = await client.query(
          `SELECT 1 FROM contact_suppressions
           WHERE tenant_id=$1 AND subject_reference_hmac=$2 AND status='active'
             AND purpose = ANY($3::text[])
           LIMIT 1`,
          [normalizedTenant, row.subject_reference_hmac, ["service", "all"]]
        );
        if (suppression.rowCount) {
          denial = deniedResult("CONTACT_REVEAL_SUPPRESSED", "客户已撤回或限制本次服务联系", 409);
        }
      }

      if (denial) {
        await appendAuditEvent(client, {
          tenantId:normalizedTenant,
          eventId:`audit_contact_reveal_denied_${requestDigest}`,
          action:"contact.reveal_denied",
          resourceType,
          resourceId:normalizedHandover,
          actorType:"human",
          actorId:normalizedActor,
          requestId,
          outcome:"denied",
          details:{ purpose:"service_callback", reason_code:denial.denied.code }
        });
        return denial;
      }

      let mobile;
      try {
        mobile = encryption.decryptMobile(
          jsonValue(row.encrypted_value, {}),
          contactContext({ ...row, tenant_id:normalizedTenant })
        );
      } catch {
        await appendAuditEvent(client, {
          tenantId:normalizedTenant,
          eventId:`audit_contact_reveal_failed_${requestDigest}`,
          action:"contact.reveal_failed",
          resourceType:"contact_vault_entry",
          resourceId:row.contact_reference,
          actorType:"human",
          actorId:normalizedActor,
          requestId,
          outcome:"failure",
          details:{ purpose:"service_callback", reason_code:"CONTACT_VAULT_DECRYPTION_FAILED" }
        });
        return deniedResult("CONTACT_VAULT_DECRYPTION_FAILED", "联系方式保险库暂时不可用", 503);
      }
      await appendAuditEvent(client, {
        tenantId:normalizedTenant,
        eventId:`audit_contact_reveal_success_${requestDigest}`,
        action:"contact.revealed",
        resourceType:"contact_vault_entry",
        resourceId:row.contact_reference,
        actorType:"human",
        actorId:normalizedActor,
        requestId,
        outcome:"success",
        details:{
          [appointmentId ? "appointment_id" : "handover_id"]:normalizedHandover,
          purpose:"service_callback",
          disclosure_type:"mobile",
          assignee_verified:row.assignee===normalizedActor,
          supervisor_access:hasPhaseOneCapability(authorizedPrincipal,"contacts:reveal_all"),
          service_consent_verified:true,
          suppression_checked:true
        }
      });
      return {
        data:{
          contact_reference:row.contact_reference,
          contact_type:"mobile",
          value:mobile,
          masked_value:row.masked_value,
          purpose:"service_callback",
          disclosure:"explicit_one_time_view",
          browser_storage_allowed:false
        }
      };
    });
    if (result.denied) {
      throw contactError(
        result.denied.code,
        result.denied.message,
        result.denied.status
      );
    }
    return result.data;
  };

  // Server-internal decrypt used by the audited manual member re-check.  The
  // plaintext never leaves the server: the caller only forwards it to the member
  // directory client, and every read is recorded as its own audit event.
  const readMobileForMemberCheck = async ({
    client, tenantId, leadRecordId, subjectReferenceHmac, actor, requestId = null
  } = {}) => {
    const normalizedTenant = String(tenantId || "").trim().toLowerCase();
    const normalizedActor = String(actor || "").trim();
    if (!normalizedTenant || !leadRecordId || !actorPattern.test(normalizedActor)) {
      throw contactError("CONTACT_MEMBER_CHECK_REQUEST_INVALID", "Member re-check request is invalid", 400);
    }
    const result = await client.query(
      `SELECT contact_reference,lead_record_id,subject_reference_hmac,contact_type,status,
              encrypted_value,masked_value,encryption_key_id
       FROM contact_vault_entries
       WHERE tenant_id=$1 AND lead_record_id=$2 AND contact_type='mobile'
       FOR UPDATE`,
      [normalizedTenant, leadRecordId]
    );
    const row = result.rows[0];
    if (!row || row.status !== "active") {
      throw contactError("CONTACT_VAULT_UNAVAILABLE", "该客户没有可用的手机号保存记录", 409);
    }
    if (row.subject_reference_hmac !== subjectReferenceHmac) {
      throw contactError("CONTACT_VAULT_SUBJECT_MISMATCH", "联系方式主体绑定校验失败", 409);
    }
    let mobile;
    try {
      mobile = encryption.decryptMobile(
        jsonValue(row.encrypted_value, {}),
        contactContext({ ...row, tenant_id:normalizedTenant })
      );
    } catch {
      await appendAuditEvent(client, {
        tenantId:normalizedTenant, action:"contact.member_check_read_failed",
        resourceType:"contact_vault_entry", resourceId:row.contact_reference,
        actorType:"human", actorId:normalizedActor, requestId, outcome:"failure",
        details:{ reason_code:"CONTACT_VAULT_DECRYPTION_FAILED", purpose:"member_check" }
      });
      throw contactError("CONTACT_VAULT_DECRYPTION_FAILED", "联系方式保险库暂时不可用", 503);
    }
    await appendAuditEvent(client, {
      tenantId:normalizedTenant, action:"contact.member_check_read",
      resourceType:"contact_vault_entry", resourceId:row.contact_reference,
      actorType:"human", actorId:normalizedActor, requestId, outcome:"success",
      details:{ purpose:"member_check", reason:"manual_member_recheck", masking:row.masked_value }
    });
    return mobile;
  };

  const readiness = async (tenantId) => {
    if (!encryption.enabled) {
      return { ok:false, status:"not_ready", encryption:"missing", storage:"postgres" };
    }
    try {
      const result = await database.tenantQuery(tenantId,
        `SELECT to_regclass('public.contact_vault_entries')::text AS relation`,
        []
      );
      const ok = result.rows[0]?.relation === "contact_vault_entries";
      return {
        ok,
        status:ok ? "ready" : "not_ready",
        encryption:"aes-256-gcm-envelope",
        active_key_id:encryption.activeKeyId,
        storage:"postgres"
      };
    } catch {
      return { ok:false, status:"not_ready", encryption:"configured", storage:"postgres" };
    }
  };

  return Object.freeze({
    persistInTransaction,
    readMobileForMemberCheck,
    revealForClaimedHandover,
    revealForClaimedAppointment:(input) => revealForClaimedHandover({ ...input, handoverId:undefined }),
    readiness,
    status:() => ({
      driver:"postgres",
      durable:true,
      encrypted:encryption.enabled,
      encryption:encryption.enabled ? "aes-256-gcm-envelope" : "missing",
      active_key_id:encryption.activeKeyId
    })
  });
}

let defaultStore;
export const getPostgresContactVaultStore = () => {
  if (!defaultStore) defaultStore = createPostgresContactVaultStore();
  return defaultStore;
};

export const resetPostgresContactVaultStoreForTest = () => { defaultStore = undefined; };
