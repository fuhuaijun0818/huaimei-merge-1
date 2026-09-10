BEGIN;
CREATE TABLE management_accounts (
 tenant_id varchar(64) NOT NULL REFERENCES tenants(tenant_id),
 subject varchar(160) NOT NULL,
 account varchar(80) NOT NULL,
 display_name varchar(120) NOT NULL,
 business_role varchar(80) NOT NULL,
 department_ids text[] NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 password_hash text,
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,subject),UNIQUE(tenant_id,account),
 CHECK(business_role IN ('系统管理员','售前顾问','内容专员','发布与索引管理员','质量与运营人员')),
 CHECK(cardinality(department_ids)>0)
);
ALTER TABLE management_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE management_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON management_accounts USING(tenant_id=huamei_current_tenant()) WITH CHECK(tenant_id=huamei_current_tenant());
REVOKE ALL ON management_accounts FROM PUBLIC,huamei_runtime;
GRANT SELECT,INSERT,UPDATE ON management_accounts TO huamei_runtime;
COMMIT;
