BEGIN;

ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS engine_pin jsonb NOT NULL DEFAULT '{"engine":"legacy","graph_version":"legacy","state_schema_version":"legacy"}'::jsonb,
  ADD COLUMN IF NOT EXISTS handover_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fencing_counter bigint NOT NULL DEFAULT 0;

ALTER TABLE conversation_sessions
  DROP CONSTRAINT IF EXISTS conversation_sessions_engine_pin_shape,
  ADD CONSTRAINT conversation_sessions_engine_pin_shape CHECK (
    jsonb_typeof(engine_pin) = 'object'
    AND engine_pin ? 'engine'
    AND engine_pin ? 'graph_version'
    AND engine_pin ? 'state_schema_version'
    AND engine_pin->>'engine' IN ('legacy', 'shadow', 'langgraph')
  ),
  DROP CONSTRAINT IF EXISTS conversation_sessions_handover_epoch_positive,
  ADD CONSTRAINT conversation_sessions_handover_epoch_positive CHECK (handover_epoch >= 0),
  DROP CONSTRAINT IF EXISTS conversation_sessions_fencing_counter_positive,
  ADD CONSTRAINT conversation_sessions_fencing_counter_positive CHECK (fencing_counter >= 0);

CREATE TABLE IF NOT EXISTS agent_turn_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  session_record_id uuid NOT NULL,
  inbound_message_id varchar(160) NOT NULL,
  turn_sequence bigint NOT NULL CHECK (turn_sequence >= 1),
  expected_state_version bigint NOT NULL CHECK (expected_state_version >= 0),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  engine_pin jsonb NOT NULL CHECK (jsonb_typeof(engine_pin) = 'object'),
  -- `status` is the Node-owned domain commit stage. The outcome returned by
  -- LangGraph is intentionally stored separately: an `interrupted` decision
  -- can be durably prepared and then committed without ever executing a write.
  status varchar(24) NOT NULL CHECK (status IN ('prepared', 'committed', 'cancelled', 'expired')),
  decision_status varchar(32) NOT NULL CHECK (decision_status IN ('prepared', 'interrupted', 'policy_blocked', 'retryable_error')),
  run_id varchar(160),
  checkpoint_id varchar(160),
  decision_hash char(64) NOT NULL CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
  decision jsonb NOT NULL CHECK (jsonb_typeof(decision) = 'object'),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_turn_results_session_fk
    FOREIGN KEY (tenant_id, session_record_id)
    REFERENCES conversation_sessions(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_turn_results_message_fk
    FOREIGN KEY (tenant_id, session_record_id, inbound_message_id)
    REFERENCES conversation_messages(tenant_id, session_record_id, message_id) ON DELETE RESTRICT,
  CONSTRAINT agent_turn_results_commit_time CHECK (
    (status = 'committed' AND committed_at IS NOT NULL)
    OR (status <> 'committed' AND committed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_turn_results_message_unique
  ON agent_turn_results (tenant_id, session_record_id, inbound_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_turn_results_sequence_unique
  ON agent_turn_results (tenant_id, session_record_id, turn_sequence);
CREATE INDEX IF NOT EXISTS agent_turn_results_fencing_idx
  ON agent_turn_results (tenant_id, session_record_id, fencing_token, status);
CREATE INDEX IF NOT EXISTS agent_turn_results_recovery_idx
  ON agent_turn_results (tenant_id, status, expires_at, prepared_at)
  WHERE status = 'prepared';

CREATE TABLE IF NOT EXISTS agent_effect_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  session_record_id uuid,
  effect_id varchar(160) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  command_type varchar(96) NOT NULL,
  result_hash char(64),
  status varchar(24) NOT NULL CHECK (status IN ('prepared', 'executed', 'failed', 'compensation_pending', 'compensated')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_effect_ledger_session_fk
    FOREIGN KEY (tenant_id, session_record_id)
    REFERENCES conversation_sessions(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT agent_effect_ledger_result_hash_format
    CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_effect_ledger_idempotency_unique
    UNIQUE (tenant_id, idempotency_key, command_type),
  CONSTRAINT agent_effect_ledger_effect_unique
    UNIQUE (tenant_id, effect_id)
);

CREATE TABLE IF NOT EXISTS agent_turn_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  session_record_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  holder_id varchar(160) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CONSTRAINT agent_turn_leases_session_fk
    FOREIGN KEY (tenant_id, session_record_id)
    REFERENCES conversation_sessions(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_turn_leases_fencing_unique
    UNIQUE (tenant_id, session_record_id, fencing_token),
  CONSTRAINT agent_turn_leases_expiry_order CHECK (expires_at > acquired_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_turn_leases_one_active_per_session
  ON agent_turn_leases (tenant_id, session_record_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS agent_turn_leases_expiry_idx
  ON agent_turn_leases (expires_at, tenant_id, session_record_id)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS agent_turn_results_set_updated_at ON agent_turn_results;
CREATE TRIGGER agent_turn_results_set_updated_at BEFORE UPDATE ON agent_turn_results
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();
DROP TRIGGER IF EXISTS agent_effect_ledger_set_updated_at ON agent_effect_ledger;
CREATE TRIGGER agent_effect_ledger_set_updated_at BEFORE UPDATE ON agent_effect_ledger
FOR EACH ROW EXECUTE FUNCTION huamei_set_updated_at();

ALTER TABLE agent_turn_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_turn_results;
CREATE POLICY tenant_isolation ON agent_turn_results
  USING (tenant_id = huamei_current_tenant())
  WITH CHECK (tenant_id = huamei_current_tenant());
ALTER TABLE agent_turn_results FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_effect_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_effect_ledger;
CREATE POLICY tenant_isolation ON agent_effect_ledger
  USING (tenant_id = huamei_current_tenant())
  WITH CHECK (tenant_id = huamei_current_tenant());
ALTER TABLE agent_effect_ledger FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_turn_leases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_turn_leases;
CREATE POLICY tenant_isolation ON agent_turn_leases
  USING (tenant_id = huamei_current_tenant())
  WITH CHECK (tenant_id = huamei_current_tenant());
ALTER TABLE agent_turn_leases FORCE ROW LEVEL SECURITY;

REVOKE ALL ON agent_turn_results, agent_effect_ledger, agent_turn_leases FROM PUBLIC, huamei_runtime;
GRANT SELECT, INSERT, UPDATE ON agent_turn_results, agent_effect_ledger, agent_turn_leases TO huamei_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO huamei_runtime;

COMMENT ON TABLE agent_turn_results IS
  'Node-owned commit records for prepared LangGraph TurnDecision outcomes. Decision status is distinct from domain commit stage.';
COMMENT ON TABLE agent_effect_ledger IS
  'Business idempotency ledger for effects. A graph checkpoint is never an effect receipt.';
COMMENT ON TABLE agent_turn_leases IS
  'Short single-session executor leases. Fencing tokens prevent expired graph runs from committing or delivering.';

COMMIT;
