import { hasPhaseOneCapability } from "./platform/phase-one-role-policy.mjs";
import { randomUUID } from "node:crypto";
import { postgresPersistenceEnabled } from "./persistence/postgres-helpers.mjs";
import { getPostgresContactVaultStore } from "./persistence/postgres-contact-vault-store.mjs";

// Development-only vault: deliberately process memory, never the lead JSON
// file. Production cannot select this backend because production readiness
// requires PostgreSQL plus the independent contact-vault keyring.
const memoryEntries = new Map();
const memoryRevealRequests = new Set();

const memoryKey = (tenantId, sessionId) => `${tenantId}:${sessionId}`;
// Same accepted shapes as the lead store: "+86 138 0000 0001", "0086 138-0000-0001"
// and "13800000001" must all normalize to the same eleven digits.
const normalizedMobile = (value) => {
  const digits = String(value ?? "").normalize("NFKC").replace(/\D/g, "");
  if (/^1[3-9]\d{9}$/.test(digits)) return digits;
  return digits.replace(/^(?:00)?86/, "");
};
const maskMobile = (mobile) => `${mobile.slice(0, 3)}****${mobile.slice(-4)}`;

export function persistDevelopmentMemoryContact({
  tenantId,
  sessionId,
  mobile,
  subjectReferenceHmac,
  verification
}) {
  const normalized = normalizedMobile(mobile);
  if (!/^1[3-9]\d{9}$/.test(normalized)
      || verification?.method !== "format_validation"
      || verification?.status !== "pending_manual") {
    const error = new Error("A format-validated contact capture is required");
    error.code = "CONTACT_VAULT_CAPTURE_REQUIRED";
    error.status = 409;
    throw error;
  }
  const contactReference = memoryEntries.get(memoryKey(tenantId, sessionId))?.contact_reference
    || `contact_${randomUUID().replaceAll("-", "")}`;
  memoryEntries.set(memoryKey(tenantId, sessionId), Object.freeze({
    tenant_id:tenantId,
    session_id:sessionId,
    contact_reference:contactReference,
    contact_type:"mobile",
    purpose:"service_callback",
    value:normalized,
    masked_value:maskMobile(normalized),
    subject_reference_hmac:subjectReferenceHmac,
    service_consent:true,
    capture_id:verification.verification_id,
    phone_verification_status:"pending_manual"
  }));
  return {
    contact_reference:contactReference,
    contact_type:"mobile",
    masked_value:maskMobile(normalized),
    purpose:"service_callback",
    durable:false,
    stored:true,
    phone_verification_status:"pending_manual",
    encrypted:false,
    storage:"development_process_memory"
  };
}

export async function revealContactForClaimedHandover(input = {}) {
  if (postgresPersistenceEnabled()) {
    return input.appointmentId ? getPostgresContactVaultStore().revealForClaimedAppointment(input) : getPostgresContactVaultStore().revealForClaimedHandover(input);
  }
  const { getHandover } = await import("./acquisition-operations-store.mjs");
  let handover;
  if (input.appointmentId) {
    const { getAppointmentIntake } = await import("./appointment-intake-store.mjs");
    const appointment = await getAppointmentIntake({ tenant_id:input.tenantId, appointment_intake_id:input.appointmentId });
    handover = appointment ? { ...appointment, status:appointment.status === "registered" && appointment.followup_status !== "completed" ? "claimed" : "closed" } : null;
  } else handover = await getHandover(input.handoverId, input.tenantId);
  if (!handover) {
    const error = new Error("未找到指定转人工任务");
    error.code = "HANDOVER_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  if (!["claimed", "active"].includes(handover.status) || !handover.assignee) {
    const error = new Error("必须先由实名顾问接管后才能查看联系方式");
    error.code = "CONTACT_REVEAL_HANDOVER_NOT_CLAIMED";
    error.status = 409;
    throw error;
  }
  if (handover.assignee !== input.actor && !hasPhaseOneCapability(input.authorizedPrincipal,"contacts:reveal_all")) {
    const error = new Error("只有当前接管顾问可以查看联系方式");
    error.code = "CONTACT_REVEAL_ASSIGNEE_MISMATCH";
    error.status = 403;
    throw error;
  }
  const replayKey = `${input.tenantId}:${input.actor}:${input.appointmentId || input.handoverId}:${input.revealRequestId}`;
  if (memoryRevealRequests.has(replayKey)) {
    const error = new Error("该联系方式查看请求已使用，请重新点击查看");
    error.code = "CONTACT_REVEAL_REPLAYED";
    error.status = 409;
    throw error;
  }
  memoryRevealRequests.add(replayKey);
  const entry = memoryEntries.get(memoryKey(input.tenantId, handover.conversation_id));
  if (!entry || entry.service_consent !== true) {
    const error = new Error("该接管任务没有可用的联系方式");
    error.code = "CONTACT_REVEAL_UNAVAILABLE";
    error.status = 409;
    throw error;
  }
  return {
    contact_reference:entry.contact_reference,
    contact_type:"mobile",
    value:entry.value,
    masked_value:entry.masked_value,
    purpose:"service_callback",
    disclosure:"explicit_one_time_view",
    browser_storage_allowed:false
  };
}

export function getContactVaultStatus() {
  if (postgresPersistenceEnabled()) return getPostgresContactVaultStore().status();
  return {
    driver:"development_process_memory",
    durable:false,
    encrypted:false,
    plaintext_json:false,
    production_allowed:false
  };
}

// Server-internal read of the development vault entry, used by the audited
// manual member re-check.  It must never be exposed over HTTP: it returns the
// plaintext number of the current capture only, from process memory, and only in
// the non-production backend.
export function readDevelopmentContactCapture({ tenantId, sessionId } = {}) {
  if (postgresPersistenceEnabled()) return null;
  const entry = memoryEntries.get(memoryKey(String(tenantId || "").trim(), String(sessionId || "").trim()));
  return entry ? { ...entry } : null;
}

export function resetDevelopmentContactVaultForTest() {
  memoryEntries.clear();
  memoryRevealRequests.clear();
}

export const revealContactForClaimedAppointment = (input) => revealContactForClaimedHandover({ ...input, handoverId:undefined });
