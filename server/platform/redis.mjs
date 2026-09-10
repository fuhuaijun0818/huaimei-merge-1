const positiveInteger = (value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
};

const redisError = (code, message, cause) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
};

const safeTarget = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname || "unknown"}:${parsed.port || (parsed.protocol === "rediss:" ? "6380" : "6379")}${parsed.pathname || "/0"}`;
  } catch {
    return null;
  }
};

const safeFailure = (error, url) => {
  const raw = String(error?.message || "Redis operation failed");
  return {
    code:String(error?.code || "REDIS_ERROR"),
    message:url ? raw.split(url).join("[redacted]") : raw
  };
};

const withTimeout = (operation, timeoutMs, code, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(redisError(code, message)), timeoutMs);
  Promise.resolve()
    .then(operation)
    .then(resolve, reject)
    .finally(() => clearTimeout(timer));
});

export function createRedisClient(options = {}) {
  const env = options.env || process.env;
  const url = String(options.url ?? env.HUAMEI_REDIS_URL ?? env.REDIS_URL ?? "").trim();
  const clientFactory = options.clientFactory;
  const injectedClient = options.client || null;
  const configured = Boolean(injectedClient || clientFactory || url);
  const connectTimeoutMs = positiveInteger(options.connectTimeoutMs ?? env.HUAMEI_REDIS_CONNECT_TIMEOUT_MS, 5_000, 250);
  const commandTimeoutMs = positiveInteger(options.commandTimeoutMs ?? env.HUAMEI_REDIS_COMMAND_TIMEOUT_MS, 3_000, 10);
  let clientPromise = injectedClient ? Promise.resolve(injectedClient) : null;
  let connectedByAdapter = Boolean(injectedClient?.isOpen || injectedClient?.isReady);
  let lastBackgroundError = null;
  let closed = false;

  const recordBackgroundError = (error) => {
    lastBackgroundError = {
      ...safeFailure(error, url),
      observed_at:new Date().toISOString()
    };
    if (typeof options.onClientError === "function") options.onClientError(lastBackgroundError);
  };

  const loadClient = async () => {
    if (closed) throw redisError("REDIS_CLIENT_CLOSED", "Redis client is closed");
    if (!configured) throw redisError("REDIS_NOT_CONFIGURED", "HUAMEI_REDIS_URL is required");
    if (!clientPromise) {
      clientPromise = Promise.resolve().then(async () => {
        if (clientFactory) return clientFactory({ url, connectTimeoutMs, commandTimeoutMs });
        let module;
        try {
          module = await import("redis");
        } catch (cause) {
          throw redisError("REDIS_DRIVER_UNAVAILABLE", "Install the redis package before enabling Redis", cause);
        }
        if (typeof module.createClient !== "function") throw redisError("REDIS_DRIVER_INVALID", "The redis package does not export createClient()");
        return module.createClient({
          url,
          socket:{
            connectTimeout:connectTimeoutMs,
            reconnectStrategy:(retries) => retries >= 8 ? false : Math.min(50 * (2 ** retries), 2_000)
          }
        });
      }).then((client) => {
        if (!client || (typeof client.sendCommand !== "function" && typeof client.ping !== "function")) {
          throw redisError("REDIS_CLIENT_INVALID", "Redis client must provide sendCommand() or ping()");
        }
        // node-redis requires an error listener. Keep the process alive and
        // surface the last background fault through health instead of losing it.
        client.on?.("error", recordBackgroundError);
        return client;
      }).catch((error) => {
        clientPromise = null;
        throw error;
      });
    }
    const client = await clientPromise;
    if (!connectedByAdapter && !client.isOpen && !client.isReady && typeof client.connect === "function") {
      await withTimeout(
        () => client.connect(),
        connectTimeoutMs,
        "REDIS_CONNECT_TIMEOUT",
        `Redis did not connect within ${connectTimeoutMs}ms`
      );
      connectedByAdapter = true;
    }
    return client;
  };

  const command = async (name, ...arguments_) => {
    const client = await loadClient();
    const commandParts = Array.isArray(name) ? name : [name, ...arguments_];
    const [commandName, ...commandArguments] = commandParts;
    const method = String(commandName || "").trim().toLowerCase();
    return withTimeout(() => {
      if (method && typeof client[method] === "function") return client[method](...commandArguments);
      if (typeof client.sendCommand === "function") {
        return client.sendCommand([String(commandName).toUpperCase(), ...commandArguments.map((value) => String(value))]);
      }
      throw redisError("REDIS_COMMAND_UNSUPPORTED", `Redis client does not support ${commandName}`);
    }, commandTimeoutMs, "REDIS_COMMAND_TIMEOUT", `Redis command exceeded ${commandTimeoutMs}ms`);
  };

  const health = async () => {
    if (closed) return { ok:false, status:"closed", driver:"redis", configured, target:safeTarget(url) };
    if (!configured) return { ok:false, status:"unconfigured", driver:"redis", configured:false, target:null };
    const startedAt = performance.now();
    try {
      const response = await command("ping");
      if (String(response).toUpperCase() !== "PONG") throw redisError("REDIS_UNEXPECTED_PING", "Redis did not return PONG");
      return {
        ok:true,
        status:"ok",
        driver:"redis",
        configured:true,
        target:safeTarget(url),
        latency_ms:Number((performance.now() - startedAt).toFixed(1)),
        ...(lastBackgroundError ? { last_background_error:lastBackgroundError } : {})
      };
    } catch (error) {
      return {
        ok:false,
        status:"error",
        driver:"redis",
        configured:true,
        target:safeTarget(url),
        latency_ms:Number((performance.now() - startedAt).toFixed(1)),
        error:safeFailure(error, url),
        ...(lastBackgroundError ? { last_background_error:lastBackgroundError } : {})
      };
    }
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    if (!clientPromise) return;
    let client;
    try { client = await clientPromise; } catch { return; }
    if (typeof client.quit === "function") {
      try { await client.quit(); } catch (error) {
        if (!/closed/i.test(String(error?.message || ""))) throw error;
      }
    } else if (typeof client.close === "function") await client.close();
    else if (typeof client.disconnect === "function") await client.disconnect();
  };

  return {
    driver:"redis",
    configured,
    target:safeTarget(url),
    command,
    get:(key) => command("get", key),
    set:(key, value, options_) => options_ === undefined ? command("set", key, value) : command("set", key, value, options_),
    del:(...keys) => command("del", ...keys),
    expire:(key, seconds) => command("expire", key, seconds),
    health,
    close,
    getClient:loadClient
  };
}

let defaultClient;

export function getRedisClient(options = {}) {
  if (!defaultClient) defaultClient = createRedisClient(options);
  return defaultClient;
}

export async function closeRedisClient() {
  if (!defaultClient) return;
  const current = defaultClient;
  defaultClient = undefined;
  await current.close();
}
