import assert from "node:assert/strict";

import {
  assertPrivacyIdentityAttestation,
  issuePrivacyIdentityAttestation,
  verifyPrivacyIdentityAttestation
} from "../server/platform/privacy-identity-attestation.mjs";
import {
  assertPrivacyCompletionAttestation,
  issuePrivacyCompletionAttestation,
  verifyPrivacyCompletionAttestation
} from "../server/platform/privacy-completion-attestation.mjs";
import {
  assertPrivacyCancellationAttestation,
  issuePrivacyCancellationAttestation,
  verifyPrivacyCancellationAttestation
} from "../server/platform/privacy-cancellation-attestation.mjs";

const tenantId = "huamei-attestation-test";
const otherTenantId = "huamei-attestation-other";
const subjectReferenceHmac = "a".repeat(64);
const requestId = "dsr_attestation-unit-001";
const identitySecret = "identity_A7d9K2m4P8q1R6t3V5x0ZcBnHyLuEeW";
const completionSecret = "completion_Q3w7E9r2T6y4U8i1O5p0AsDfGhJkLzX";
const cancellationSecret = "cancellation_R8t4Y0u6I2o9P5a1SdFgHjKlZxCvBnM";
const identityEnv = { HUAMEI_PRIVACY_VERIFICATION_SECRET:identitySecret };
const completionEnv = { HUAMEI_PRIVACY_COMPLETION_SECRET:completionSecret };
const cancellationEnv = { HUAMEI_PRIVACY_CANCELLATION_SECRET:cancellationSecret };

const identityToken = issuePrivacyIdentityAttestation({
  tenantId,
  subjectReferenceHmac,
  requestId,
  verificationId:"piv_unit-001",
  method:"otp",
  env:identityEnv
});
const identityAttestation = verifyPrivacyIdentityAttestation({
  tenantId,
  requestId,
  token:identityToken,
  env:identityEnv
});
assert.equal(identityAttestation?.verification_id, "piv_unit-001");
assert.equal(assertPrivacyIdentityAttestation(identityAttestation, {
  tenantId,
  subjectReferenceHmac,
  requestId
}), identityAttestation);
assert.equal(verifyPrivacyIdentityAttestation({ tenantId:otherTenantId, requestId, token:identityToken, env:identityEnv }), null);
assert.equal(verifyPrivacyIdentityAttestation({ tenantId, requestId:"dsr_attestation-unit-002", token:identityToken, env:identityEnv }), null);
assert.equal(verifyPrivacyIdentityAttestation({ tenantId, requestId, token:`${identityToken.slice(0, -1)}x`, env:identityEnv }), null);

const expiredIdentityToken = issuePrivacyIdentityAttestation({
  tenantId,
  subjectReferenceHmac,
  requestId,
  verificationId:"piv_expired-001",
  method:"verified_channel",
  now:Date.now() - 120_000,
  ttlSeconds:30,
  env:identityEnv
});
assert.equal(verifyPrivacyIdentityAttestation({ tenantId, requestId, token:expiredIdentityToken, env:identityEnv }), null);
assert.throws(
  () => issuePrivacyIdentityAttestation({
    tenantId,
    subjectReferenceHmac,
    requestId,
    method:"processor_checkbox",
    env:identityEnv
  }),
  (error) => error?.code === "PRIVACY_IDENTITY_ATTESTATION_CLAIMS_INVALID"
);

