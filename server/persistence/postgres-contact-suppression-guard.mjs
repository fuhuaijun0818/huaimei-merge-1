const SUPPRESSIBLE_PURPOSES = new Set([
  "service",
  "marketing",
  "privacy",
  "photo",
  "medical_data"
]);

export const MANDATORY_CONTACT_PURPOSES = new Set([
  "legal_obligation",
  "privacy_rights_status"
]);

export const CONTACT_TASK_TYPES_BY_PURPOSE = Object.freeze({
  marketing:Object.freeze(["outbound_contact", "marketing_follow_up", "campaign_contact"]),
  service:Object.freeze(["human_handover", "follow_up", "appointment_callback", "service_callback"])
});

const contactError = (code, message, status = 409, details = []) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};

const normalizePurpose = (value) => String(value || "").trim().toLowerCase();
const normalizeSubjectReference = (value) => String(value || "").trim().toLowerCase();
const normalizeInitiation = (value) => String(value || "proactive").trim().toLowerCase();

export const contactPurposeForTaskType = (taskType) => {
  const normalized = String(taskType || "").trim().toLowerCase();
  for (const [purpose, taskTypes] of Object.entries(CONTACT_TASK_TYPES_BY_PURPOSE)) {
    if (taskTypes.includes(normalized)) return purpose;
  }
  return null;
};

export async function lockPrivacyContactSubject(client, { tenantId, subjectReferenceHmac }) {
  const subjectReference = normalizeSubjectReference(subjectReferenceHmac);
  if (!/^[0-9a-f]{64}$/.test(subjectReference)) {
    throw contactError(
      "PRIVACY_CONTACT_SUBJECT_REQUIRED",
      "创建主动联系或重建授权前必须关联已核验的客户主体",
      409
    );
  }
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`privacy-contact:${tenantId}:${subjectReference}`]
  );
  return subjectReference;
}

export async function assertPrivacyContactPurposeAllowed(client, {
  tenantId,
  subjectReferenceHmac,
  purpose,
  operation = "contact_write",
  initiation = "proactive",
  lock = true
}) {
  const normalizedPurpose = normalizePurpose(purpose);
  const normalizedInitiation = normalizeInitiation(initiation);
  if (MANDATORY_CONTACT_PURPOSES.has(normalizedPurpose)) {
    return { allowed:true, purpose:normalizedPurpose, exemption:"mandatory_notification" };
  }
  if (!SUPPRESSIBLE_PURPOSES.has(normalizedPurpose)) {
    throw contactError("PRIVACY_PURPOSE_INVALID", "联系用途无效", 400);
  }
  if (["customer_inbound", "urgent_safety"].includes(normalizedInitiation)) {
    if (normalizedPurpose !== "service") {
      throw contactError(
        "PRIVACY_CONTACT_EXEMPTION_INVALID",
        "客户入站或紧急安全豁免仅可用于当前服务响应",
        400
      );
    }
    return {
      allowed:true,
      purpose:normalizedPurpose,
      exemption:normalizedInitiation
    };
  }
  if (normalizedInitiation !== "proactive") {
    throw contactError(
      "PRIVACY_CONTACT_INITIATION_REQUIRED",
      "联系任务必须明确声明主动、客户入站或紧急安全来源",
      400
    );
  }
  const subjectReference = lock
    ? await lockPrivacyContactSubject(client, { tenantId, subjectReferenceHmac })
    : normalizeSubjectReference(subjectReferenceHmac);
  if (!/^[0-9a-f]{64}$/.test(subjectReference)) {
    throw contactError(
      "PRIVACY_CONTACT_SUBJECT_REQUIRED",
      "创建主动联系或重建授权前必须关联已核验的客户主体",
      409
    );
  }
  const suppression = await client.query(
    `SELECT purpose, reason
     FROM contact_suppressions
     WHERE tenant_id=$1 AND subject_reference_hmac=$2 AND status='active'
       AND purpose = ANY($3::text[])
     ORDER BY CASE purpose WHEN 'all' THEN 0 ELSE 1 END
     LIMIT 1`,
    [tenantId, subjectReference, [normalizedPurpose, "all"]]
  );
  if (suppression.rowCount) {
    throw contactError(
      "PRIVACY_CONTACT_SUPPRESSED",
      "该客户已限制当前用途联系，不得重新创建主动任务或授权",
      409,
      [{ purpose:normalizedPurpose, operation:String(operation || "contact_write").slice(0, 80) }]
    );
  }
  return { allowed:true, purpose:normalizedPurpose, exemption:null };
}
