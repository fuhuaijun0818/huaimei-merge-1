const metricNamePattern = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const labelNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const nonNegative = (value, fallback = 0) => Math.max(0, finite(value, fallback));
const escapeHelp = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const escapeLabel = (value) => String(value ?? "")
  .replace(/\\/g, "\\\\")
  .replace(/\n/g, "\\n")
  .replace(/"/g, '\\"');

const validateMetricDefinition = (name, labels) => {
  if (!metricNamePattern.test(name)) throw new TypeError(`Invalid Prometheus metric name: ${name}`);
  if (!Array.isArray(labels) || labels.some((label) => !labelNamePattern.test(label))) {
    throw new TypeError(`Invalid labels for metric ${name}`);
  }
};

const labelEntry = (labelNames, labels = {}) => {
  const normalized = Object.fromEntries(labelNames.map((name) => [name, String(labels[name] ?? "unknown")]));
  const key = labelNames.map((name) => `${name}\u0000${normalized[name]}`).join("\u0001");
  return { key, labels:normalized };
};

const labelText = (labels, extra = {}) => {
  const entries = [...Object.entries(labels), ...Object.entries(extra)];
  if (!entries.length) return "";
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
};

class Metric {
  constructor(type, name, help, labels = []) {
    validateMetricDefinition(name, labels);
    this.type = type;
    this.name = name;
    this.help = String(help || name);
    this.labelNames = [...labels];
    this.values = new Map();
  }

  header() {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
  }
}

export class Counter extends Metric {
  constructor(name, help, labels = []) { super("counter", name, help, labels); }

  inc(labels = {}, value = 1) {
    const amount = finite(value, NaN);
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`Counter ${this.name} can only increase`);
    const entry = labelEntry(this.labelNames, labels);
    const current = this.values.get(entry.key) || { labels:entry.labels, value:0 };
    current.value += amount;
    this.values.set(entry.key, current);
    return current.value;
  }

  render() {
    return [...this.header(), ...[...this.values.values()]
      .sort((left, right) => JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)))
      .map((entry) => `${this.name}${labelText(entry.labels)} ${entry.value}`)];
  }
}

export class Gauge extends Metric {
  constructor(name, help, labels = []) { super("gauge", name, help, labels); }

  set(labels = {}, value = 0) {
    const amount = finite(value, NaN);
    if (!Number.isFinite(amount)) throw new TypeError(`Gauge ${this.name} requires a finite value`);
    const entry = labelEntry(this.labelNames, labels);
    this.values.set(entry.key, { labels:entry.labels, value:amount });
    return amount;
  }

  inc(labels = {}, value = 1) {
    const entry = labelEntry(this.labelNames, labels);
    return this.set(entry.labels, (this.values.get(entry.key)?.value || 0) + finite(value, 1));
  }

  dec(labels = {}, value = 1) { return this.inc(labels, -finite(value, 1)); }

  render() {
    return [...this.header(), ...[...this.values.values()]
      .sort((left, right) => JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)))
      .map((entry) => `${this.name}${labelText(entry.labels)} ${entry.value}`)];
  }
}

export class Histogram extends Metric {
  constructor(name, help, labels = [], buckets = []) {
    super("histogram", name, help, labels);
    const normalized = [...new Set(buckets.map(Number).filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
    if (!normalized.length) throw new TypeError(`Histogram ${name} requires positive buckets`);
    this.buckets = normalized;
  }

  observe(labels = {}, value = 0) {
    const amount = nonNegative(value, NaN);
    if (!Number.isFinite(amount)) throw new TypeError(`Histogram ${this.name} requires a finite value`);
    const label = labelEntry(this.labelNames, labels);
    const current = this.values.get(label.key) || {
      labels:label.labels,
      buckets:this.buckets.map(() => 0),
      count:0,
      sum:0
    };
    current.count += 1;
    current.sum += amount;
    this.buckets.forEach((upper, index) => { if (amount <= upper) current.buckets[index] += 1; });
    this.values.set(label.key, current);
    return amount;
  }

  render() {
    const lines = this.header();
    for (const entry of [...this.values.values()].sort((left, right) => JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)))) {
      this.buckets.forEach((upper, index) => {
        lines.push(`${this.name}_bucket${labelText(entry.labels, { le:String(upper) })} ${entry.buckets[index]}`);
      });
      lines.push(`${this.name}_bucket${labelText(entry.labels, { le:"+Inf" })} ${entry.count}`);
      lines.push(`${this.name}_sum${labelText(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${labelText(entry.labels)} ${entry.count}`);
    }
    return lines;
  }
}

