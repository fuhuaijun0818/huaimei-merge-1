import { createHash, createHmac, randomUUID } from "node:crypto";
import { createFieldEncryption, createFieldRecordId } from "../platform/field-encryption.mjs";
import {
  appendAuditEvent, appendOutboxEvent, ensureTenant, jsonValue, postgres
} from "./postgres-helpers.mjs";
import { assertPrivacyContactPurposeAllowed } from "./postgres-contact-suppression-guard.mjs";
import { createPostgresContactVaultStore } from "./postgres-contact-vault-store.mjs";
import { redactContactPii } from "../platform/contact-pii-redaction.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const normalizeMobile = (value) => {
  const digits = String(value ?? "").normalize("NFKC").replace(/\D/g, "");
  if (/^1[3-9]\d{9}$/.test(digits)) return digits;
  return digits.replace(/^(?:00)?86/, "");
};
const mobileIdentityHmac = (mobile, tenantId, env) => createHmac("sha256", String(env.HUAMEI_IDENTITY_PEPPER || "times-beauty-local-mvp-v1"))
  .update(`${tenantId}:${normalizeMobile(mobile)}`).digest("hex");
const maskMobile = (mobile) => `${mobile.slice(0, 3)}****${mobile.slice(-4)}`;
const policyVersion = () => String(process.env.HUAMEI_PRIVACY_POLICY_VERSION || "phase1-consultation-v1").slice(0, 64);

const leadProfileContext = (tenantId, identity) => ({
  tenantId, scope:"lead.profile", recordId:identity
});
const consentEvidenceContext = (tenantId, identity, consentType, evidenceHash) => ({
  tenantId,
  scope:"lead.consent.evidence",
  recordId:createFieldRecordId("lead.consent", {
    consent_type:consentType,
    evidence_hash:evidenceHash,
    subject_reference_hmac:identity
  }),
  legacyRecordId:`${identity}:${consentType}:${evidenceHash}`
});
const leadCandidateProfileContext = (tenantId, candidateId) => ({
  tenantId, scope:"lead.candidate.profile", recordId:candidateId
});

const assertFormatValidatedCapture = (capture, { tenantId, identity, sessionId }) => {
  if (capture?.method !== "format_validation"
      || capture?.status !== "pending_manual"
      || capture?.tenant_id !== tenantId
      || capture?.subject_reference_hmac !== identity
      || capture?.session_id !== sessionId
      || !String(capture?.verification_id || "").trim()) {
    const error = new Error("Customer 360 writes require a format-validated contact capture");
    error.code = "CONTACT_CAPTURE_REQUIRED";
    error.status = 409;
    throw error;
  }
};

const leadFromRow = (row, fieldEncryption) => {
  if (!row) return null;
  const profile = fieldEncryption.decryptJson(
    jsonValue(row.profile, {}),
    leadProfileContext(row.tenant_id, row.normalized_mobile_hmac || row.lead_id)
  );
  const document = profile?._document;
  if (document) return { ...clone(document), phone_hash:row.normalized_mobile_hmac };
  return {
    tenant_id:row.tenant_id,
    phone_hash:row.normalized_mobile_hmac,
    created_at:new Date(row.created_at).toISOString(),
    updated_at:new Date(row.updated_at).toISOString(),
    interactions:1,
    customer:{
      id:row.customer_id || row.lead_id,
      name:row.display_name,
      mobile:row.masked_mobile,
      macroStage:row.macro_stage,
      microStage:row.micro_stage,
      interests:jsonValue(row.interests, [])
    },
    conversations:[],
    task:null
  };
};

