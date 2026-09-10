import {
  appendAuditEvent, appendOutboxEvent, ensureTenant, jsonValue, postgres
} from "./postgres-helpers.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

const releaseFromRow = (row, reviews = []) => {
  const manifest = jsonValue(row.manifest, {});
  const reviewMap = Object.fromEntries(reviews.map((review) => [review.review_type, {
    id:review.id ? String(review.id) : null,
    reviewer:review.reviewer_id,
    decision:review.decision,
    reviewed_at:new Date(review.reviewed_at).toISOString(),
    comments:review.comments || null,
    evidence:jsonValue(review.evidence, {})
  }]));
  return {
    id:row.release_id,
    tenant_id:row.tenant_id,
    package_version:row.package_version,
    package_checksum:row.package_checksum,
    record_list_checksum:row.record_list_checksum,
    index_checksum:row.index_checksum || manifest.index_checksum || null,
    approved_record_ids:[...(row.approved_record_ids || [])],
    approved_record_count:(row.approved_record_ids || []).length,
    reviews:reviewMap,
    status:row.status,
    effective_at:row.effective_at || manifest.effective_at || row.activated_at || row.published_at || row.created_at,
    expires_at:row.expires_at || manifest.expires_at || null,
    activated_at:row.activated_at ? new Date(row.activated_at).toISOString() : null,
    activated_by:row.created_by,
    manifest,
    created_at:new Date(row.created_at).toISOString(),
    updated_at:new Date(row.updated_at).toISOString()
  };
};

