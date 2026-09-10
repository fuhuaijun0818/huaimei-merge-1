BEGIN;
CREATE TABLE knowledge_intake_state (
 tenant_id varchar(64) PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 revision bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE knowledge_intake_assets (
 tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
 asset_id varchar(128) NOT NULL,
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 PRIMARY KEY(tenant_id,asset_id)
);
ALTER TABLE knowledge_intake_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_intake_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_intake_state USING(tenant_id=huamei_current_tenant()) WITH CHECK(tenant_id=huamei_current_tenant());
ALTER TABLE knowledge_intake_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_intake_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_intake_assets USING(tenant_id=huamei_current_tenant()) WITH CHECK(tenant_id=huamei_current_tenant());
REVOKE ALL ON knowledge_intake_state, knowledge_intake_assets FROM PUBLIC,huamei_runtime;
GRANT SELECT,INSERT,UPDATE ON knowledge_intake_state,knowledge_intake_assets TO huamei_runtime;
COMMIT;