export function createPostgresLeadStore(options = {}) {
  const env = options.env || process.env;
  const database = options.postgres || postgres();
  const fieldEncryption = options.fieldEncryption || createFieldEncryption({ env });
  const contactVault = options.contactVault || createPostgresContactVaultStore({ postgres:database, env });

  const updateMemberCheck = ({tenantId,identity,captureId,memberCheck,timelineEvent=null}) => database.tenantTransaction(tenantId,async client=>{
    await assertPrivacyContactPurposeAllowed(client,{tenantId,subjectReferenceHmac:identity,purpose:"service",operation:"member_check_result"});
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`lead:${tenantId}:${identity}`]);
    const r=await client.query("SELECT * FROM leads WHERE tenant_id=$1 AND normalized_mobile_hmac=$2 FOR UPDATE",[tenantId,identity]);
    const lead=leadFromRow(r.rows[0],fieldEncryption);
    if(!lead || lead.customer?.memberCheck?.capture_id!==captureId) return null;
    // Keep the capture bound to the number that was actually queried: the manual
    // re-check and the "an old number's result must not overwrite a new number"
    // guard both compare this id, and the provider record itself has no capture.
    lead.customer.memberCheck={ ...memberCheck, capture_id:captureId };
    // 人工重查要在客户时间线留痕，管理端才能看到“谁在什么时候重查过”。
    if (timelineEvent) lead.customer.timeline=[timelineEvent, ...(lead.customer.timeline || [])].slice(0, 80);
    const {phone_hash:ignored,...document}=lead;
    await client.query("UPDATE leads SET profile=$3::jsonb WHERE tenant_id=$1 AND normalized_mobile_hmac=$2",[tenantId,identity,JSON.stringify(fieldEncryption.encryptJson({_document:document},leadProfileContext(tenantId,identity)))]);
    await appendAuditEvent(client,{tenantId,actorId:"member-check-service",action:"lead.member_check_completed",resourceType:"lead",resourceId:lead.customer.id,details:{status:memberCheck.status,reason_code:memberCheck.reason_code||null}});
    return lead;
  });

  const upsertCandidate = async ({
    tenantId,
    identity,
    candidateId,
    sessionReferenceHash,
    maskedMobile,
    payload:submittedPayload
  }) => database.tenantTransaction(tenantId, async (client) => {
    await ensureTenant(client, tenantId);
    const candidateProfile = {
      submitted_name:redactContactPii(String(submittedPayload.name || "")).trim().slice(0, 40) || null,
      submitted_interests:Array.isArray(submittedPayload.interests)
        ? submittedPayload.interests.map((item) => redactContactPii(String(item || "")).trim().slice(0, 40)).filter(Boolean).slice(0, 10)
        : [],
      source_channel:String(submittedPayload.channel || "web").trim().toLowerCase().slice(0, 32) || "web",
      captured_at:new Date().toISOString()
    };
    const inserted = await client.query(
      `INSERT INTO lead_candidates
        (tenant_id,candidate_id,session_reference_hash,submitted_mobile_hmac,
         masked_mobile,source_channel,verification_status,verification_method,profile)
       VALUES ($1,$2,$3,$4,$5,$6,'unverified',NULL,$7::jsonb)
       ON CONFLICT (tenant_id,session_reference_hash)
       DO UPDATE SET
         candidate_id=EXCLUDED.candidate_id,
         submitted_mobile_hmac=EXCLUDED.submitted_mobile_hmac,
         masked_mobile=EXCLUDED.masked_mobile,
         source_channel=EXCLUDED.source_channel,
         verification_status='unverified',
         verification_method=NULL,
         profile=EXCLUDED.profile,
         last_seen_at=clock_timestamp()
       RETURNING candidate_id,masked_mobile,verification_status,created_at,updated_at`,
      [tenantId, candidateId, sessionReferenceHash, identity, maskedMobile,
        candidateProfile.source_channel,
        JSON.stringify(fieldEncryption.encryptJson(
          candidateProfile,
          leadCandidateProfileContext(tenantId, candidateId)
        ))]
    );
    await appendAuditEvent(client, {
      tenantId,
      action:"lead.candidate_staged",
      resourceType:"lead_candidate",
      resourceId:candidateId,
      actorId:"huamei-acquisition-agent",
      details:{ verification_status:"unverified", profile_fields_stored:2 }
    });
    await appendOutboxEvent(client, {
      tenantId,
      aggregateType:"lead_candidate",
      aggregateId:candidateId,
      eventType:"lead.candidate_staged",
      payload:{ candidate_id:candidateId, verification_status:"unverified" }
    });
    const row = inserted.rows[0];
    return {
      candidate_id:row.candidate_id,
      masked_mobile:row.masked_mobile,
      verification_status:row.verification_status,
      created_at:new Date(row.created_at).toISOString(),
      updated_at:new Date(row.updated_at).toISOString()
    };
  });

  const upsert = async ({
    tenantId,
    identity,
    payload,
    buildLead,
    verification,
    candidateSessionReferenceHash = null
  }) => {
    // The public route creates this server-side capture record only after the
    // mobile format and service-contact consent have passed validation.
    assertFormatValidatedCapture(verification, { tenantId, identity, sessionId:payload.session_id });
    return database.tenantTransaction(tenantId, async (client) => {
      await ensureTenant(client, tenantId);
    // Acquisition lead capture always rebuilds the current service consent and
    // a service follow-up projection. Gate it before any profile or consent
    // mutation, and share the subject lock with privacy execution.
    await assertPrivacyContactPurposeAllowed(client, {
      tenantId,
      subjectReferenceHmac:identity,
      purpose:"service",
      operation:"lead_service_consent_grant"
    });
    if (payload.marketing_consent === true) {
      await assertPrivacyContactPurposeAllowed(client, {
        tenantId,
        subjectReferenceHmac:identity,
        purpose:"marketing",
        operation:"lead_marketing_consent_grant",
        lock:false
      });
    }
    // A row lock cannot protect the first concurrent insert because the row does
    // not exist yet. Serialize all writes for one tenant-scoped mobile HMAC for
    // the lifetime of this transaction, then load and merge the latest document.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`lead:${tenantId}:${identity}`]
    );
    const existingResult = await client.query(
      `SELECT * FROM leads
       WHERE tenant_id=$1 AND normalized_mobile_hmac=$2
       FOR UPDATE`,
      [tenantId, identity]
    );
    const existing = leadFromRow(existingResult.rows[0], fieldEncryption);
    const lead = await buildLead(existing);
    const customer = lead.customer || {};
    const primaryInterest = customer.interests?.[0]?.name || null;
    const document = {
      ...lead,
      phone_hash:undefined
    };
    const values = [
      tenantId,
      customer.id,
      customer.id,
      identity,
      customer.mobile,
      fieldEncryption.enabled ? null : customer.name,
      customer.firstChannel || customer.latestChannel || "web",
      customer.macroStage || "售前",
      customer.microStage || "新咨询",
      fieldEncryption.enabled ? null : primaryInterest,
      JSON.stringify(fieldEncryption.enabled ? [] : customer.interests || []),
      JSON.stringify(fieldEncryption.encryptJson(
        { _document:document },
        leadProfileContext(tenantId, identity)
      )),
      lead.created_at,
      lead.updated_at
    ];
    const saved = await client.query(
      `INSERT INTO leads
        (tenant_id, lead_id, customer_id, normalized_mobile_hmac, masked_mobile,
         display_name, source_channel, macro_stage, micro_stage, primary_interest,
         interests, profile, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)
       ON CONFLICT (tenant_id, normalized_mobile_hmac) WHERE normalized_mobile_hmac IS NOT NULL
       DO UPDATE SET
         customer_id=EXCLUDED.customer_id,
         masked_mobile=EXCLUDED.masked_mobile,
         display_name=EXCLUDED.display_name,
         source_channel=EXCLUDED.source_channel,
         macro_stage=EXCLUDED.macro_stage,
         micro_stage=EXCLUDED.micro_stage,
         primary_interest=EXCLUDED.primary_interest,
         interests=EXCLUDED.interests,
         profile=EXCLUDED.profile,
         last_seen_at=EXCLUDED.last_seen_at
       RETURNING id, lead_id`,
      values
    );
    const leadRecordId = saved.rows[0].id;
    const externalSessionId = String(payload.session_id || "").trim();
    if (externalSessionId) {
      const channel = String(payload.channel || "web").trim().toLowerCase() || "web";
      const sessionMatches = await client.query(
        `SELECT id, lead_id, customer_id
         FROM conversation_sessions
         WHERE tenant_id=$1 AND channel=$2
           AND (external_conversation_id=$3 OR session_id=$3)
         FOR UPDATE`,
        [tenantId, channel, externalSessionId]
      );
      if (sessionMatches.rowCount > 1) {
        const error = new Error("Lead session binding is ambiguous for this tenant and channel");
        error.code = "LEAD_SESSION_BINDING_AMBIGUOUS";
        throw error;
      }
      const matchedSession = sessionMatches.rows[0];
      if (matchedSession) {
        if (matchedSession.lead_id && matchedSession.lead_id !== leadRecordId) {
          const error = new Error("Conversation session is already bound to another lead");
          error.code = "LEAD_SESSION_BINDING_CONFLICT";
          throw error;
        }
        if (matchedSession.customer_id && customer.id && matchedSession.customer_id !== customer.id) {
          const error = new Error("Conversation session is already bound to another customer");
          error.code = "LEAD_SESSION_CUSTOMER_CONFLICT";
          throw error;
        }
        await client.query(
          `UPDATE leads
           SET source_session_id=COALESCE(source_session_id,$3)
           WHERE tenant_id=$1 AND id=$2`,
          [tenantId, leadRecordId, matchedSession.id]
        );
        await client.query(
          `UPDATE conversation_sessions
           SET lead_id=$3, customer_id=COALESCE(customer_id,$4)
           WHERE tenant_id=$1 AND id=$2`,
          [tenantId, matchedSession.id, leadRecordId, customer.id || null]
        );
      }
    }
    const now = new Date().toISOString();
    await client.query(
      `UPDATE consents SET is_current=false
       WHERE tenant_id=$1 AND lead_record_id=$2 AND consent_type IN ('service','marketing') AND is_current`,
      [tenantId, leadRecordId]
    );
    for (const consent of [
      { type:"service", granted:true },
      { type:"marketing", granted:payload.marketing_consent === true }
    ]) {
      const evidence = {
        source:payload.channel || "web",
        session_id:payload.session_id || null,
        text_version:policyVersion(),
        captured_at:now
      };
      const evidenceHash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
      const encryptedEvidence = fieldEncryption.encryptJson(
        evidence,
        consentEvidenceContext(tenantId, identity, consent.type, evidenceHash)
      );
      await client.query(
        `INSERT INTO consents
          (tenant_id, lead_record_id, consent_type, granted, policy_version,
           source, evidence_hash, evidence, is_current, effective_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true,$9)`,
        [tenantId, leadRecordId, consent.type, consent.granted, policyVersion(),
          payload.channel || "web", evidenceHash, JSON.stringify(encryptedEvidence), now]
      );
    }
    // The lead, current service consent and reversible contact are committed by
    // this single tenant transaction.  A public accepted receipt is therefore
    // impossible unless the encrypted contact is already durable.
    const contact = await contactVault.persistInTransaction(client, {
      tenantId,
      leadRecordId,
      subjectReferenceHmac:identity,
      mobile:payload.mobile,
      verification
    });
    await appendAuditEvent(client, {
      tenantId,
      action:existing ? "lead.updated" : "lead.created",
      resourceType:"lead",
      resourceId:saved.rows[0].lead_id,
      actorId:"huamei-acquisition-agent",
      details:{
        matched_by:"normalized_mobile_hmac",
        session_reference_hash:payload.session_id
          ? createHash("sha256").update(`${tenantId}:${payload.channel || "web"}:${payload.session_id}`).digest("hex")
          : null
      }
    });
    await appendOutboxEvent(client, {
      tenantId,
      aggregateType:"lead",
      aggregateId:saved.rows[0].lead_id,
      eventType:existing ? "lead.updated" : "lead.created",
      payload:{ lead_id:saved.rows[0].lead_id, customer_id:customer.id, source:"acquisition_advisor" }
    });
      return {
        is_existing:Boolean(existing),
        matched_by:"mobile_hash",
        lead:clone(lead),
        contact:{
          contact_reference:contact.contact_reference,
          contact_type:contact.contact_type,
          masked_value:contact.masked_value,
          purpose:contact.purpose,
          phone_verification_status:contact.phone_verification_status,
          durable:contact.durable,
          encrypted:contact.encrypted
        }
      };
    });
  };

  // Reads the server-side plaintext of the capture currently bound to the stored
  // number so an operator-triggered member re-check can never query a different
  // number.  The read itself is audited by the contact vault store.
  const readCustomerContactForMemberCheck = ({ tenantId, customerId, actor, requestId = null }) =>
    database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        "SELECT * FROM leads WHERE tenant_id=$1 AND customer_id=$2 FOR UPDATE",
        [tenantId, customerId]
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      const lead = leadFromRow(row, fieldEncryption);
      const stored = lead?.customer?.memberCheck;
      const captureId = stored?.capture_id || randomUUID();
      if (!stored?.capture_id) {
        // 历史档案（早期写回丢过 capture）在首次重查时补一个绑定，之后保持稳定，
        // 这样“旧号码结果不能覆盖新号码状态”的守卫对老数据同样生效。
        lead.customer.memberCheck = {
          schema:"huamei.member-repeatcheck.v1", provider:"huamei_repeatcheck", status:"pending",
          is_repeat:null, member_status:"unknown", reason_code:null,
          attempted_at:new Date().toISOString(), checked_at:null,
          ...(stored || {}), capture_id:captureId
        };
        const { phone_hash:ignored, ...document } = lead;
        await client.query(
          "UPDATE leads SET profile=$3::jsonb WHERE tenant_id=$1 AND normalized_mobile_hmac=$2",
          [tenantId, row.normalized_mobile_hmac,
            JSON.stringify(fieldEncryption.encryptJson({ _document:document }, leadProfileContext(tenantId, row.normalized_mobile_hmac)))]
        );
      }
      const mobile = await contactVault.readMobileForMemberCheck({
        client, tenantId, leadRecordId:row.id, subjectReferenceHmac:row.normalized_mobile_hmac, actor, requestId
      });
      const conversations = lead.conversations || [];
      const sessionId = String(conversations[0]?.externalConversationId || conversations[0]?.id
        || `member-check-${row.id}`).slice(0, 128);
      return {
        mobile, identity:row.normalized_mobile_hmac, captureId, sessionId,
        name:lead.customer?.name || "", previous:stored
      };
    });

  const snapshot = async (tenantId) => {
    const result = await database.tenantQuery(tenantId,
      `SELECT * FROM leads WHERE tenant_id=$1 ORDER BY last_seen_at DESC`,
      [tenantId]
    );
    return result.rows.map((row) => leadFromRow(row, fieldEncryption));
  };

  const updateCustomer = async ({ tenantId, customerId, patch = {}, expectedVersion = null, actor = "当前用户", source = "management" } = {}) => database.tenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM leads WHERE tenant_id=$1 AND customer_id=$2 FOR UPDATE", [tenantId, customerId]);
    if (!result.rowCount) {
      const error = new Error("未找到客户档案"); error.code = "CUSTOMER_NOT_FOUND"; error.status = 404; throw error;
    }
    const row = result.rows[0];
    const current = leadFromRow(row, fieldEncryption);
    const currentVersion = Math.max(1, Number(current.profile_version || current.customer?.profileVersion || 1));
    if (expectedVersion !== null && expectedVersion !== currentVersion) {
      const error = new Error("客户资料已被其他人员更新，请刷新后重试");
      error.code = "PROFILE_VERSION_CONFLICT"; error.status = 409;
      error.details = [{ expected_version:expectedVersion, current_version:currentVersion }]; throw error;
    }
    const phoneChanged = Boolean(patch.mobile);
    const mobile = phoneChanged ? normalizeMobile(patch.mobile) : "";
    const identity = phoneChanged ? mobileIdentityHmac(mobile, tenantId, env) : row.normalized_mobile_hmac;
    if (phoneChanged) {
      const duplicate = await client.query(
        "SELECT 1 FROM leads WHERE tenant_id=$1 AND normalized_mobile_hmac=$2 AND id<>$3 LIMIT 1",
        [tenantId, identity, row.id]
      );
      if (duplicate.rowCount) {
        const error = new Error("该手机号已关联其他客户，请先核对客户档案");
        error.code = "MOBILE_ALREADY_LINKED"; error.status = 409; throw error;
      }
    }
    const now = new Date().toISOString();
    const nextVersion = currentVersion + 1;
    const changed = [
      ...(Object.hasOwn(patch, "name") ? ["name"] : []),
      ...(phoneChanged ? ["mobile"] : []),
      ...(patch.profile ? Object.keys(patch.profile).map((key) => `profile.${key}`) : []),
      ...(patch.contactPreferences ? ["contact_preferences"] : []),
      ...(Object.hasOwn(patch, "tags") ? ["tags"] : [])
    ];
    const profileUpdate = { version:nextVersion, fields:changed, source:source || "management", actor:actor || "当前用户", at:now };
    const customer = {
      ...current.customer,
      ...(Object.hasOwn(patch, "name") ? { name:patch.name } : {}),
      ...(phoneChanged ? { mobile:maskMobile(mobile), phoneVerificationStatus:"pending_manual" } : {}),
      ...(patch.profile ? { profile:{ ...(current.customer?.profile || {}), ...patch.profile } } : {}),
      ...(patch.contactPreferences ? { contactPreferences:{ ...(current.customer?.contactPreferences || {}), ...patch.contactPreferences,
        updated_at:now, updated_by:actor, source } } : {}),
      ...(patch.tags ? { tags:patch.tags } : {}),
      profileVersion:nextVersion, profileUpdatedAt:now, profileUpdatedBy:actor, profileUpdateSource:source,
      profileUpdateHistory:[profileUpdate, ...(current.customer?.profileUpdateHistory || [])].slice(0, 50)
    };
    const captureId = phoneChanged ? randomUUID() : null;
    const sessionId = String(current.conversations?.[0]?.externalConversationId || `profile-${randomUUID()}`).slice(0, 128);
    const verification = phoneChanged ? {
      schema:"huamei.contact-capture.v1", verified:false, status:"pending_manual", method:"format_validation",
      tenant_id:tenantId, subject_reference_hmac:identity, session_id:sessionId,
      verification_id:captureId, captured_at:now
    } : null;
    if (phoneChanged) {
      customer.memberCheck = { schema:"huamei.member-repeatcheck.v1", provider:"huamei_repeatcheck", status:"pending",
        is_repeat:null, member_status:"unknown", reason_code:null, attempted_at:now, checked_at:null, capture_id:captureId };
    }
    const event = {
      id:`E-${createHash("sha256").update(`${customerId}:profile:${now}`).digest("hex").slice(0, 14).toUpperCase()}`,
      type:"profile", title:"客户资料由人工更正", detail:`已更新${changed.join("、")}。${phoneChanged ? "手机号变更后将重新查询会员状态。" : ""}`,
      occurredAt:now, actor:actor || "当前用户", channel:source || "管理后台", tone:"neutral", source, fields:changed
    };
    const document = { ...current, phone_hash:undefined, updated_at:now, profile_version:nextVersion,
      customer:{ ...customer, timeline:[event, ...(current.customer?.timeline || [])].slice(0, 80) } };
    if (phoneChanged) {
      await contactVault.persistInTransaction(client, { tenantId, leadRecordId:row.id, subjectReferenceHmac:identity, mobile, verification, allowSubjectRotation:true });
    }
    await client.query(
      `UPDATE leads SET normalized_mobile_hmac=$3, masked_mobile=$4, display_name=$5,
         profile=$6::jsonb, last_seen_at=$7 WHERE tenant_id=$1 AND id=$2`,
      [tenantId, row.id, identity, phoneChanged ? maskMobile(mobile) : row.masked_mobile,
        customer.name || null, JSON.stringify(fieldEncryption.encryptJson({ _document:document }, leadProfileContext(tenantId, identity))), now]
    );
    await appendAuditEvent(client, { tenantId, action:"lead.profile_updated", resourceType:"lead", resourceId:row.lead_id,
      actorType:"human", actorId:actor || "current-user", details:{ fields:changed, source, profile_version:nextVersion, phone_changed:phoneChanged } });
    return { lead:{ ...document, phone_hash:identity }, phoneChanged, mobile, identity, sessionId, verification };
  });

  const appendConversationReply = ({ tenantId, conversationId, message, updateLead }) => database.tenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM leads WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
    for (const row of result.rows) {
      const lead = leadFromRow(row, fieldEncryption);
      const mutation = updateLead(lead);
      if (!mutation) continue;
      const updated = mutation.lead;
      if (!mutation.replayed) {
        const { phone_hash:ignored, ...document } = updated;
        await client.query(
          "UPDATE leads SET profile=$3::jsonb,last_seen_at=$4 WHERE tenant_id=$1 AND normalized_mobile_hmac=$2",
          [tenantId, row.normalized_mobile_hmac, JSON.stringify(fieldEncryption.encryptJson({ _document:document }, leadProfileContext(tenantId, row.normalized_mobile_hmac))), updated.updated_at]
        );
        await appendAuditEvent(client, { tenantId, action:"conversation.reply_sent", resourceType:"conversation", resourceId:conversationId, actorId:message.actor, details:{ channel:"获客顾问 Web", message_id:message.id } });
      }
      return { conversation:clone(mutation.conversation), customer:clone(updated.customer), message:clone(mutation.message), replayed:Boolean(mutation.replayed) };
    }
    return null;
  });

  const recordConversationDelivery = ({ tenantId, conversationId, messageId, updateLead }) => database.tenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM leads WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
    for (const row of result.rows) {
      const lead = leadFromRow(row, fieldEncryption);
      const updated = updateLead(lead);
      if (!updated) continue;
      const { phone_hash:ignored, ...document } = updated.lead;
      await client.query(
        "UPDATE leads SET profile=$3::jsonb,last_seen_at=$4 WHERE tenant_id=$1 AND normalized_mobile_hmac=$2",
        [tenantId, row.normalized_mobile_hmac, JSON.stringify(fieldEncryption.encryptJson({ _document:document }, leadProfileContext(tenantId, row.normalized_mobile_hmac))), document.updated_at]
      );
      await appendAuditEvent(client, {
        tenantId,
        action:"conversation.staff_message_delivered",
        resourceType:"conversation_message",
        resourceId:messageId,
        details:{ conversation_id:conversationId, channel:"web", delivery_status:"delivered", read_status:"not_reported" }
      });
      return { message:clone(updated.message), replayed:Boolean(updated.replayed) };
    }
    return null;
  });

  return {
    upsert,
    updateMemberCheck,
    readCustomerContactForMemberCheck,
    upsertCandidate,
    snapshot,
    updateCustomer,
    appendConversationReply,
    recordConversationDelivery,
    status:() => ({
      driver:"postgres", durable:true, shared:true, configured:database.configured,
      field_encryption:fieldEncryption.enabled ? "aes-256-gcm" : "development-plaintext",
      contact_vault:contactVault.status()
    })
  };
}

let defaultStore;
export const getPostgresLeadStore = () => {
  if (!defaultStore) defaultStore = createPostgresLeadStore();
  return defaultStore;
};
