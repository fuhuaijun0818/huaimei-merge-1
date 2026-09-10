BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION huamei_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id varchar(64) PRIMARY KEY,
  display_name varchar(160) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'archived')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tenants_id_format CHECK (tenant_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$')
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  session_id varchar(128) NOT NULL,
  channel varchar(32) NOT NULL,
  external_conversation_id varchar(256),
  customer_id varchar(128),
  lead_id uuid,
  status varchar(24) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'handover_pending', 'human_active', 'closed', 'expired')),
  state jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(state) = 'object'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT conversation_sessions_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT conversation_sessions_business_key UNIQUE (tenant_id, channel, session_id),
  CONSTRAINT conversation_sessions_expiry_order CHECK (expires_at IS NULL OR expires_at >= started_at),
  CONSTRAINT conversation_sessions_close_order CHECK (closed_at IS NULL OR closed_at >= started_at)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  session_record_id uuid NOT NULL,
  message_id varchar(160) NOT NULL,
  role varchar(24) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'human_agent', 'tool')),
  direction varchar(16) NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  content_segments jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(content_segments) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT conversation_messages_session_fk
    FOREIGN KEY (tenant_id, session_record_id)
    REFERENCES conversation_sessions(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_messages_external_unique
    UNIQUE (tenant_id, session_record_id, message_id)
);

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  lead_id varchar(128) NOT NULL,
  source_session_id uuid,
  customer_id varchar(128),
  normalized_mobile_hmac char(64),
  masked_mobile varchar(32),
  display_name varchar(120),
  source_channel varchar(32) NOT NULL DEFAULT 'web',
  macro_stage varchar(32) NOT NULL DEFAULT '售前',
  micro_stage varchar(64) NOT NULL DEFAULT '新咨询',
  primary_interest varchar(160),
  interests jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(interests) = 'array'),
  profile jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(profile) = 'object'),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT leads_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT leads_business_key UNIQUE (tenant_id, lead_id),
  CONSTRAINT leads_session_fk
    FOREIGN KEY (tenant_id, source_session_id)
    REFERENCES conversation_sessions(tenant_id, id) ON DELETE SET NULL (source_session_id),
  CONSTRAINT leads_mobile_hmac_format
    CHECK (normalized_mobile_hmac IS NULL OR normalized_mobile_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT leads_seen_order CHECK (last_seen_at >= first_seen_at)
);

ALTER TABLE conversation_sessions
  DROP CONSTRAINT IF EXISTS conversation_sessions_lead_fk;
ALTER TABLE conversation_sessions
  ADD CONSTRAINT conversation_sessions_lead_fk
  FOREIGN KEY (tenant_id, lead_id)
  REFERENCES leads(tenant_id, id) ON DELETE SET NULL (lead_id);

CREATE TABLE IF NOT EXISTS consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  lead_record_id uuid NOT NULL,
  consent_type varchar(40) NOT NULL
    CHECK (consent_type IN ('service', 'privacy', 'marketing', 'photo', 'medical_data')),
  granted boolean NOT NULL,
  policy_version varchar(64) NOT NULL,
  source varchar(32) NOT NULL DEFAULT 'web',
  evidence_hash char(64),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object'),
  is_current boolean NOT NULL DEFAULT true,
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT consents_lead_fk
    FOREIGN KEY (tenant_id, lead_record_id)
    REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT consents_evidence_hash_format
    CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT consents_revoke_order CHECK (revoked_at IS NULL OR revoked_at >= effective_at),
  CONSTRAINT consents_current_not_revoked CHECK (NOT is_current OR revoked_at IS NULL)
);