const completionToken = issuePrivacyCompletionAttestation({
  tenantId,
  subjectReferenceHmac,
  requestId,
  requestType:"access",
  targetStatus:"fulfilled",
  evidenceId:"pce_unit-001",
  actionReference:"delivery_unit-001",
  method:"secure_delivery",
  env:completionEnv
});
const completionAttestation = verifyPrivacyCompletionAttestation({
  tenantId,
  requestId,
  token:completionToken,
  env:completionEnv
});
assert.equal(completionAttestation?.action_reference, "delivery_unit-001");
assert.equal(assertPrivacyCompletionAttestation(completionAttestation, {
  tenantId,
  subjectReferenceHmac,
  requestId,
  requestType:"access",
  targetStatus:"fulfilled"
}), completionAttestation);
assert.equal(verifyPrivacyCompletionAttestation({ tenantId:otherTenantId, requestId, token:completionToken, env:completionEnv }), null);
assert.equal(verifyPrivacyCompletionAttestation({ tenantId, requestId, token:`${completionToken.slice(0, -1)}x`, env:completionEnv }), null);
assert.throws(
  () => issuePrivacyCompletionAttestation({
    tenantId,
    subjectReferenceHmac,
    requestId,
    requestType:"correct",
    actionReference:"correction_unit-001",
    method:"secure_delivery",
    env:completionEnv
  }),
  (error) => error?.code === "PRIVACY_COMPLETION_ATTESTATION_CLAIMS_INVALID"
);

const cancellationToken = issuePrivacyCancellationAttestation({
  tenantId,
  subjectReferenceHmac,
  requestId,
  identityVerificationId:"piv_unit-001",
  cancellationId:"pca_unit-001",
  referenceId:"withdrawal_unit-001",
  env:cancellationEnv
});
const cancellationAttestation = verifyPrivacyCancellationAttestation({
  tenantId,
  requestId,
  token:cancellationToken,
  env:cancellationEnv
});
assert.equal(cancellationAttestation?.cancellation_id, "pca_unit-001");
assert.equal(assertPrivacyCancellationAttestation(cancellationAttestation, {
  tenantId,
  subjectReferenceHmac,
  requestId,
  identityVerificationId:"piv_unit-001"
}), cancellationAttestation);
assert.equal(verifyPrivacyCancellationAttestation({
  tenantId:otherTenantId,
  requestId,
  token:cancellationToken,
  env:cancellationEnv
}), null);
assert.equal(verifyPrivacyCancellationAttestation({
  tenantId,
  requestId:"dsr_attestation-unit-002",
  token:cancellationToken,
  env:cancellationEnv
}), null);
assert.equal(verifyPrivacyCancellationAttestation({
  tenantId,
  requestId,
  token:`${cancellationToken.slice(0, -1)}x`,
  env:cancellationEnv
}), null);
assert.equal(verifyPrivacyIdentityAttestation({
  tenantId,
  requestId,
  token:cancellationToken,
  env:identityEnv
}), null, "取消与身份attestation必须做签名域隔离");
assert.throws(
  () => assertPrivacyCancellationAttestation(cancellationAttestation, {
    tenantId,
    subjectReferenceHmac:"b".repeat(64),
    requestId,
    identityVerificationId:"piv_unit-001"
  }),
  (error) => error?.code === "PRIVACY_CANCELLATION_ATTESTATION_MISMATCH"
);
assert.throws(
  () => assertPrivacyCancellationAttestation(cancellationAttestation, {
    tenantId,
    subjectReferenceHmac,
    requestId,
    identityVerificationId:"piv_unit-other"
  }),
  (error) => error?.code === "PRIVACY_CANCELLATION_ATTESTATION_MISMATCH"
);
const expiredCancellationToken = issuePrivacyCancellationAttestation({
  tenantId,
  subjectReferenceHmac,
  requestId,
  identityVerificationId:"piv_unit-001",
  cancellationId:"pca_expired-001",
  referenceId:"withdrawal_expired-001",
  now:Date.now() - 120_000,
  recordedAt:Date.now() - 120_000,
  ttlSeconds:30,
  env:cancellationEnv
});
assert.equal(verifyPrivacyCancellationAttestation({
  tenantId,
  requestId,
  token:expiredCancellationToken,
  env:cancellationEnv
}), null);

console.log("✓ 隐私身份、主体撤回与执行/交付attestation发行、绑定、过期、篡改和签名域隔离通过");
