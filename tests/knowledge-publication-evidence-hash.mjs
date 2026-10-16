import assert from "node:assert/strict";

import { evidenceHash } from "../server/knowledge-publication.mjs";

// PostgreSQL jsonb normalizes object-key order. A signed evaluation report
// must retain the same integrity reference after that storage round trip.
const submitted = {
  policy_version:"evaluation-policy-v1",
  package_checksum:"a".repeat(64),
  production_metrics:{ answer_accuracy:{ value:0.95, evidence_ref:"local" } },
  execution_attestation:{ signer_id:"local-test", signed_at:"2026-10-14T00:00:00.000Z" }
};
const jsonbRoundTrip = {
  execution_attestation:{ signed_at:"2026-10-14T00:00:00.000Z", signer_id:"local-test" },
  production_metrics:{ answer_accuracy:{ evidence_ref:"local", value:0.95 } },
  package_checksum:"a".repeat(64),
  policy_version:"evaluation-policy-v1"
};

assert.equal(evidenceHash(submitted), evidenceHash(jsonbRoundTrip));
console.log("knowledge publication evaluation evidence hash is jsonb-order independent");