export class PrometheusRegistry {
  constructor() {
    this.metrics = new Map();
    this.collectors = new Set();
  }

  register(metric) {
    if (!metric?.name || typeof metric.render !== "function") throw new TypeError("A renderable metric is required");
    if (this.metrics.has(metric.name)) throw new Error(`Metric already registered: ${metric.name}`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name, help, labels) { return this.register(new Counter(name, help, labels)); }
  gauge(name, help, labels) { return this.register(new Gauge(name, help, labels)); }
  histogram(name, help, labels, buckets) { return this.register(new Histogram(name, help, labels, buckets)); }

  addCollector(collector) {
    if (typeof collector !== "function") throw new TypeError("collector must be a function");
    this.collectors.add(collector);
    return () => this.collectors.delete(collector);
  }

  async render() {
    for (const collector of this.collectors) await collector();
    const lines = [];
    for (const metric of [...this.metrics.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      lines.push(...metric.render());
    }
    return `${lines.join("\n")}\n`;
  }
}

const identifier = (value, fallback = "unknown", maximum = 80) => {
  const normalized = String(value || "").trim().toLowerCase();
  const sensitive = /^1[3-9]\d{9}$/.test(normalized)
    || /^\d{17}[0-9x]$/.test(normalized)
    || /(?:secret|password|bearer|token|api[_-]?key|sk[-_])/i.test(normalized);
  return !sensitive && /^[a-z0-9][a-z0-9_.:-]*$/.test(normalized) ? normalized.slice(0, maximum) : fallback;
};

const oneOf = (value, allowed, fallback = "other") => allowed.includes(String(value || "").toLowerCase())
  ? String(value).toLowerCase()
  : fallback;

export function safeRouteLabel(value) {
  let path;
  try { path = new URL(String(value || "/"), "http://observability.invalid").pathname; }
  catch { return "__unmatched__"; }
  const staticSegments = new Set([
    "api", "v1", "v2", "health", "healthz", "ready", "readyz", "metrics", "openapi.json",
    "channels", "inbound", "conversations", "reply", "runs", "operations", "handovers", "tasks",
    "knowledge", "releases", "reviews", "admission", "publish", "activate", "indices", "customers",
    "search", "webhooks", "minimax", "video", "retrieve", "events", "outbox", "claim", "complete",
    "privacy", "requests", "transition", "execution", "prepare", "approve", "human-work", "contact-reveal", "receipt", "index"
  ]);
  const segments = path.split("/").filter(Boolean).slice(0, 12).map((segment) => {
    const decoded = (() => { try { return decodeURIComponent(segment); } catch { return ""; } })();
    if (!decoded || decoded.length > 40 || /@/.test(decoded) || /^\d{3,}$/.test(decoded)
      || /^[0-9a-f]{16,}$/i.test(decoded) || /^1[3-9]\d{9}$/.test(decoded)) return ":id";
    if (/^:[a-z][a-z0-9_]*$/i.test(decoded)) return decoded.toLowerCase();
    const normalized = decoded.toLowerCase();
    return staticSegments.has(normalized) ? normalized : ":value";
  });
  return segments.length ? `/${segments.join("/")}`.slice(0, 160) : "/";
}

const statusClass = (value) => {
  const status = Math.floor(finite(value, 0));
  return status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : "unknown";
};

const requestOutcome = (status, value) => {
  if (value) return oneOf(value, ["success", "client_error", "server_error", "aborted", "timeout"], "other");
  const group = statusClass(status);
  if (["1xx", "2xx", "3xx"].includes(group)) return "success";
  if (group === "4xx") return "client_error";
  if (group === "5xx") return "server_error";
  return "other";
};

const handoverReason = (value) => {
  const text = String(value || "").toLowerCase();
  if (/medical|safety|risk|symptom|diagnos|abnormal|医疗|不适|异常|用药/.test(text)) return "medical_safety";
  if (/complaint|dispute|投诉|纠纷|不满/.test(text)) return "complaint";
  if (/price|quote|discount|价格|报价|优惠/.test(text)) return "pricing_verification";
  if (/appoint|schedule|预约|排期/.test(text)) return "appointment";
  if (/human|user|request|人工|顾客要求/.test(text)) return "user_requested";
  return "other";
};

const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export function createHuameiMetrics(options = {}) {
  const registry = options.registry || new PrometheusRegistry();
  const service = identifier(options.service, "huamei-service");
  const version = identifier(options.version, "unknown", 40);
  const startedAt = Date.now();

  const buildInfo = registry.gauge("huamei_build_info", "Static service build information", ["service", "version"]);
  const uptime = registry.gauge("huamei_process_uptime_seconds", "Process uptime in seconds", ["service"]);
  const httpRequests = registry.counter("huamei_http_requests_total", "HTTP requests completed", ["service", "method", "route", "status_class", "outcome"]);
  const httpActive = registry.gauge("huamei_http_active_requests", "HTTP requests currently active", ["service"]);
  const httpDuration = registry.histogram("huamei_http_request_duration_seconds", "HTTP request duration in seconds", ["service", "method", "route"], durationBuckets);
  const modelRequests = registry.counter("huamei_model_requests_total", "Model calls completed", ["service", "provider", "model", "outcome"]);
  const modelDuration = registry.histogram("huamei_model_request_duration_seconds", "Model call duration in seconds", ["service", "provider", "model", "outcome"], durationBuckets);
  const modelTokens = registry.counter("huamei_model_tokens_total", "Model tokens reported by provider", ["service", "provider", "model", "direction"]);
  const graphRequests = registry.counter("huamei_graphrag_queries_total", "GraphRAG queries completed", ["service", "mode", "outcome"]);
  const graphDuration = registry.histogram("huamei_graphrag_query_duration_seconds", "GraphRAG query duration in seconds", ["service", "mode", "outcome"], durationBuckets);
  const graphCache = registry.counter("huamei_graphrag_cache_total", "GraphRAG cache results", ["service", "result"]);
  const formalLoadTaxonomy = registry.counter(
    "huamei_formal_load_taxonomy_total",
    "Controlled formal-load taxonomy entries applied or rejected",
    ["service", "outcome", "manifest_sha256", "signer_id"]
  );
  const handovers = registry.counter("huamei_handovers_total", "Human handover lifecycle events", ["service", "event", "reason"]);
  const outboxDeliveries = registry.counter("huamei_outbox_deliveries_total", "Outbox delivery outcomes", ["service", "outcome"]);
  const outboxBacklog = registry.gauge("huamei_outbox_events", "Current Outbox event counts", ["service", "state"]);
  const outboxOldest = registry.gauge("huamei_outbox_oldest_backlog_seconds", "Age of the oldest non-terminal Outbox event", ["service"]);
  const dependencyReady = registry.gauge("huamei_dependency_ready", "Dependency readiness state", ["service", "dependency"]);

  buildInfo.set({ service, version }, 1);
  registry.addCollector(() => uptime.set({ service }, (Date.now() - startedAt) / 1000));

  const startHttp = ({ method, route } = {}) => {
    const labels = {
      service,
      method:oneOf(method, ["get", "post", "put", "patch", "delete", "head", "options"], "other").toUpperCase(),
      route:safeRouteLabel(route)
    };
    const started = performance.now();
    let ended = false;
    httpActive.inc({ service });
    return ({ status = 0, outcome = "" } = {}) => {
      if (ended) return false;
      ended = true;
      httpActive.dec({ service });
      httpRequests.inc({ ...labels, status_class:statusClass(status), outcome:requestOutcome(status, outcome) });
      httpDuration.observe(labels, Math.max(0, performance.now() - started) / 1000);
      return true;
    };
  };

  const observeModel = ({ provider, model, outcome = "success", durationMs = 0, promptTokens = 0, completionTokens = 0 } = {}) => {
    const labels = {
      service,
      provider:identifier(provider, "unknown", 48),
      model:identifier(model, "unknown", 80),
      outcome:oneOf(outcome, ["success", "error", "timeout", "blocked", "fallback", "overloaded"], "other")
    };
    modelRequests.inc(labels);
    modelDuration.observe(labels, nonNegative(durationMs) / 1000);
    if (nonNegative(promptTokens) > 0) modelTokens.inc({ service, provider:labels.provider, model:labels.model, direction:"input" }, nonNegative(promptTokens));
    if (nonNegative(completionTokens) > 0) modelTokens.inc({ service, provider:labels.provider, model:labels.model, direction:"output" }, nonNegative(completionTokens));
  };

  const observeGraphRag = ({ mode = "local", outcome = "success", durationMs = 0, cacheHit = null } = {}) => {
    const labels = {
      service,
      mode:oneOf(mode, ["local", "global", "drift", "basic"], "other"),
      outcome:oneOf(outcome, ["success", "error", "timeout", "overloaded", "circuit_open", "binding_rejected", "fallback"], "other")
    };
    graphRequests.inc(labels);
    graphDuration.observe(labels, nonNegative(durationMs) / 1000);
    if (cacheHit !== null) graphCache.inc({ service, result:cacheHit ? "hit" : "miss" });
  };

  const recordHandover = ({ event = "requested", reason = "other", count = 1 } = {}) => handovers.inc({
    service,
    event:oneOf(event, ["requested", "claimed", "completed", "sla_breached", "cancelled"], "other"),
    reason:handoverReason(reason)
  }, nonNegative(count));

  const recordFormalLoadTaxonomy = ({ outcome = "rejected", manifestSha256 = "", signerId = "unknown", count = 1 } = {}) => formalLoadTaxonomy.inc({
    service,
    outcome:oneOf(outcome, ["applied", "rejected"], "rejected"),
    manifest_sha256:/^[a-f0-9]{64}$/.test(String(manifestSha256 || "").toLowerCase())
      ? String(manifestSha256).toLowerCase()
      : "unbound",
    signer_id:identifier(signerId, "unknown", 80)
  }, nonNegative(count));

  const recordOutboxDelivery = ({ outcome = "published", count = 1 } = {}) => outboxDeliveries.inc({
    service,
    outcome:oneOf(outcome, ["claimed", "published", "retry", "dead_letter", "lease_lost", "failed"], "other")
  }, nonNegative(count));

  const setOutboxSnapshot = (snapshot = {}) => {
    const values = {
      pending:snapshot.pending,
      retry:snapshot.retry,
      processing:snapshot.processing,
      ready:snapshot.ready,
      dead_letter:snapshot.deadLetter ?? snapshot.dead_letter,
      expired_lease:snapshot.expiredLeases ?? snapshot.expired_leases,
      backlog:snapshot.backlog
    };
    for (const [state, value] of Object.entries(values)) outboxBacklog.set({ service, state }, nonNegative(value));
    outboxOldest.set({ service }, nonNegative(snapshot.oldestBacklogSeconds ?? snapshot.oldest_backlog_seconds));
  };

  const setDependencyReady = (dependency, ready) => dependencyReady.set({
    service,
    dependency:identifier(dependency, "unknown", 48)
  }, ready ? 1 : 0);

  return {
    service,
    version,
    registry,
    startHttp,
    observeModel,
    observeGraphRag,
    recordFormalLoadTaxonomy,
    recordHandover,
    recordOutboxDelivery,
    setOutboxSnapshot,
    setDependencyReady,
    render:() => registry.render()
  };
}
