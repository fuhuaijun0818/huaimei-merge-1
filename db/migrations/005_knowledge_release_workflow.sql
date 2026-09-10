BEGIN;

ALTER TABLE knowledge_releases
  DROP CONSTRAINT IF EXISTS knowledge_releases_active_binding,
  ADD CONSTRAINT knowledge_releases_active_binding
    CHECK (NOT is_active OR (
      package_checksum IS NOT NULL
      AND record_list_checksum IS NOT NULL
      AND index_checksum IS NOT NULL
      AND index_version IS NOT NULL
      AND effective_at IS NOT NULL
      AND jsonb_typeof(manifest) = 'object'
      AND manifest ? 'manifest_sha256'
      AND manifest ? 'release_binding'
    ));

CREATE OR REPLACE FUNCTION huamei_knowledge_review_scope_checksum(
  p_tenant_id text,
  p_release_id text,
  p_package_version text,
  p_package_checksum text,
  p_record_list_checksum text,
  p_index_version text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(public.digest(
    concat_ws(E'\n',
      p_tenant_id,
      p_release_id,
      p_package_version,
      p_package_checksum,
      p_record_list_checksum,
      p_index_version
    ),
    'sha256'
  ), 'hex')
$$;

CREATE OR REPLACE FUNCTION huamei_assert_function_tenant(p_tenant_id text)
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_tenant_id IS NULL
     OR p_tenant_id = ''
     OR p_tenant_id IS DISTINCT FROM public.huamei_current_tenant() THEN
    RAISE EXCEPTION 'tenant context does not match release tenant'
      USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION huamei_create_knowledge_release_draft(
  p_tenant_id varchar,
  p_release_id varchar,
  p_package_version varchar,
  p_package_checksum char(64),
  p_approved_record_ids text[],
  p_record_list_checksum char(64),
  p_index_version varchar,
  p_manifest jsonb,
  p_effective_at timestamptz,
  p_expires_at timestamptz,
  p_created_by varchar
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  created_id uuid;
BEGIN
  PERFORM public.huamei_assert_function_tenant(p_tenant_id);
  IF p_package_checksum !~ '^[0-9a-f]{64}$'
     OR p_record_list_checksum !~ '^[0-9a-f]{64}$'
     OR coalesce(p_index_version, '') = ''
     OR coalesce(array_length(p_approved_record_ids, 1), 0) < 1 THEN
    RAISE EXCEPTION 'knowledge release binding is incomplete'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.knowledge_releases
    (tenant_id, release_id, package_version, status, package_checksum,
     approved_record_ids, record_list_checksum, index_version, manifest,
     is_active, effective_at, expires_at, created_by)
  VALUES
    (p_tenant_id, p_release_id, p_package_version, 'reviewing', p_package_checksum,
     p_approved_record_ids, p_record_list_checksum, p_index_version,
     coalesce(p_manifest, '{}'::jsonb), false,
     coalesce(p_effective_at, clock_timestamp()), p_expires_at, p_created_by)
  RETURNING id INTO created_id;
  RETURN created_id;
END
$$;

CREATE OR REPLACE FUNCTION huamei_record_knowledge_review(
  p_tenant_id varchar,
  p_release_id varchar,
  p_review_type varchar,
  p_reviewer_id varchar,
  p_reviewer_role varchar,
  p_decision varchar,
  p_comments text,
  p_evidence jsonb,
  p_reviewed_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  release_row public.knowledge_releases%ROWTYPE;
  existing_row public.knowledge_reviews%ROWTYPE;
  expected_role text;
  expected_scope text;
  created_id uuid;
  approvals integer;
BEGIN
  PERFORM public.huamei_assert_function_tenant(p_tenant_id);
  expected_role := 'knowledge.' || p_review_type || '_reviewer';
  IF p_review_type NOT IN ('business', 'medical', 'compliance')
     OR p_reviewer_role IS DISTINCT FROM expected_role
     OR p_decision NOT IN ('approved', 'rejected', 'changes_requested') THEN
    RAISE EXCEPTION 'review role or decision is invalid'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO release_row
  FROM public.knowledge_releases
  WHERE tenant_id = p_tenant_id AND release_id = p_release_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge release not found' USING ERRCODE = 'P0002';
  END IF;
  IF release_row.status NOT IN ('draft', 'reviewing', 'approved') OR release_row.is_active THEN
    RAISE EXCEPTION 'knowledge release is not reviewable' USING ERRCODE = '55000';
  END IF;
  expected_scope := public.huamei_knowledge_review_scope_checksum(
    release_row.tenant_id,
    release_row.release_id,
    release_row.package_version,
    release_row.package_checksum,
    release_row.record_list_checksum,
    release_row.index_version
  );
  IF coalesce(p_evidence->>'scope_checksum', '') IS DISTINCT FROM expected_scope THEN
    RAISE EXCEPTION 'review scope checksum does not match release'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.knowledge_reviews
    WHERE tenant_id = p_tenant_id
      AND release_record_id = release_row.id
      AND reviewer_id = p_reviewer_id
      AND review_type <> p_review_type
  ) THEN
    RAISE EXCEPTION 'three review stages require distinct reviewers'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO existing_row
  FROM public.knowledge_reviews
  WHERE tenant_id = p_tenant_id
    AND release_record_id = release_row.id
    AND review_type = p_review_type;
  IF FOUND THEN
    IF existing_row.reviewer_id = p_reviewer_id
       AND existing_row.decision = p_decision
       AND existing_row.evidence = coalesce(p_evidence, '{}'::jsonb) THEN
      RETURN existing_row.id;
    END IF;
    RAISE EXCEPTION 'review stage already has an immutable decision'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.knowledge_reviews
    (tenant_id, release_record_id, review_type, reviewer_id, decision,
     comments, evidence, reviewed_at)
  VALUES
    (p_tenant_id, release_row.id, p_review_type, p_reviewer_id, p_decision,
     nullif(p_comments, ''), coalesce(p_evidence, '{}'::jsonb),
     coalesce(p_reviewed_at, clock_timestamp()))
  RETURNING id INTO created_id;

  IF p_decision <> 'approved' THEN
    UPDATE public.knowledge_releases
    SET status = CASE WHEN p_decision = 'rejected' THEN 'rejected' ELSE 'draft' END
    WHERE id = release_row.id;
  ELSE
    SELECT count(*) INTO approvals
    FROM public.knowledge_reviews
    WHERE tenant_id = p_tenant_id
      AND release_record_id = release_row.id
      AND decision = 'approved';
    UPDATE public.knowledge_releases
    SET status = CASE WHEN approvals = 3 THEN 'approved' ELSE 'reviewing' END
    WHERE id = release_row.id;
  END IF;
  RETURN created_id;
END
$$;

CREATE OR REPLACE FUNCTION huamei_attach_knowledge_index(
  p_tenant_id varchar,
  p_release_id varchar,
  p_index_checksum char(64),
  p_manifest jsonb,
  p_actor varchar
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  release_row public.knowledge_releases%ROWTYPE;
  review_row record;
BEGIN
  PERFORM public.huamei_assert_function_tenant(p_tenant_id);
  SELECT * INTO release_row
  FROM public.knowledge_releases
  WHERE tenant_id = p_tenant_id AND release_id = p_release_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge release not found' USING ERRCODE = 'P0002';
  END IF;
  IF release_row.status <> 'approved' OR release_row.is_active THEN
    RAISE EXCEPTION 'knowledge release has not completed three reviews'
      USING ERRCODE = '55000';
  END IF;
  IF p_index_checksum !~ '^[0-9a-f]{64}$'
     OR coalesce(p_manifest->>'manifest_sha256', '') IS DISTINCT FROM p_index_checksum
     OR coalesce(p_manifest->>'index_version', '') IS DISTINCT FROM release_row.index_version
     OR coalesce(p_manifest#>>'{release_binding,tenant_id}', '') IS DISTINCT FROM release_row.tenant_id
     OR coalesce(p_manifest#>>'{release_binding,release_id}', '') IS DISTINCT FROM release_row.release_id
     OR coalesce(p_manifest#>>'{release_binding,knowledge_package_sha256}', '') IS DISTINCT FROM release_row.package_checksum
     OR coalesce(p_manifest#>>'{release_binding,approved_record_list_sha256}', '') IS DISTINCT FROM release_row.record_list_checksum
     OR coalesce(p_manifest#>>'{release_binding,approval_receipt_sha256}', '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'GraphRAG manifest is not bound to the approved release'
      USING ERRCODE = '23514';
  END IF;
  FOR review_row IN
    SELECT id, review_type, reviewed_at
    FROM public.knowledge_reviews
    WHERE tenant_id = p_tenant_id
      AND release_record_id = release_row.id
      AND decision = 'approved'
  LOOP
    IF coalesce(p_manifest#>>ARRAY['release_binding','approvals',review_row.review_type,'review_id'], '')
         IS DISTINCT FROM review_row.id::text THEN
      RAISE EXCEPTION 'GraphRAG manifest review receipt mismatch'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  UPDATE public.knowledge_releases
  SET index_checksum = p_index_checksum,
      manifest = p_manifest || jsonb_build_object('index_attached_by', p_actor)
  WHERE id = release_row.id;
END
$$;

CREATE OR REPLACE FUNCTION huamei_validate_knowledge_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  approval_count integer;
  reviewer_count integer;
  expected_scope text;
  review_row record;
BEGIN
  IF NOT NEW.is_active THEN RETURN NEW; END IF;
  expected_scope := public.huamei_knowledge_review_scope_checksum(
    NEW.tenant_id, NEW.release_id, NEW.package_version,
    NEW.package_checksum, NEW.record_list_checksum, NEW.index_version
  );
  SELECT count(*), count(DISTINCT reviewer_id)
    INTO approval_count, reviewer_count
  FROM public.knowledge_reviews
  WHERE tenant_id = NEW.tenant_id
    AND release_record_id = NEW.id
    AND decision = 'approved'
    AND evidence->>'scope_checksum' = expected_scope;
  IF approval_count <> 3 OR reviewer_count <> 3 THEN
    RAISE EXCEPTION 'active release requires three distinct bound approvals'
      USING ERRCODE = '23514';
  END IF;
  FOR review_row IN
    SELECT id, review_type
    FROM public.knowledge_reviews
    WHERE tenant_id = NEW.tenant_id AND release_record_id = NEW.id
  LOOP
    IF coalesce(NEW.manifest#>>ARRAY['release_binding','approvals',review_row.review_type,'review_id'], '')
         IS DISTINCT FROM review_row.id::text THEN
      RAISE EXCEPTION 'active release manifest review receipt mismatch'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS knowledge_release_activation_guard ON knowledge_releases;
CREATE TRIGGER knowledge_release_activation_guard
BEFORE INSERT OR UPDATE OF is_active, status, manifest, package_checksum,
  record_list_checksum, index_checksum, index_version
ON knowledge_releases
FOR EACH ROW
WHEN (NEW.is_active)
EXECUTE FUNCTION huamei_validate_knowledge_activation();

CREATE OR REPLACE FUNCTION huamei_freeze_knowledge_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  release_status text;
BEGIN
  IF current_user = 'huamei_owner' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT status INTO release_status
  FROM public.knowledge_releases
  WHERE tenant_id = OLD.tenant_id AND id = OLD.release_record_id;
  IF release_status IN ('active', 'superseded') THEN
    RAISE EXCEPTION 'review evidence for a published release is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS knowledge_review_freeze_guard ON knowledge_reviews;
CREATE TRIGGER knowledge_review_freeze_guard
BEFORE UPDATE OR DELETE ON knowledge_reviews
FOR EACH ROW EXECUTE FUNCTION huamei_freeze_knowledge_review();

CREATE OR REPLACE FUNCTION huamei_activate_knowledge_release(
  p_tenant_id varchar,
  p_release_id varchar,
  p_actor varchar
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  release_row public.knowledge_releases%ROWTYPE;
BEGIN
  PERFORM public.huamei_assert_function_tenant(p_tenant_id);
  SELECT * INTO release_row
  FROM public.knowledge_releases
  WHERE tenant_id = p_tenant_id AND release_id = p_release_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge release not found' USING ERRCODE = 'P0002';
  END IF;
  IF release_row.status <> 'approved' OR release_row.index_checksum IS NULL THEN
    RAISE EXCEPTION 'knowledge release is not ready for activation'
      USING ERRCODE = '55000';
  END IF;
  UPDATE public.knowledge_releases
  SET status = 'superseded', is_active = false
  WHERE tenant_id = p_tenant_id AND is_active AND id <> release_row.id;
  UPDATE public.knowledge_releases
  SET status = 'active', is_active = true,
      activated_at = clock_timestamp(), published_at = clock_timestamp(),
      manifest = manifest || jsonb_build_object('activated_by', p_actor)
  WHERE id = release_row.id;
END
$$;

REVOKE INSERT, UPDATE, DELETE ON knowledge_releases, knowledge_reviews FROM huamei_runtime;
REVOKE ALL ON FUNCTION huamei_create_knowledge_release_draft(
  varchar, varchar, varchar, char, text[], char, varchar, jsonb,
  timestamptz, timestamptz, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION huamei_record_knowledge_review(
  varchar, varchar, varchar, varchar, varchar, varchar, text, jsonb, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION huamei_attach_knowledge_index(
  varchar, varchar, char, jsonb, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION huamei_activate_knowledge_release(varchar, varchar, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huamei_create_knowledge_release_draft(
  varchar, varchar, varchar, char, text[], char, varchar, jsonb,
  timestamptz, timestamptz, varchar
) TO huamei_runtime;
GRANT EXECUTE ON FUNCTION huamei_record_knowledge_review(
  varchar, varchar, varchar, varchar, varchar, varchar, text, jsonb, timestamptz
) TO huamei_runtime;
GRANT EXECUTE ON FUNCTION huamei_attach_knowledge_index(
  varchar, varchar, char, jsonb, varchar
) TO huamei_runtime;
GRANT EXECUTE ON FUNCTION huamei_activate_knowledge_release(varchar, varchar, varchar) TO huamei_runtime;

COMMIT;
