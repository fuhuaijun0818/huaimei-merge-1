const positiveInteger = (value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
};

const postgresError = (code, message, cause) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
};

const safeTarget = (connectionString) => {
  try {
    const parsed = new URL(connectionString);
    return `${parsed.hostname || "unknown"}:${parsed.port || "5432"}/${parsed.pathname.replace(/^\//, "") || "postgres"}`;
  } catch {
    return null;
  }
};

const safeFailure = (error, connectionString) => {
  const raw = String(error?.message || "PostgreSQL operation failed");
  return {
    code:String(error?.code || "POSTGRES_ERROR"),
    message:connectionString ? raw.split(connectionString).join("[redacted]") : raw
  };
};

const normalizeTenantContext = (value) => {
  const tenantId = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(tenantId)) {
    const error = new Error("A valid tenant id is required for tenant-scoped PostgreSQL access");
    error.code = "POSTGRES_TENANT_CONTEXT_REQUIRED";
    throw error;
  }
  return tenantId;
};

export function createPostgresClient(options = {}) {
  const env = options.env || process.env;
  const connectionString = String(
    options.connectionString
      ?? env.HUAMEI_DATABASE_URL
      ?? env.DATABASE_URL
      ?? ""
  ).trim();
  const poolFactory = options.poolFactory;
  const injectedPool = options.pool || null;
  const configured = Boolean(injectedPool || poolFactory || connectionString);
  const poolOptions = {
    connectionString,
    max:positiveInteger(options.max ?? env.HUAMEI_POSTGRES_POOL_MAX, 20, 1, 500),
    idleTimeoutMillis:positiveInteger(options.idleTimeoutMs ?? env.HUAMEI_POSTGRES_IDLE_TIMEOUT_MS, 30_000, 1_000),
    connectionTimeoutMillis:positiveInteger(options.connectTimeoutMs ?? env.HUAMEI_POSTGRES_CONNECT_TIMEOUT_MS, 5_000, 250),
    statement_timeout:positiveInteger(options.statementTimeoutMs ?? env.HUAMEI_POSTGRES_STATEMENT_TIMEOUT_MS, 15_000, 250),
    query_timeout:positiveInteger(options.queryTimeoutMs ?? env.HUAMEI_POSTGRES_QUERY_TIMEOUT_MS, 20_000, 250),
    lock_timeout:positiveInteger(options.lockTimeoutMs ?? env.HUAMEI_POSTGRES_LOCK_TIMEOUT_MS, 3_000, 100),
    idle_in_transaction_session_timeout:positiveInteger(
      options.idleInTransactionTimeoutMs ?? env.HUAMEI_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      15_000,
      1_000
    ),
    application_name:String(options.applicationName || env.HUAMEI_POSTGRES_APPLICATION_NAME || "huamei-ai-saas").slice(0, 63),
    ...(options.ssl === undefined ? {} : { ssl:options.ssl })
  };
  let poolPromise = injectedPool ? Promise.resolve(injectedPool) : null;
  let lastBackgroundError = null;
  let closed = false;

  const recordBackgroundError = (error) => {
    lastBackgroundError = {
      ...safeFailure(error, connectionString),
      observed_at:new Date().toISOString()
    };
    if (typeof options.onPoolError === "function") options.onPoolError(lastBackgroundError);
  };

  const loadPool = async () => {
    if (closed) throw postgresError("POSTGRES_CLIENT_CLOSED", "PostgreSQL client is closed");
    if (!configured) throw postgresError("POSTGRES_NOT_CONFIGURED", "HUAMEI_DATABASE_URL is required");
    if (!poolPromise) {
      poolPromise = Promise.resolve().then(async () => {
        if (poolFactory) return poolFactory(poolOptions);
        let module;
        try {
          module = await import("pg");
        } catch (cause) {
          throw postgresError("POSTGRES_DRIVER_UNAVAILABLE", "Install the pg package before enabling PostgreSQL", cause);
        }
        const Pool = module.Pool || module.default?.Pool;
        if (typeof Pool !== "function") throw postgresError("POSTGRES_DRIVER_INVALID", "The pg package does not export Pool");
        return new Pool(poolOptions);
      }).then((pool) => {
        if (!pool || typeof pool.query !== "function") {
          throw postgresError("POSTGRES_POOL_INVALID", "PostgreSQL pool must provide query()");
        }
        // node-postgres emits idle-client failures on Pool. Without a listener
        // they become uncaught process errors, so production adapters must
        // always consume and expose the latest failure to readiness/metrics.
        pool.on?.("error", recordBackgroundError);
        return pool;
      }).catch((error) => {
        poolPromise = null;
        throw error;
      });
    }
    return poolPromise;
  };

  const query = async (text, values = []) => (await loadPool()).query(text, values);

  const transaction = async (operation) => {
    if (typeof operation !== "function") throw new TypeError("transaction operation must be a function");
    const pool = await loadPool();
    if (typeof pool.connect !== "function") {
      throw postgresError("POSTGRES_TRANSACTIONS_UNSUPPORTED", "PostgreSQL pool must provide connect() for transactions");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release?.();
    }
  };

  const tenantTransaction = async (tenantId, operation) => {
    const tenant = normalizeTenantContext(tenantId);
    return transaction(async (client) => {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      return operation(client, tenant);
    });
  };

  const tenantQuery = async (tenantId, text, values = []) => tenantTransaction(
    tenantId,
    (client) => client.query(text, values)
  );

  const health = async () => {
    if (closed) return { ok:false, status:"closed", driver:"postgres", configured, target:safeTarget(connectionString) };
    if (!configured) return { ok:false, status:"unconfigured", driver:"postgres", configured:false, target:null };
    const startedAt = performance.now();
    try {
      await query("SELECT 1 AS ok");
      return {
        ok:true,
        status:"ok",
        driver:"postgres",
        configured:true,
        target:safeTarget(connectionString),
        latency_ms:Number((performance.now() - startedAt).toFixed(1)),
        ...(lastBackgroundError ? { last_background_error:lastBackgroundError } : {})
      };
    } catch (error) {
      return {
        ok:false,
        status:"error",
        driver:"postgres",
        configured:true,
        target:safeTarget(connectionString),
        latency_ms:Number((performance.now() - startedAt).toFixed(1)),
        error:safeFailure(error, connectionString),
        ...(lastBackgroundError ? { last_background_error:lastBackgroundError } : {})
      };
    }
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    if (!poolPromise) return;
    let pool;
    try { pool = await poolPromise; } catch { return; }
    if (typeof pool.end === "function") await pool.end();
    else if (typeof pool.close === "function") await pool.close();
  };

  return {
    driver:"postgres",
    configured,
    target:safeTarget(connectionString),
    query,
    transaction,
    tenantTransaction,
    tenantQuery,
    health,
    close,
    getPool:loadPool
  };
}

let defaultClient;

export function getPostgresClient(options = {}) {
  if (!defaultClient) defaultClient = createPostgresClient(options);
  return defaultClient;
}

export async function closePostgresClient() {
  if (!defaultClient) return;
  const current = defaultClient;
  defaultClient = undefined;
  await current.close();
}
