BEGIN;

CREATE TABLE IF NOT EXISTS privacy_identity_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  verification_id varchar(160) NOT NULL,
  request_id varchar(128) NOT NULL,
  subject_reference_hmac char(64) NOT NULL
    CHECK (subject_reference_hmac ~ '^[0-9a-f]{64}$'),
  method varchar(32) NOT NULL
    CHECK (method IN ('otp','verified_callback','verified_channel','in_person_document')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT privacy_identity_verifications_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT privacy_identity_verifications_business_key UNIQUE (tenant_id, verification_id),
  CONSTRAINT privacy_identity_verifications_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES data_subject_requests(tenant_id, request_id) ON DELETE RESTRICT,
  CONSTRAINT privacy_identity_verifications_time_order
    CHECK (
      expires_at > issued_at
      AND consumed_at >= issued_at - interval '1 minute'
      AND consumed_at <= expires_at
    )
);

CREATE INDEX IF NOT EXISTS privacy_identity_verifications_request_idx
  ON privacy_identity_verifications (tenant_id, request_id, consumed_at, id);
CREATE INDEX IF NOT EXISTS privacy_identity_verifications_subject_idx
  ON privacy_identity_verifications (tenant_id, subject_reference_hmac, consumed_at, id);

ALTER TABLE privacy_identity_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON privacy_identity_verifications;
CREATE POLICY tenant_isolation ON privacy_identity_verifications
  USING (tenant_id = huamei_current_tenant())
  WITH CHECK (tenant_id = huamei_current_tenant());
ALTER TABLE privacy_identity_verifications FORCE ROW LEVEL SECURITY;

REVOKE ALL ON privacy_identity_verifications FROM PUBLIC, huamei_runtime;
GRANT SELECT, INSERT ON privacy_identity_verifications TO huamei_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO huamei_runtime;

COMMENT ON TABLE privacy_identity_verifications IS
  'Append-only replay ledger for trusted DSR identity attestations. Stores no raw identity evidence or mobile number.';

CREATE TABLE IF NOT EXISTS privacy_completion_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  evidence_id varchar(160) NOT NULL,
  request_id varchar(128) NOT NULL,
  subject_reference_hmac char(64) NOT NULL
    CHECK (subject_reference_hmac ~ '^[0-9a-f]{64}$'),
  request_type varchar(32) NOT NULL CHECK (request_type IN ('access','correct')),
  target_status varchar(24) NOT NULL CHECK (target_status IN ('fulfilled','partially_fulfilled')),
  method varchar(40) NOT NULL CHECK (method IN ('secure_delivery','authoritative_correction')),
  action_reference varchar(160) NOT NULL,
  completed_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT privacy_completion_verifications_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT privacy_completion_verifications_business_key UNIQUE (tenant_id, evidence_id),
  CONSTRAINT privacy_completion_verifications_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES data_subject_requests(tenant_id, request_id) ON DELETE RESTRICT,
  CONSTRAINT privacy_completion_verifications_method_type CHECK (
    (request_type = 'access' AND method = 'secure_delivery')
    OR (request_type = 'correct' AND method = 'authoritative_correction')
  ),
  CONSTRAINT privacy_completion_verifications_time_order CHECK (
    completed_at <= issued_at + interval '30 seconds'
    AND completed_at >= issued_at - interval '30 days'
    AND expires_at > issued_at
    AND consumed_at >= issued_at - interval '1 minute'
    AND consumed_at <= expires_at
  )
);

CREATE INDEX IF NOT EXISTS privacy_completion_verifications_request_idx
  ON privacy_completion_verifications (tenant_id, request_id, consumed_at, id);
CREATE INDEX IF NOT EXISTS privacy_completion_verifications_subject_idx
  ON privacy_completion_verifications (tenant_id, subject_reference_hmac, consumed_at, id);

ALTER TABLE privacy_completion_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON privacy_completion_verifications;
CREATE POLICY tenant_isolation ON privacy_completion_verifications
  USING (tenant_id = huamei_current_tenant())
  WITH CHECK (tenant_id = huamei_current_tenant());
ALTER TABLE privacy_completion_verifications FORCE ROW LEVEL SECURITY;

REVOKE ALL ON privacy_completion_verifications FROM PUBLIC, huamei_runtime;
GRANT SELECT, INSERT ON privacy_completion_verifications TO huamei_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO huamei_runtime;

COMMENT ON TABLE privacy_completion_verifications IS
  'Append-only replay ledger for independently attested access delivery or correction completion; contains no payload or direct identifier.';

COMMIT;
