BEGIN;
CREATE TABLE knowledge_publication_packages (
 tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id),
 package_id varchar(128) NOT NULL,
 request_key varchar(128) NOT NULL,
 checksum char(64) NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,package_id), UNIQUE(tenant_id,request_key)
);
CREATE TABLE knowledge_publication_events (
 tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id),
 event_id uuid NOT NULL DEFAULT gen_random_uuid(),
 request_key varchar(128) NOT NULL,
 package_id varchar(128) NOT NULL,
 kind varchar(32) NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,event_id), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,package_id) REFERENCES knowledge_publication_packages(tenant_id,package_id)
);
CREATE TABLE knowledge_publication_heads (
 tenant_id varchar(64) PRIMARY KEY REFERENCES tenants(tenant_id),
 package_id varchar(128),
 revision bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,package_id) REFERENCES knowledge_publication_packages(tenant_id,package_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['knowledge_publication_packages','knowledge_publication_events','knowledge_publication_heads'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=huamei_current_tenant()) WITH CHECK(tenant_id=huamei_current_tenant())',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,huamei_runtime',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON knowledge_publication_packages,knowledge_publication_events TO huamei_runtime;
GRANT SELECT,INSERT,UPDATE ON knowledge_publication_heads TO huamei_runtime;
COMMIT;
