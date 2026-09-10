BEGIN;

CREATE TABLE IF NOT EXISTS privacy_execution_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  action_id varchar(160) NOT NULL,
  request_id varchar(128) NOT NULL,
  action_type varchar(32) NOT NULL
    CHECK (action_type IN ('withdraw_consent','restrict_contact','export_plan','delete_plan')),
  execution_mode varchar(16) NOT NULL
    CHECK (execution_mode IN ('automatic','manual')),
  status varchar(24) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','executed','manual_pending','failed')),
  purposes text[] NOT NULL DEFAULT ARRAY[]::text[],
  input_checksum char(64) NOT NULL CHECK (input_checksum ~ '^[0-9a-f]{64}$'),
  processor_id varchar(160) NOT NULL,
  approver_id varchar(160),
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(requirements) = 'object'),
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(outcome) = 'object'),
  approved_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT privacy_execution_actions_business_key UNIQUE (tenant_id, action_id),
  CONSTRAINT privacy_execution_actions_request_action_unique UNIQUE (tenant_id, request_id, action_type),
  CONSTRAINT privacy_execution_actions_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES data_subject_requests(tenant_id, request_id) ON DELETE RESTRICT,
  CONSTRAINT privacy_execution_actions_separation_of_duties
    CHECK (approver_id IS NULL OR approver_id <> processor_id),
  CONSTRAINT privacy_execution_actions_purposes_allowed
    CHECK (purposes <@ ARRAY['service','marketing','privacy','photo','medical_data','all']::text[]),
  CONSTRAINT privacy_execution_actions_purposes_required
    CHECK (
      action_type IN ('export_plan','delete_plan')
      OR cardinality(purposes) > 0
    ),
  CONSTRAINT privacy_execution_actions_approval_state
    CHECK (
      (status = 'planned' AND approver_id IS NULL AND approved_at IS NULL AND completed_at IS NULL)
      OR
      (status IN ('executed','manual_pending') AND approver_id IS NOT NULL
        AND approved_at IS NOT NULL AND completed_at IS NOT NULL)
      OR
      (status = 'failed')
    )
);

CREATE INDEX IF NOT EXISTS privacy_execution_actions_queue_idx
  ON privacy_execution_actions (tenant_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS privacy_execution_actions_request_idx
  ON privacy_execution_actions (tenant_id, request_id, created_at, id);

CREATE TABLE IF NOT EXISTS contact_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  subject_reference_hmac char(64) NOT NULL
    CHECK (subject_reference_hmac ~ '^[0-9a-f]{64}$'),
  purpose varchar(24) NOT NULL
    CHECK (purpose IN ('service','marketing','privacy','photo','medical_data','all')),
  status varchar(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','released')),
  reason varchar(32) NOT NULL
    CHECK (reason IN ('consent_withdrawn','processing_restricted')),
  origin_request_id varchar(128) NOT NULL,
  last_request_id varchar(128) NOT NULL,
  last_action_id varchar(160) NOT NULL,
  created_by varchar(160) NOT NULL,
  released_by varchar(160),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT contact_suppressions_origin_request_fk
    FOREIGN KEY (tenant_id, origin_request_id)
    REFERENCES data_subject_requests(tenant_id, request_id) ON DELETE RESTRICT,
  CONSTRAINT contact_suppressions_last_request_fk
    FOREIGN KEY (tenant_id, last_request_id)
    REFERENCES data_subject_requests(tenant_id, request_id) ON DELETE RESTRICT,
  CONSTRAINT contact_suppressions_last_action_fk
    FOREIGN KEY (tenant_id, last_action_id)
    REFERENCES privacy_execution_actions(tenant_id, action_id) ON DELETE RESTRICT,
  CONSTRAINT contact_suppressions_release_state
    CHECK (
      (status = 'active' AND released_at IS NULL AND released_by IS NULL)
      OR
      (status = 'released' AND released_at IS NOT NULL AND released_by IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_suppressions_active_unique
  ON contact_suppressions (tenant_id, subject_reference_hmac, purpose)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS contact_suppressions_subject_idx
  ON contact_suppressions (tenant_id, subject_reference_hmac, status, purpose);

DROP TRIGGER IF EXISTS privacy_execution_actions_set_updated_at ON privacy_execution_actions;
CREATE TRIGGER privacy_execution_actions_set_updated_at BEFORE UPDATE ON privacy_execution_actions
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS contact_suppressions_set_updated_at ON contact_suppressions;
CREATE TRIGGER contact_suppressions_set_updated_at BEFORE UPDATE ON contact_suppressions
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();

ALTER TABLE privacy_execution_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON privacy_execution_actions;
CREATE POLICY tenant_isolation ON privacy_execution_actions
  USING (tenant_id = huamei_current_tenant())
  WITH CHECK (tenant_id = huamei_current_tenant());
ALTER TABLE privacy_execution_actions FORCE ROW LEVEL SECURITY;

ALTER TABLE contact_suppressions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON contact_suppressions;
CREATE POLICY tenant_isolation ON contact_suppressions
  USING (tenant_id = huamei_current_tenant())
  WITH CHECK (tenant_id = huamei_current_tenant());
ALTER TABLE contact_suppressions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON privacy_execution_actions, contact_suppressions FROM PUBLIC, huamei_runtime;
GRANT SELECT, INSERT, UPDATE ON privacy_execution_actions, contact_suppressions TO huamei_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO huamei_runtime;

COMMENT ON TABLE privacy_execution_actions IS
  'Two-person privacy execution ledger. Delete/export remain manual plans; no physical deletion is performed here.';
COMMENT ON TABLE contact_suppressions IS
  'Tenant-scoped purpose suppression projection keyed only by an irreversible subject reference.';

COMMIT;
