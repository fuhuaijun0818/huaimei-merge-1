BEGIN;

CREATE TABLE IF NOT EXISTS lead_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  candidate_id varchar(128) NOT NULL,
  session_reference_hash char(64) NOT NULL
    CHECK (session_reference_hash ~ '^[0-9a-f]{64}$'),
  submitted_mobile_hmac char(64) NOT NULL
    CHECK (submitted_mobile_hmac ~ '^[0-9a-f]{64}$'),
  masked_mobile varchar(32) NOT NULL,
  source_channel varchar(32) NOT NULL DEFAULT 'web',
  verification_status varchar(24) NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','promoted','expired','rejected')),
  verification_method varchar(32),
  profile jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(profile) = 'object'),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lead_candidates_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT lead_candidates_business_key UNIQUE (tenant_id, candidate_id),
  CONSTRAINT lead_candidates_session_unique UNIQUE (tenant_id, session_reference_hash),
  CONSTRAINT lead_candidates_seen_order CHECK (last_seen_at >= first_seen_at),
  CONSTRAINT lead_candidates_verification_state CHECK (
    (verification_status = 'unverified' AND verification_method IS NULL)
    OR
    (verification_status = 'promoted' AND verification_method IN ('otp','verified_channel','development_bypass'))
    OR
    (verification_status IN ('expired','rejected'))
  )
);

CREATE INDEX IF NOT EXISTS lead_candidates_mobile_idx
  ON lead_candidates (tenant_id, submitted_mobile_hmac, verification_status, created_at);
CREATE INDEX IF NOT EXISTS lead_candidates_status_idx
  ON lead_candidates (tenant_id, verification_status, created_at, id);

DROP TRIGGER IF EXISTS lead_candidates_set_updated_at ON lead_candidates;
CREATE TRIGGER lead_candidates_set_updated_at BEFORE UPDATE ON lead_candidates
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();

ALTER TABLE lead_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_candidates;
CREATE POLICY tenant_isolation ON lead_candidates
  USING (tenant_id = huamei_current_tenant())
  WITH CHECK (tenant_id = huamei_current_tenant());
ALTER TABLE lead_candidates FORCE ROW LEVEL SECURITY;

REVOKE ALL ON lead_candidates FROM PUBLIC, huamei_runtime;
GRANT SELECT, INSERT, UPDATE ON lead_candidates TO huamei_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO huamei_runtime;

COMMENT ON TABLE lead_candidates IS
  'Unverified public lead submissions isolated from customer 360 until independent OTP or trusted-channel ownership proof succeeds.';
COMMENT ON COLUMN lead_candidates.profile IS
  'Application-encrypted candidate-only payload; it must never be merged into an existing customer profile without verified ownership.';

COMMIT;
