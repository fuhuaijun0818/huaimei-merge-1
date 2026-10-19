const clampInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
};

const gateError = (code, message, details = {}) => {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
};

const LANE_PRIORITY = Object.freeze({
  medical:0,
  structured:1,
  planning:1,
  generation:1,
  review:2,
  understanding:1,
  knowledge:2,
  default:2
});
const FAST_LANES = new Set(["medical", "structured"]);

/**
 * Process-local admission gate with bounded FIFO queues per priority lane.
 * It is deliberately framework-free so both the HTTP service and model client
 * can use the same accounting and fail-closed semantics.
 */
export function createConcurrencyGate({
  name = "gate",
  maxConcurrent = 24,
  maxQueue = 100,
  fastQueueReserve = 20,
  queueTimeoutMs = 8_000,
  failureThreshold = 0,
  openMs = 15_000,
  now = () => Date.now()
} = {}) {
  const limit = clampInteger(maxConcurrent, 24, 1, 10_000);
  const queueLimit = clampInteger(maxQueue, 100, 0, 100_000);
  const fastQueueLimit = queueLimit + clampInteger(fastQueueReserve, 20, 0, 10_000);
  const timeoutMs = clampInteger(queueTimeoutMs, 8_000, 1, 120_000);
  const threshold = clampInteger(failureThreshold, 0, 0, 10_000);
  const circuitMs = clampInteger(openMs, 15_000, 1, 600_000);
  let active = 0;
  let sequence = 0;
  let failures = 0;
  let openUntil = 0;
  let accepted = 0;
  let completed = 0;
  let rejected = 0;
  let timedOut = 0;
  const queue = [];

  const circuitOpen = () => openUntil > now();
  const stats = () => ({
    name,
    max_concurrent:limit,
    max_queue:queueLimit,
    fast_queue_reserve:fastQueueLimit - queueLimit,
    queue_timeout_ms:timeoutMs,
    active,
    queued:queue.length,
    accepted,
    completed,
    rejected,
    timed_out:timedOut,
    consecutive_failures:failures,
    circuit:circuitOpen() ? "open" : "closed",
    circuit_open_until:circuitOpen() ? new Date(openUntil).toISOString() : null
  });

  const releaseSlot = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      completed += 1;
      drain();
    };
  };

  const pickNext = () => {
    let selected = 0;
    for (let index = 1; index < queue.length; index += 1) {
      const current = queue[index];
      const best = queue[selected];
      const currentPriority = LANE_PRIORITY[current.lane] ?? LANE_PRIORITY.default;
      const bestPriority = LANE_PRIORITY[best.lane] ?? LANE_PRIORITY.default;
      if (currentPriority < bestPriority
        || (currentPriority === bestPriority && current.sequence < best.sequence)) {
        selected = index;
      }
    }
    return queue.splice(selected, 1)[0];
  };

  function drain() {
    while (active < limit && queue.length) {
      const entry = pickNext();
      clearTimeout(entry.timer);
      active += 1;
      entry.resolve(releaseSlot());
    }
  }

  const rejectQueued = (code, message) => {
    for (const entry of queue.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(gateError(code, message, { retryable:true }));
    }
  };

  const acquire = ({ lane = "default", timeoutMs:requestTimeoutMs } = {}) => {
    if (circuitOpen()) {
      rejected += 1;
      return Promise.reject(gateError("CIRCUIT_OPEN", `${name} circuit is open`, {
        retryable:true,
        retry_after_seconds:Math.max(1, Math.ceil((openUntil - now()) / 1000))
      }));
    }
    if (active < limit && queue.length === 0) {
      active += 1;
      accepted += 1;
      return Promise.resolve(releaseSlot());
    }
    const laneLimit = FAST_LANES.has(lane) ? fastQueueLimit : queueLimit;
    if (queue.length >= laneLimit) {
      rejected += 1;
      return Promise.reject(gateError("QUEUE_FULL", `${name} queue is full`, {
        retryable:true,
        retry_after_seconds:2
      }));
    }
    const waitMs = clampInteger(requestTimeoutMs, timeoutMs, 1, 120_000);
    return new Promise((resolve, reject) => {
      const entry = {
        lane,
        sequence:sequence++,
        resolve,
        reject,
        timer:null
      };
      entry.timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        timedOut += 1;
        reject(gateError("QUEUE_TIMEOUT", `${name} queue wait exceeded ${waitMs}ms`, {
          retryable:true,
          retry_after_seconds:2
        }));
      }, waitMs);
      queue.push(entry);
      accepted += 1;
      drain();
    });
  };

  const recordSuccess = () => {
    failures = 0;
    openUntil = 0;
  };

  const recordFailure = () => {
    failures += 1;
    if (threshold > 0 && failures >= threshold) {
      openUntil = now() + circuitMs;
      rejectQueued("CIRCUIT_OPEN", `${name} circuit opened after ${failures} failures`);
    }
  };

  return {
    acquire,
    recordSuccess,
    recordFailure,
    stats,
    circuitOpen
  };
}

export const readGateConfig = (env = process.env, prefix = "HUAMEI_TURN") => ({
  maxConcurrent:clampInteger(env[`${prefix}_MAX_CONCURRENT`], 24, 1, 10_000),
  maxQueue:clampInteger(env[`${prefix}_MAX_QUEUE`], 100, 0, 100_000),
  queueTimeoutMs:clampInteger(env[`${prefix}_QUEUE_TIMEOUT_MS`], 8_000, 1, 120_000)
});