export function createPostgresKnowledgeReleaseStore(options = {}) {
  const database = options.postgres || postgres();
  const byTenant = new Map();
  const initializedTenants = new Set();
  const refreshedAtByTenant = new Map();
  let refreshedAt = null;
  const refreshPromises = new Map();

  const refresh = async (tenantId) => {
    if (!tenantId) {
      const error = new Error("tenantId is required when refreshing knowledge releases");
      error.code = "POSTGRES_TENANT_CONTEXT_REQUIRED";
      throw error;
    }
    if (refreshPromises.has(tenantId)) return refreshPromises.get(tenantId);
    const promise = (async () => {
      const result = await database.tenantQuery(tenantId,
        `SELECT r.*,
          COALESCE(jsonb_agg(jsonb_build_object(
            'id',v.id,
            'review_type',v.review_type,
            'reviewer_id',v.reviewer_id,
            'decision',v.decision,
            'comments',v.comments,
            'evidence',v.evidence,
            'reviewed_at',v.reviewed_at
          )) FILTER (WHERE v.id IS NOT NULL),'[]'::jsonb) AS reviews
         FROM knowledge_releases r
         LEFT JOIN knowledge_reviews v
           ON v.tenant_id=r.tenant_id AND v.release_record_id=r.id
         WHERE r.tenant_id=$1
         GROUP BY r.id
         ORDER BY r.created_at DESC`,
        [tenantId]
      );
      const releases = [];
      for (const row of result.rows) {
        const release = releaseFromRow(row, jsonValue(row.reviews, []));
        releases.push(release);
      }
      byTenant.set(tenantId, releases);
      initializedTenants.add(tenantId);
      refreshedAt = new Date().toISOString();
      refreshedAtByTenant.set(tenantId, refreshedAt);
      return status(tenantId);
    })().finally(() => { refreshPromises.delete(tenantId); });
    refreshPromises.set(tenantId, promise);
    return promise;
  };

  const ensureFresh = async (tenantId, options = {}) => {
    if (!tenantId) {
      const error = new Error("tenantId is required when ensuring knowledge releases are fresh");
      error.code = "POSTGRES_TENANT_CONTEXT_REQUIRED";
      throw error;
    }
    const configuredTtl = Number(options.ttlMs);
    const ttlMs = Number.isFinite(configuredTtl) ? Math.max(0, configuredTtl) : 5_000;
    const configuredNow = Number(options.now);
    const now = Number.isFinite(configuredNow) ? configuredNow : Date.now();
    const tenantRefreshedAt = Date.parse(refreshedAtByTenant.get(tenantId) || "");
    const fresh = initializedTenants.has(tenantId)
      && Number.isFinite(tenantRefreshedAt)
      && now - tenantRefreshedAt >= 0
      && now - tenantRefreshedAt < ttlMs;
    if (options.force !== true && fresh) return status(tenantId);
    return refresh(tenantId);
  };

  const list = (tenantId) => clone(byTenant.get(tenantId) || []);

  const getReviewScope = async ({ tenantId, releaseId }) => {
    const result = await database.tenantQuery(tenantId,
      `SELECT release_id, package_version, package_checksum,
              record_list_checksum, index_version,
              huamei_knowledge_review_scope_checksum(
                tenant_id, release_id, package_version, package_checksum,
                record_list_checksum, index_version
              ) AS scope_checksum
       FROM knowledge_releases
       WHERE tenant_id=$1 AND release_id=$2`,
      [tenantId, releaseId]
    );
    if (!result.rows[0]) {
      const error = new Error("Knowledge release not found");
      error.code = "KNOWLEDGE_RELEASE_NOT_FOUND";
      throw error;
    }
    return clone(result.rows[0]);
  };

  const createDraft = async ({ release, actor }) => database.tenantTransaction(release.tenant_id, async (client) => {
    await ensureTenant(client, release.tenant_id);
    const result = await client.query(
      `SELECT huamei_create_knowledge_release_draft(
        $1,$2,$3,$4,$5::text[],$6,$7,$8::jsonb,$9,$10,$11
       ) AS id`,
      [release.tenant_id, release.id, release.package_version, release.package_checksum,
        release.approved_record_ids, release.record_list_checksum, release.index_version,
        JSON.stringify(release.manifest || {}), release.effective_at, release.expires_at || null, actor]
    );
    await appendAuditEvent(client, {
      tenantId:release.tenant_id,
      action:"knowledge.release.review_started",
      resourceType:"knowledge_release",
      resourceId:release.id,
      actorType:"human",
      actorId:actor,
      details:{
        package_version:release.package_version,
        package_checksum:release.package_checksum,
        record_list_checksum:release.record_list_checksum,
        index_version:release.index_version,
        approved_record_count:release.approved_record_ids.length
      }
    });
    await appendOutboxEvent(client, {
      tenantId:release.tenant_id,
      aggregateType:"knowledge_release",
      aggregateId:release.id,
      eventType:"knowledge.release.review_started",
      payload:{ release_id:release.id, index_version:release.index_version }
    });
    return result.rows[0].id;
  }).then(async () => {
    await refresh(release.tenant_id);
    return list(release.tenant_id).find((item) => item.id === release.id);
  });

  const submitReview = async ({ tenantId, releaseId, reviewType, decision, identity, comments, scopeChecksum }) => {
    const expectedRole = `knowledge.${reviewType}_reviewer`;
    if (!identity?.subject || !identity?.roles?.includes(expectedRole)) {
      const error = new Error("Reviewer identity does not have the required role");
      error.code = "KNOWLEDGE_REVIEW_ROLE_FORBIDDEN";
      throw error;
    }
    const reviewedAt = new Date().toISOString();
    const evidence = {
      scope_checksum:String(scopeChecksum || ""),
      identity_issuer:String(identity.issuer || ""),
      token_id:identity.tokenId || null,
      reviewer_role:expectedRole,
      authenticated_at:identity.authenticatedAt || reviewedAt
    };
    const reviewId = await database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `SELECT huamei_record_knowledge_review(
          $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9
         ) AS id`,
        [tenantId, releaseId, reviewType, identity.subject, expectedRole, decision,
          String(comments || "").slice(0, 2_000), JSON.stringify(evidence), reviewedAt]
      );
      await appendAuditEvent(client, {
        tenantId,
        eventId:`audit_knowledge_review_${result.rows[0].id}`,
        action:"knowledge.review.recorded",
        resourceType:"knowledge_release",
        resourceId:releaseId,
        actorType:"human",
        actorId:identity.subject,
        details:{ review_type:reviewType, decision, review_id:String(result.rows[0].id), scope_checksum:evidence.scope_checksum }
      });
      await appendOutboxEvent(client, {
        tenantId,
        eventId:`outbox_knowledge_review_${result.rows[0].id}`,
        aggregateType:"knowledge_release",
        aggregateId:releaseId,
        eventType:"knowledge.review.recorded",
        payload:{ release_id:releaseId, review_type:reviewType, decision, review_id:String(result.rows[0].id) }
      });
      return String(result.rows[0].id);
    });
    await refresh(tenantId);
    return { review_id:reviewId, release:list(tenantId).find((item) => item.id === releaseId) };
  };

  const releaseReceipt = async ({ tenantId, releaseId }) => {
    const result = await database.tenantQuery(tenantId,
      `SELECT r.*,
              v.id AS review_id, v.review_type, v.decision, v.reviewed_at
       FROM knowledge_releases r
       LEFT JOIN knowledge_reviews v
         ON v.tenant_id=r.tenant_id AND v.release_record_id=r.id
       WHERE r.tenant_id=$1 AND r.release_id=$2
       ORDER BY v.review_type`,
      [tenantId, releaseId]
    );
    if (!result.rows.length) {
      const error = new Error("Knowledge release not found");
      error.code = "KNOWLEDGE_RELEASE_NOT_FOUND";
      throw error;
    }
    const release = result.rows[0];
    const approvals = {};
    for (const row of result.rows) {
      if (!row.review_id) continue;
      approvals[row.review_type] = {
        status:row.decision,
        review_id:String(row.review_id),
        reviewed_at:new Date(row.reviewed_at).toISOString()
      };
    }
    return {
      schema_version:"huamei.knowledge.release-binding.v1",
      tenant_id:release.tenant_id,
      release_id:release.release_id,
      index_version:release.index_version,
      knowledge_package_sha256:release.package_checksum,
      approved_record_list_sha256:release.record_list_checksum,
      approvals
    };
  };

  const attachIndex = async ({ tenantId, releaseId, indexChecksum, manifest, actor }) => {
    await database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        "SELECT huamei_attach_knowledge_index($1,$2,$3,$4::jsonb,$5)",
        [tenantId, releaseId, indexChecksum, JSON.stringify(manifest), actor]
      );
      await appendAuditEvent(client, {
        tenantId,
        action:"knowledge.index.attached",
        resourceType:"knowledge_release",
        resourceId:releaseId,
        actorType:"human",
        actorId:actor,
        details:{ index_version:manifest.index_version, manifest_sha256:indexChecksum }
      });
    });
    await refresh(tenantId);
    return list(tenantId).find((item) => item.id === releaseId);
  };

  const activate = async ({ tenantId, releaseId, identity }) => {
    if (!identity?.subject || !identity?.roles?.includes("knowledge.publisher")) {
      const error = new Error("Publisher identity does not have the required role");
      error.code = "KNOWLEDGE_PUBLISH_ROLE_FORBIDDEN";
      throw error;
    }
    await database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        "SELECT huamei_activate_knowledge_release($1,$2,$3)",
        [tenantId, releaseId, identity.subject]
      );
      await appendAuditEvent(client, {
        tenantId,
        action:"knowledge.release.activated",
        resourceType:"knowledge_release",
        resourceId:releaseId,
        actorType:"human",
        actorId:identity.subject,
        details:{ oidc_issuer:identity.issuer, token_id:identity.tokenId || null }
      });
      await appendOutboxEvent(client, {
        tenantId,
        aggregateType:"knowledge_release",
        aggregateId:releaseId,
        eventType:"knowledge.release.activated",
        payload:{ release_id:releaseId }
      });
    });
    await refresh(tenantId);
    return list(tenantId).find((item) => item.id === releaseId);
  };

  const publish = async ({ release, reviews, actor }) => database.tenantTransaction(release.tenant_id, async (client) => {
    await ensureTenant(client, release.tenant_id);
    await client.query(
      `SELECT id FROM knowledge_releases WHERE tenant_id=$1 AND is_active FOR UPDATE`,
      [release.tenant_id]
    );
    await client.query(
      `UPDATE knowledge_releases
       SET status='superseded', is_active=false
       WHERE tenant_id=$1 AND is_active`,
      [release.tenant_id]
    );
    const inserted = await client.query(
      `INSERT INTO knowledge_releases
        (tenant_id, release_id, package_version, status, package_checksum,
         approved_record_ids, record_list_checksum, index_checksum, index_version,
         manifest, is_active, effective_at, expires_at, activated_at, published_at, created_by)
       VALUES ($1,$2,$3,'active',$4,$5::text[],$6,$7,$8,$9::jsonb,true,$10,$11,$12,$12,$13)
       RETURNING id`,
      [release.tenant_id, release.id, release.package_version, release.package_checksum,
        release.approved_record_ids, release.record_list_checksum || release.manifest.approved_record_list_sha256,
        release.manifest.index_checksum, release.manifest.index_version || null,
        JSON.stringify(release.manifest), release.effective_at, release.expires_at,
        release.activated_at, actor]
    );
    for (const [reviewType, review] of Object.entries(reviews)) {
      await client.query(
        `INSERT INTO knowledge_reviews
          (tenant_id, release_record_id, review_type, reviewer_id, decision,
           comments, evidence, reviewed_at)
         VALUES ($1,$2,$3,$4,'approved',$5,$6::jsonb,$7)`,
        [release.tenant_id, inserted.rows[0].id, reviewType, review.reviewer,
          review.comments || null, JSON.stringify(review.evidence || {}), review.reviewed_at]
      );
    }
    await appendAuditEvent(client, {
      tenantId:release.tenant_id,
      action:"knowledge.release.activated",
      resourceType:"knowledge_release",
      resourceId:release.id,
      actorType:"human",
      actorId:actor,
      details:{
        package_version:release.package_version,
        package_checksum:release.package_checksum,
        index_checksum:release.manifest.index_checksum,
        approved_record_count:release.approved_record_ids.length,
        reviewers:Object.fromEntries(Object.entries(reviews).map(([key, review]) => [key, review.reviewer]))
      }
    });
    await appendOutboxEvent(client, {
      tenantId:release.tenant_id,
      aggregateType:"knowledge_release",
      aggregateId:release.id,
      eventType:"knowledge.release.activated",
      payload:{
        release_id:release.id,
        package_version:release.package_version,
        package_checksum:release.package_checksum,
        index_checksum:release.manifest.index_checksum,
        approved_record_count:release.approved_record_ids.length
      }
    });
  }).then(async () => {
    await refresh(release.tenant_id);
    return list(release.tenant_id).find((item) => item.id === release.id) || clone(release);
  });

  const status = (tenantId = null) => ({
    driver:"postgres",
    durable:true,
    shared:true,
    initialized:tenantId ? initializedTenants.has(tenantId) : initializedTenants.size > 0,
    refreshed_at:tenantId ? refreshedAtByTenant.get(tenantId) || null : refreshedAt,
    tenants:byTenant.size,
    releases:tenantId
      ? (byTenant.get(tenantId) || []).length
      : [...byTenant.values()].reduce((sum, releases) => sum + releases.length, 0)
  });

  return {
    refresh,
    ensureFresh,
    list,
    publish,
    getReviewScope,
    createDraft,
    submitReview,
    releaseReceipt,
    attachIndex,
    activate,
    status
  };
}

let defaultStore;
export const getPostgresKnowledgeReleaseStore = () => {
  if (!defaultStore) defaultStore = createPostgresKnowledgeReleaseStore();
  return defaultStore;
};
