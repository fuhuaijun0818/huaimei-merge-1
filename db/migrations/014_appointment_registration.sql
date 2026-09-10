BEGIN;

CREATE TABLE appointment_sessions (
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  scope_key char(64) NOT NULL CHECK (scope_key ~ '^[0-9a-f]{64}$'),
  appointment_ids text[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, scope_key)
);
CREATE INDEX appointment_sessions_ids ON appointment_sessions USING gin (appointment_ids);
ALTER TABLE appointment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appointment_sessions
  USING (tenant_id = huamei_current_tenant()) WITH CHECK (tenant_id = huamei_current_tenant());
REVOKE ALL ON appointment_sessions FROM PUBLIC, huamei_runtime;
GRANT SELECT, INSERT, UPDATE ON appointment_sessions TO huamei_runtime;
COMMENT ON TABLE appointment_sessions IS 'Encrypted per-conversation registrations, customer confirmations, idempotent operations and follow-up notices. No doctor slots or capacity.';

COMMIT;
