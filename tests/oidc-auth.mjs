import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createOidcVerifier, readOidcConfig } from "../server/platform/oidc-auth.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength:2048 });
const jwk = publicKey.export({ format:"jwk" });
jwk.kid = "huamei-test-key";
jwk.alg = "RS256";
jwk.use = "sig";
const env = {
  NODE_ENV:"test",
  HUAMEI_OIDC_REQUIRED:"true",
  HUAMEI_OIDC_ISSUER:"https://identity.huamei.test",
  HUAMEI_OIDC_AUDIENCE:"huamei-acquisition",
  HUAMEI_OIDC_JWKS_URL:"https://identity.huamei.test/.well-known/jwks.json",
  HUAMEI_OIDC_ROLE_CLAIM:"roles",
  HUAMEI_OIDC_TENANT_CLAIM:"tenant_ids"
};
let jwksCalls = 0;
const verifier = createOidcVerifier({
  env,
  nowSeconds:() => 1_800_000_000,
  fetchImpl:async () => {
    jwksCalls += 1;
    return new Response(JSON.stringify({ keys:[jwk] }), { status:200, headers:{ "Content-Type":"application/json" } });
  }
});

const tokenFor = (overrides = {}) => {
  const header = Buffer.from(JSON.stringify({ alg:"RS256", typ:"JWT", kid:jwk.kid })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss:env.HUAMEI_OIDC_ISSUER,
    aud:env.HUAMEI_OIDC_AUDIENCE,
    sub:"reviewer-medical-001",
    exp:1_800_000_600,
    iat:1_800_000_000,
    jti:randomUUID(),
    roles:["knowledge.medical_reviewer"],
    tenant_ids:["huamei-shanghai"],
    ...overrides
  })).toString("base64url");
  const signature = sign("SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url");
  return `${header}.${claims}.${signature}`;
};

const identity = await verifier.verifyAuthorizationHeader(`Bearer ${tokenFor()}`, {
  requiredRoles:["knowledge.medical_reviewer"], tenantId:"huamei-shanghai"
});
assert.equal(identity.subject, "reviewer-medical-001");
assert.equal(jwksCalls, 1);
await verifier.verifyToken(tokenFor(), { requiredRoles:["knowledge.medical_reviewer"], tenantId:"huamei-shanghai" });
assert.equal(jwksCalls, 1, "JWKS should be cached");
const dualRoleIdentity = await verifier.verifyToken(tokenFor({ roles:["operations.agent", "contact:reveal"] }), {
  requiredAllRoles:["operations.agent", "contact:reveal"], tenantId:"huamei-shanghai"
});
assert.deepEqual(dualRoleIdentity.roles, ["operations.agent", "contact:reveal"]);
await assert.rejects(
  verifier.verifyToken(tokenFor({ roles:["operations.agent"] }), {
    requiredAllRoles:["operations.agent", "contact:reveal"], tenantId:"huamei-shanghai"
  }),
  (error) => error.code === "OIDC_ROLE_FORBIDDEN"
    && error.details?.[0]?.role === "contact:reveal"
);

await assert.rejects(
  verifier.verifyToken(tokenFor({ roles:["knowledge.business_reviewer"] }), {
    requiredRoles:["knowledge.medical_reviewer"], tenantId:"huamei-shanghai"
  }),
  (error) => error.code === "OIDC_ROLE_FORBIDDEN" && error.status === 403
);
await assert.rejects(
  verifier.verifyToken(tokenFor({ tenant_ids:["another-tenant"] }), {
    requiredRoles:["knowledge.medical_reviewer"], tenantId:"huamei-shanghai"
  }),
  (error) => error.code === "OIDC_TENANT_FORBIDDEN" && error.status === 403
);
await assert.rejects(
  verifier.verifyToken(tokenFor({ exp:1_799_999_000 }), {}),
  (error) => error.code === "OIDC_TOKEN_EXPIRED"
);
await assert.rejects(
  verifier.verifyToken(`${tokenFor().slice(0, -2)}aa`, {}),
  (error) => error.code === "OIDC_SIGNATURE_INVALID"
);

assert.throws(
  () => readOidcConfig({ NODE_ENV:"production" }),
  (error) => error.code === "OIDC_CONFIGURATION_REQUIRED" && error.status === 503
);
assert.throws(
  () => readOidcConfig({ ...env, NODE_ENV:"production", HUAMEI_OIDC_JWKS_URL:"http://identity.huamei.test/keys" }),
  (error) => error.code === "OIDC_CONFIGURATION_INSECURE"
);

console.log("✓ OIDC签名、受众、时效、角色、租户与JWKS缓存门禁通过");