CREATE TABLE IF NOT EXISTS handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  handover_id varchar(128) NOT NULL,
  session_record_id uuid NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'cancelled', 'expired')),
  reason varchar(160) NOT NULL,
  team varchar(80) NOT NULL,
  assignee varchar(128),
  priority smallint NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(snapshot) = 'object'),
  sla_due_at timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT handovers_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT handovers_business_key UNIQUE (tenant_id, handover_id),
  CONSTRAINT handovers_session_fk
    FOREIGN KEY (tenant_id, session_record_id)
    REFERENCES conversation_sessions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT handovers_claim_order CHECK (claimed_at IS NULL OR claimed_at >= created_at),
  CONSTRAINT handovers_complete_order CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  task_id varchar(128) NOT NULL,
  handover_record_id uuid,
  session_record_id uuid,
  task_type varchar(48) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'in_progress', 'completed', 'cancelled', 'failed')),
  priority smallint NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  assignee varchar(128),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  result jsonb
    CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tasks_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT tasks_business_key UNIQUE (tenant_id, task_id),
  CONSTRAINT tasks_handover_fk
    FOREIGN KEY (tenant_id, handover_record_id)
    REFERENCES handovers(tenant_id, id) ON DELETE SET NULL (handover_record_id),
  CONSTRAINT tasks_session_fk
    FOREIGN KEY (tenant_id, session_record_id)
    REFERENCES conversation_sessions(tenant_id, id) ON DELETE SET NULL (session_record_id),
  CONSTRAINT tasks_due_order CHECK (due_at IS NULL OR due_at >= created_at),
  CONSTRAINT tasks_complete_order CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE TABLE IF NOT EXISTS human_work (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  session_record_id uuid NOT NULL,
  handover_record_id uuid,
  task_record_id uuid,
  staff_id varchar(128) NOT NULL,
  work_type varchar(48) NOT NULL,
  minutes numeric(10,2) NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  notes text,
  started_at timestamptz,
  ended_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT human_work_session_fk
    FOREIGN KEY (tenant_id, session_record_id)
    REFERENCES conversation_sessions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT human_work_handover_fk
    FOREIGN KEY (tenant_id, handover_record_id)
    REFERENCES handovers(tenant_id, id) ON DELETE SET NULL (handover_record_id),
  CONSTRAINT human_work_task_fk
    FOREIGN KEY (tenant_id, task_record_id)
    REFERENCES tasks(tenant_id, id) ON DELETE SET NULL (task_record_id),
  CONSTRAINT human_work_time_order CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE IF NOT EXISTS knowledge_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  release_id varchar(128) NOT NULL,
  package_version varchar(128) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'reviewing', 'approved', 'active', 'superseded', 'rejected')),
  package_checksum char(64),
  approved_record_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(manifest) = 'object'),
  is_active boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  published_at timestamptz,
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT knowledge_releases_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT knowledge_releases_business_key UNIQUE (tenant_id, release_id),
  CONSTRAINT knowledge_releases_version_unique UNIQUE (tenant_id, package_version),
  CONSTRAINT knowledge_releases_checksum_format
    CHECK (package_checksum IS NULL OR package_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT knowledge_releases_active_state CHECK (NOT is_active OR status = 'active'),
  CONSTRAINT knowledge_releases_activation_time CHECK (NOT is_active OR activated_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS knowledge_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  release_record_id uuid NOT NULL,
  review_type varchar(24) NOT NULL CHECK (review_type IN ('business', 'medical', 'compliance')),
  reviewer_id varchar(128) NOT NULL,
  decision varchar(24) NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes_requested')),
  comments text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object'),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT knowledge_reviews_release_fk
    FOREIGN KEY (tenant_id, release_record_id)
    REFERENCES knowledge_releases(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT knowledge_reviews_stage_unique
    UNIQUE (tenant_id, release_record_id, review_type)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  event_id varchar(160) NOT NULL,
  actor_type varchar(32) NOT NULL,
  actor_id varchar(160),
  action varchar(128) NOT NULL,
  resource_type varchar(80) NOT NULL,
  resource_id varchar(160),
  request_id varchar(160),
  trace_id varchar(160),
  outcome varchar(24) NOT NULL DEFAULT 'success'
    CHECK (outcome IN ('success', 'denied', 'failure', 'unknown')),
  ip_hash char(64),
  user_agent_hash char(64),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT audit_events_business_key UNIQUE (tenant_id, event_id),
  CONSTRAINT audit_events_ip_hash_format CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_events_user_agent_hash_format CHECK (user_agent_hash IS NULL OR user_agent_hash ~ '^[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION huamei_reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION huamei_reject_audit_event_mutation();
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate
BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION huamei_reject_audit_event_mutation();

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  event_id varchar(160) NOT NULL,
  aggregate_type varchar(80) NOT NULL,
  aggregate_id varchar(160) NOT NULL,
  event_type varchar(128) NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  headers jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(headers) = 'object'),
  status varchar(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'published', 'retry', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  locked_by varchar(160),
  last_error text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT outbox_events_business_key UNIQUE (tenant_id, event_id),
  CONSTRAINT outbox_events_lock_pair CHECK ((locked_at IS NULL) = (locked_by IS NULL)),
  CONSTRAINT outbox_events_publish_state CHECK (published_at IS NULL OR status = 'published')
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  caller_id varchar(128) NOT NULL,
  channel varchar(32) NOT NULL,
  conversation_id varchar(256) NOT NULL,
  operation varchar(96) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  state varchar(24) NOT NULL DEFAULT 'in_progress'
    CHECK (state IN ('in_progress', 'completed', 'failed')),
  response_status integer CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  response_body jsonb,
  locked_until timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT idempotency_records_scope_unique
    UNIQUE (tenant_id, caller_id, channel, conversation_id, operation, idempotency_key),
  CONSTRAINT idempotency_records_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT idempotency_records_completed_response
    CHECK (state <> 'completed' OR response_status IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS leads_tenant_mobile_hmac_unique
  ON leads (tenant_id, normalized_mobile_hmac)
  WHERE normalized_mobile_hmac IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_sessions_external_unique
  ON conversation_sessions (tenant_id, channel, external_conversation_id)
  WHERE external_conversation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS consents_current_unique
  ON consents (tenant_id, lead_record_id, consent_type)
  WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS handovers_open_session_unique
  ON handovers (tenant_id, session_record_id)
  WHERE status IN ('pending', 'claimed');
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_releases_one_active_per_tenant
  ON knowledge_releases (tenant_id)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS conversation_sessions_activity_idx
  ON conversation_sessions (tenant_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS conversation_sessions_customer_idx
  ON conversation_sessions (tenant_id, customer_id, last_activity_at DESC)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_sessions_expiry_idx
  ON conversation_sessions (expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_messages_timeline_idx
  ON conversation_messages (tenant_id, session_record_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS conversation_messages_created_idx
  ON conversation_messages (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_customer_idx
  ON leads (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_last_seen_idx
  ON leads (tenant_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS consents_lead_timeline_idx
  ON consents (tenant_id, lead_record_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS handovers_queue_idx
  ON handovers (tenant_id, status, priority DESC, sla_due_at, created_at);
CREATE INDEX IF NOT EXISTS tasks_queue_idx
  ON tasks (tenant_id, status, priority DESC, available_at, due_at);
CREATE INDEX IF NOT EXISTS human_work_session_idx
  ON human_work (tenant_id, session_record_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS human_work_staff_idx
  ON human_work (tenant_id, staff_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_releases_status_idx
  ON knowledge_releases (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_timeline_idx
  ON audit_events (tenant_id, occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS audit_events_resource_idx
  ON audit_events (tenant_id, resource_type, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_request_idx
  ON audit_events (tenant_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbox_events_delivery_idx
  ON outbox_events (status, available_at, created_at)
  WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS outbox_events_aggregate_idx
  ON outbox_events (tenant_id, aggregate_type, aggregate_id, created_at);
CREATE INDEX IF NOT EXISTS idempotency_records_expiry_idx
  ON idempotency_records (expires_at);

DROP TRIGGER IF EXISTS tenants_set_updated_at ON tenants;
CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS conversation_sessions_set_updated_at ON conversation_sessions;
CREATE TRIGGER conversation_sessions_set_updated_at BEFORE UPDATE ON conversation_sessions
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS conversation_messages_set_updated_at ON conversation_messages;
CREATE TRIGGER conversation_messages_set_updated_at BEFORE UPDATE ON conversation_messages
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS leads_set_updated_at ON leads;
CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS consents_set_updated_at ON consents;
CREATE TRIGGER consents_set_updated_at BEFORE UPDATE ON consents
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS handovers_set_updated_at ON handovers;
CREATE TRIGGER handovers_set_updated_at BEFORE UPDATE ON handovers
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS tasks_set_updated_at ON tasks;
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS human_work_set_updated_at ON human_work;
CREATE TRIGGER human_work_set_updated_at BEFORE UPDATE ON human_work
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS knowledge_releases_set_updated_at ON knowledge_releases;
CREATE TRIGGER knowledge_releases_set_updated_at BEFORE UPDATE ON knowledge_releases
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS knowledge_reviews_set_updated_at ON knowledge_reviews;
CREATE TRIGGER knowledge_reviews_set_updated_at BEFORE UPDATE ON knowledge_reviews
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS outbox_events_set_updated_at ON outbox_events;
CREATE TRIGGER outbox_events_set_updated_at BEFORE UPDATE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS idempotency_records_set_updated_at ON idempotency_records;
CREATE TRIGGER idempotency_records_set_updated_at BEFORE UPDATE ON idempotency_records
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();

COMMIT;
