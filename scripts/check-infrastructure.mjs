import { createProductionReadiness } from "../server/platform/production-readiness.mjs";

const readiness = createProductionReadiness();

try {
  const configuration = readiness.validate({ production:true });
  const health = await readiness.health();
  const ready = configuration.ready
    && health.dependencies.postgres.ok
    && health.dependencies.redis.ok
    && health.dependencies.admin_identity_proxy.ok;
  console.log(JSON.stringify({
    status:ready ? "ready" : "not_ready",
    configuration:{
      ready:configuration.ready,
      backends:configuration.backends,
      errors:configuration.errors
    },
    dependencies:{
      postgres:health.dependencies.postgres,
      redis:health.dependencies.redis,
      admin_identity_proxy:health.dependencies.admin_identity_proxy
    }
  }, null, 2));
  if (!ready) process.exitCode = 1;
} finally {
  await readiness.close();
}
