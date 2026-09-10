BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huamei_runtime') THEN
    CREATE ROLE huamei_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO huamei_runtime;

GRANT SELECT, INSERT, UPDATE ON
  tenants,
  conversation_sessions,
  conversation_messages,
  leads,
  consents,
  handovers,
  tasks,
  human_work,
  knowledge_releases,
  knowledge_reviews,
  outbox_events,
  idempotency_records,
  agent_runs,
  data_subject_requests
TO huamei_runtime;

GRANT SELECT, INSERT ON audit_events TO huamei_runtime;
GRANT SELECT ON data_migration_batches TO huamei_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO huamei_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO huamei_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO huamei_runtime;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
ALTER TABLE consents FORCE ROW LEVEL SECURITY;
ALTER TABLE handovers FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE human_work FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE data_migration_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE data_subject_requests FORCE ROW LEVEL SECURITY;

COMMIT;
