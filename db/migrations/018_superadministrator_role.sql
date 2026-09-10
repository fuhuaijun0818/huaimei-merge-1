BEGIN;
ALTER TABLE management_accounts DROP CONSTRAINT management_accounts_business_role_check;
ALTER TABLE management_accounts ADD CONSTRAINT management_accounts_business_role_check
CHECK(business_role IN ('系统管理员','售前顾问','内容专员','发布与索引管理员','质量与运营人员','超级管理员'));
COMMIT;
