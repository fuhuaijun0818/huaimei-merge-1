BEGIN;

ALTER TABLE knowledge_releases
  ADD COLUMN IF NOT EXISTS record_list_checksum char(64),
  ADD COLUMN IF NOT EXISTS index_checksum char(64),
  ADD COLUMN IF NOT EXISTS index_version varchar(128),
  ADD COLUMN IF NOT EXISTS effective_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE knowledge_releases
SET record_list_checksum = COALESCE(record_list_checksum, NULLIF(manifest->>'approved_record_ids_checksum','')),
    index_checksum = COALESCE(index_checksum, NULLIF(manifest->>'index_checksum','')),
    index_version = COALESCE(index_version, NULLIF(manifest->>'index_version','')),
    effective_at = COALESCE(effective_at, activated_at, published_at, created_at),
    expires_at = COALESCE(expires_at, NULLIF(manifest->>'expires_at','')::timestamptz);

ALTER TABLE knowledge_releases
  DROP CONSTRAINT IF EXISTS knowledge_releases_record_list_checksum_format,
  ADD CONSTRAINT knowledge_releases_record_list_checksum_format
    CHECK (record_list_checksum IS NULL OR record_list_checksum ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS knowledge_releases_index_checksum_format,
  ADD CONSTRAINT knowledge_releases_index_checksum_format
    CHECK (index_checksum IS NULL OR index_checksum ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS knowledge_releases_active_binding,
  ADD CONSTRAINT knowledge_releases_active_binding
    CHECK (NOT is_active OR (
      package_checksum IS NOT NULL
      AND record_list_checksum IS NOT NULL
      AND index_checksum IS NOT NULL
      AND effective_at IS NOT NULL
    )),
  DROP CONSTRAINT IF EXISTS knowledge_releases_effective_order,
  ADD CONSTRAINT knowledge_releases_effective_order
    CHECK (expires_at IS NULL OR effective_at IS NULL OR expires_at > effective_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  run_id varchar(128) NOT NULL,
  request_id varchar(160) NOT NULL,
  agent_id varchar(64) NOT NULL,
  agent_version varchar(64),
  status varchar(32) NOT NULL,
  channel varchar(32) NOT NULL DEFAULT 'api',
  caller varchar(128),
  decision varchar(32),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  audit jsonb NOT NULL CHECK (jsonb_typeof(audit) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_runs_business_key UNIQUE (tenant_id, run_id)
);

CREATE INDEX IF NOT EXISTS agent_runs_timeline_idx
  ON agent_runs (tenant_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS agent_runs_request_idx
  ON agent_runs (tenant_id, request_id);

CREATE TABLE IF NOT EXISTS data_migration_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  batch_id varchar(128) NOT NULL,
  source_type varchar(48) NOT NULL,
  source_checksum char(64) NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  status varchar(24) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','dry_run','validated','cutover','completed','rolled_back','failed')),
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(manifest) = 'object'),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  validation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(validation) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT data_migration_batches_business_key UNIQUE (tenant_id, batch_id),
  CONSTRAINT data_migration_batches_time_order
    CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS data_migration_batches_status_idx
  ON data_migration_batches (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS data_subject_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  request_id varchar(128) NOT NULL,
  request_type varchar(24) NOT NULL
    CHECK (request_type IN ('access','export','correct','delete','restrict','withdraw_consent')),
  subject_reference_hmac char(64) NOT NULL CHECK (subject_reference_hmac ~ '^[0-9a-f]{64}$'),
  status varchar(24) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','identity_pending','in_progress','fulfilled','partially_fulfilled','rejected','cancelled')),
  legal_hold boolean NOT NULL DEFAULT false,
  identity_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(identity_evidence) = 'object'),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  due_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT data_subject_requests_business_key UNIQUE (tenant_id, request_id),
  CONSTRAINT data_subject_requests_completion_order
    CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX IF NOT EXISTS data_subject_requests_queue_idx
  ON data_subject_requests (tenant_id, status, due_at, created_at);

DROP TRIGGER IF EXISTS agent_runs_set_updated_at ON agent_runs;
CREATE TRIGGER agent_runs_set_updated_at BEFORE UPDATE ON agent_runs
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS data_migration_batches_set_updated_at ON data_migration_batches;
CREATE TRIGGER data_migration_batches_set_updated_at BEFORE UPDATE ON data_migration_batches
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS data_subject_requests_set_updated_at ON data_subject_requests;
CREATE TRIGGER data_subject_requests_set_updated_at BEFORE UPDATE ON data_subject_requests
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();

CREATE OR REPLACE FUNCTION huamei_current_tenant()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'tenants','conversation_sessions','conversation_messages','leads','consents',
    'handovers','tasks','human_work','knowledge_releases','knowledge_reviews',
    'audit_events','outbox_events','idempotency_records','agent_runs',
    'data_migration_batches','data_subject_requests'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = huamei_current_tenant()) WITH CHECK (tenant_id = huamei_current_tenant())',
      table_name
    );
  END LOOP;
END
$$;

COMMIT;
