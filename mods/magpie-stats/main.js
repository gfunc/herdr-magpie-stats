import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { home, appHome, readTextFile, writeTextFile, theme } from "herdr";

const REFRESH_MS = 30_000;
const CHART_LIMIT = 30;
const AGENT_LIMIT = 2;
const MODEL_LIMIT = 3;

// The watch list is shared by every docked copy through one file under the
// app home, written with compare-and-swap. The default instance is derived,
// never stored.
const REGISTRY_PATH = () => `${appHome()}/magpie-stats-instances.json`;
const SELECTED_INSTANCE_KEY = "selectedInstanceId";
const REGISTRY_ATTEMPTS = 4;

const PERIODS = /** @type {const} */ ([
  { id: "today", label: "Today" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
  { id: "all", label: "All" },
]);

/** @typedef {(typeof PERIODS)[number]["id"]} Period */
/** @typedef {"not-running" | "unreachable" | "unsafe-address" | "bad-response"} ProblemKind */
/** @typedef {{kind: ProblemKind, detail: string}} Problem */

/** @typedef {"default" | `i-${string}`} InstanceId */
/** @typedef {{id: InstanceId, name: string, addressFile: string}} GatewayInstance */
/** @typedef {{additional: GatewayInstance[]}} InstanceRegistry */
/** @typedef {{kind: "add", instance: GatewayInstance} | {kind: "remove", id: InstanceId}} RegistryChange */
/** @typedef {"bad-registry" | "registry-io" | "invalid-instance"} RegistryProblemKind */
/** @typedef {{kind: RegistryProblemKind, detail: string}} RegistryProblem */
/** @typedef {{states: Map<Period, PeriodState>, inFlight: Set<Period>}} InstanceRuntime */

/**
 * @typedef {{
 *   calls: number, errors: number, cost: number, unpriced: number,
 *   input: number, output: number,
 *   cacheRead: number, cacheWrite: number, reasoning: number
 * }} Totals
 */

/**
 * `share` is null only when the whole period has no input or output tokens.
 * @typedef {{
 *   id: string, name: string, detail: string,
 *   calls: number, errors: number, cost: number,
 *   tokens: number, share: number | null
 * }} Share
 */

/** @typedef {{totalCount: number, rows: Share[]}} ShareList */

/**
 * @typedef {{
 *   bucket: "hour" | "day" | "week", truncated: boolean,
 *   bars: Array<{key: string, label: string,
 *                calls: number, errors: number, cost: number}>
 * }} Chart
 */

/**
 * @typedef {{
 *   period: Period, receivedAt: number, totals: Totals,
 *   chart: Chart, agents: ShareList, models: ShareList
 * }} UsageSnapshot
 */

/**
 * @typedef {{kind: "loading"}
 *   | {kind: "ready", snapshot: UsageSnapshot}
 *   | {kind: "stale", snapshot: UsageSnapshot, problem: Problem}
 *   | {kind: "unavailable", problem: Problem}} PeriodState
 */

/** Return `totals.input + totals.output`. @param {Totals} totals */
function nonCacheTokens(totals) {
  return totals.input + totals.output;
}

function bad(kind, detail) {
  return { kind, detail };
}

/**
 * Expand a leading `~` to the user's home directory; other paths pass
 * through unchanged. Pure given home().
 *
 * @param {string} path
 * @returns {string}
 */
function expandTilde(path) {
  if (path === "~") return home();
  if (path.startsWith("~/")) return `${home()}/${path.slice(2)}`;
  return path;
}

/**
 * The derived default instance. Never stored in the registry file.
 *
 * @returns {GatewayInstance}
 */
function defaultInstance() {
  return { id: "default", name: "Magpie", addressFile: `${home()}/.config/magpie/gateway.json` };
}

/**
 * A fresh additional-instance id: time and randomness, both base 36.
 *
 * @returns {string}
 */
function newInstanceId() {
  return `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Validate raw registry JSON. A null or absent file is an empty watch list;
 * junk never clamps into an entry — every problem throws "bad-registry".
 * Names and ids are unique (names case-folded); no entry may claim the
 * default id; address files must be absolute and inside the user's home
 * after `~` expansion.
 *
 * @param {string | null} text
 * @returns {InstanceRegistry}
 */
function parseRegistry(text) {
  if (text === null) return { additional: [] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad("bad-registry", "the gateway list file is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw bad("bad-registry", "the gateway list file has an unexpected shape");
  }
  if (parsed.version !== 1) throw bad("bad-registry", `unknown gateway list version ${String(parsed.version)}`);
  if (!Array.isArray(parsed.instances)) throw bad("bad-registry", "the gateway list has no instances array");
  const additional = [];
  const ids = new Set();
  const names = new Set();
  for (const entry of parsed.instances) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw bad("bad-registry", "a gateway list entry is not an object");
    }
    const { id, name, addressFile } = entry;
    if (typeof id !== "string" || !id.startsWith("i-")) {
      throw bad("bad-registry", `a gateway list entry has an invalid id "${String(id)}"`);
    }
    if (id === "default" || ids.has(id)) throw bad("bad-registry", `duplicate gateway id "${id}"`);
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed.length < 1 || trimmed.length > 24) {
      throw bad("bad-registry", `gateway "${name}" needs a name of 1 to 24 characters`);
    }
    const folded = trimmed.toLowerCase();
    if (names.has(folded)) throw bad("bad-registry", `two gateways are named "${trimmed}"`);
    if (typeof addressFile !== "string" || addressFile === "") {
      throw bad("bad-registry", `gateway "${trimmed}" has no address file`);
    }
    const absolute = expandTilde(addressFile);
    if (!isAbsolutePath(absolute)) {
      throw bad("bad-registry", `gateway "${trimmed}" has a relative address file`);
    }
    if (!isUnderHome(absolute)) {
      throw bad("bad-registry", `gateway "${trimmed}" has an address file outside your home`);
    }
    ids.add(id);
    names.add(folded);
    additional.push({ id, name: trimmed, addressFile: absolute });
  }
  return { additional };
}

/**
 * Validate an add-form draft. Throws "invalid-instance" naming the field.
 *
 * @param {string} name
 * @param {string} addressFile
 * @returns {GatewayInstance}
 */
function parseInstanceDraft(name, addressFile) {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 24) {
    throw bad("invalid-instance", "name: give it a name of 1 to 24 characters");
  }
  const raw = addressFile.trim();
  if (raw === "") throw bad("invalid-instance", "address file: give the path to its gateway.json");
  const absolute = expandTilde(raw);
  if (!isAbsolutePath(absolute)) {
    throw bad("invalid-instance", "address file: give an absolute path, such as ~/.config/magpie/gateway-2.json");
  }
  if (!isUnderHome(absolute)) {
    throw bad("invalid-instance", "address file: it must live inside your home directory");
  }
  return { id: newInstanceId(), name: trimmed, addressFile: absolute };
}

/**
 * Apply one change to a registry, purely. Adding a record already present
 * verbatim, or removing an absent id, returns the same registry object; a
 * used id or a case-folded duplicate name throws "invalid-instance".
 *
 * @param {InstanceRegistry} registry
 * @param {RegistryChange} change
 * @returns {InstanceRegistry}
 */
function applyRegistryChange(registry, change) {
  if (change.kind === "remove") {
    if (change.id === "default") return registry;
    if (!registry.additional.some((entry) => entry.id === change.id)) return registry;
    return { additional: registry.additional.filter((entry) => entry.id !== change.id) };
  }
  const { instance } = change;
  if (registry.additional.some((entry) =>
    entry.id === instance.id && entry.name === instance.name && entry.addressFile === instance.addressFile)) {
    return registry;
  }
  if (registry.additional.some((entry) => entry.id === instance.id)) {
    throw bad("invalid-instance", `id "${instance.id}" is already in the gateway list`);
  }
  if (registry.additional.some((entry) => entry.name.toLowerCase() === instance.name.toLowerCase())) {
    throw bad("invalid-instance", `a gateway named "${instance.name}" already exists`);
  }
  return { additional: [...registry.additional, instance] };
}

/** @param {string} path */
function isAbsolutePath(path) {
  return path.startsWith("/");
}

/** @param {string} path */
function isUnderHome(path) {
  return path === home() || path.startsWith(`${home()}/`);
}

/**
 * Read the registry file. A missing file is an empty registry; read errors
 * become "registry-io".
 *
 * @returns {Promise<{raw: string | null, registry: InstanceRegistry}>}
 */
async function readRegistry() {
  let raw;
  try {
    raw = await readTextFile(REGISTRY_PATH());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw bad("registry-io", `cannot read the gateway list (${message})`);
  }
  return { raw, registry: parseRegistry(raw) };
}

/**
 * The sole registry writer: read, apply, write with compare-and-swap. A
 * stale snapshot rejects and the loop re-reads and re-applies; an apply
 * that changes nothing writes nothing.
 *
 * @param {RegistryChange} change
 * @returns {Promise<InstanceRegistry>}
 */
async function updateRegistry(change) {
  let failure = null;
  for (let attempt = 0; attempt < REGISTRY_ATTEMPTS; attempt++) {
    const { raw, registry } = await readRegistry();
    const next = applyRegistryChange(registry, change);
    if (next === registry) return registry;
    const nextRaw = JSON.stringify({ version: 1, instances: next.additional }, null, 2);
    try {
      await writeTextFile(REGISTRY_PATH(), nextRaw, raw);
      return next;
    } catch (e) {
      failure = e;
      // Someone else wrote first; re-read and re-apply on the next attempt.
    }
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  throw bad("registry-io", `couldn't save the gateway list (${message})`);
}

/**
 * Preserve a known RegistryProblem kind and a short detail. Registry trouble
 * never becomes a gateway Problem kind.
 *
 * @param {unknown} error
 * @returns {RegistryProblem}
 */
function asRegistryProblem(error) {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = /** @type {any} */ (error).kind;
    if (kind === "bad-registry" || kind === "registry-io" || kind === "invalid-instance") {
      return { kind, detail: String(/** @type {any} */ (error).detail ?? "") };
    }
  }
  const reason = error instanceof Error ? error.message : String(error);
  return bad("registry-io", reason);
}

/**
 * Parse gateway.json text and return an origin such as http://127.0.0.1:3425.
 * Accept only 127.0.0.1:port or [::1]:port, with a numeric port from 1 to
 * 65535. Reject JSON with another shape, hosts that need DNS, credentials,
 * paths, schemes, and missing or out-of-range ports. There is no port 3425
 * fallback. Throws a Problem-shaped error with kind "unsafe-address" on bad
 * content. Pure; no file I/O.
 *
 * @param {string} text
 * @returns {string}
 */
function gatewayOrigin(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad("unsafe-address", "gateway.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw bad("unsafe-address", "gateway.json has an unexpected shape");
  }
  const addr = parsed.addr;
  if (typeof addr !== "string" || !addr) {
    throw bad("unsafe-address", "gateway.json has no addr");
  }
  const hostport = /^\[([^\]]+)\](?::(\d+))?$/.exec(addr) ?? /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(addr);
  if (!hostport) throw bad("unsafe-address", `addr "${addr}" has no port`);
  const host = hostport[1], portText = hostport[2];
  if (!/^\d+$/.test(portText)) throw bad("unsafe-address", `addr "${addr}" has a non-numeric port`);
  const port = Number(portText);
  if (port < 1 || port > 65535) throw bad("unsafe-address", `addr "${addr}" has an out-of-range port`);
  if (host !== "127.0.0.1" && host !== "::1") {
    throw bad("unsafe-address", `addr "${addr}" is not a loopback address`);
  }
  return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

/**
 * Read and validate one period of one instance at the system boundary.
 * See the checks in order below; the instance's address file is re-read
 * every call so a gateway restart on a new port needs no mod restart.
 *
 * @param {GatewayInstance} instance
 * @param {Period} period
 * @returns {Promise<UsageSnapshot>}
 */
async function loadUsage(instance, period) {
  let text;
  try {
    text = await readTextFile(instance.addressFile);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw bad("unreachable", `cannot read the gateway address file (${message})`);
  }
  if (text === null) throw bad("not-running", "the gateway address file is absent");
  const origin = gatewayOrigin(text);
  const url = `${origin}/v1/magpie/usage?period=${period}`;
  const response = await fetch(url);
  if (!response.ok || response.url !== url) {
    // Redirects are followed transparently, so response.url is the only redirect check.
    throw bad("bad-response", `HTTP ${response.status}`);
  }
  return parseUsage(await response.json(), period, Date.now());
}

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function badResponse(detail) {
  return bad("bad-response", detail);
}

/**
 * Validate raw JSON and convert it to the domain model. Missing or malformed
 * required data throws "bad-response"; junk is never clamped into zero. Every
 * field not named in UsageSnapshot is ignored here and nowhere else.
 *
 * @param {unknown} raw
 * @param {Period} period
 * @param {number} receivedAt
 * @returns {UsageSnapshot}
 */
function parseUsage(raw, period, receivedAt) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw badResponse("payload is not an object");
  const obj = /** @type {Record<string, unknown>} */ (raw);
  if (obj.period !== period) throw badResponse(`payload period "${String(obj.period)}" does not match "${period}"`);
  const bucket = obj.bucket;
  if (bucket !== "hour" && bucket !== "day" && bucket !== "week") throw badResponse(`unknown bucket "${String(bucket)}"`);
  const numbers = ["calls", "errors", "cost", "unpriced", "input", "output", "cache_read", "cache_write", "reasoning"];
  for (const name of numbers) {
    if (!finiteNonnegative(obj[name])) throw badResponse(`field "${name}" is missing or not a finite nonnegative number`);
  }
  if (!Array.isArray(obj.series)) throw badResponse("series is not an array");
  if (!Array.isArray(obj.agents)) throw badResponse("agents is not an array");
  if (!Array.isArray(obj.models)) throw badResponse("models is not an array");

  const totals = {
    calls: obj.calls, errors: obj.errors, cost: obj.cost, unpriced: obj.unpriced,
    input: obj.input, output: obj.output,
    cacheRead: obj.cache_read, cacheWrite: obj.cache_write, reasoning: obj.reasoning,
  };
  const periodTokens = nonCacheTokens(totals);

  const bars = obj.series.slice(-CHART_LIMIT).map((point, i, kept) => {
    if (typeof point !== "object" || point === null) throw badResponse("a series point is not an object");
    const p = /** @type {Record<string, unknown>} */ (point);
    for (const name of ["calls", "errors", "cost"]) {
      if (!finiteNonnegative(p[name])) throw badResponse(`a series point's "${name}" is missing or invalid`);
    }
    if (typeof p.label !== "string" || typeof p.time !== "string") throw badResponse("a series point has no label or time");
    // The kept array's own indices keep keys unique after slicing; the point's
    // time makes them stable across refreshes whose windows shift.
    return { key: `${p.time}:${i}`, label: p.label, calls: p.calls, errors: p.errors, cost: p.cost };
  });
  const chart = { bucket, truncated: obj.series.length > bars.length, bars };

  const agents = obj.agents.map((entry) => parseShare(entry, periodTokens, { name: ["name", "id"], detail: [] }));
  const models = obj.models.map((entry) => parseShare(entry, periodTokens, { name: ["name", "model", "id"], detail: ["sub", "provider"] }));
  return {
    period, receivedAt, totals, chart,
    agents: { totalCount: agents.length, rows: agents.slice(0, AGENT_LIMIT) },
    models: { totalCount: models.length, rows: models.slice(0, MODEL_LIMIT) },
  };
}

/**
 * Validate one agent or model. tokens is input + output. share is tokens
 * divided by the period's input + output, or null when that denominator is
 * zero. The server's order is preserved instead of sorting again.
 *
 * @param {unknown} raw
 * @param {number} periodTokens
 * @param {{name: string[], detail: string[]}} fallbacks
 * @returns {Share}
 */
function parseShare(raw, periodTokens, fallbacks) {
  if (typeof raw !== "object" || raw === null) throw badResponse("a share entry is not an object");
  const obj = /** @type {Record<string, unknown>} */ (raw);
  for (const name of ["calls", "errors", "cost", "input", "output"]) {
    if (!finiteNonnegative(obj[name])) throw badResponse(`a share entry's "${name}" is missing or invalid`);
  }
  const pick = (names, what) => {
    for (const name of names) {
      const value = obj[name];
      if (typeof value === "string" && value) return value;
    }
    throw badResponse(`a share entry has no ${what}`);
  };
  const id = pick(["id"], "id");
  return {
    id,
    name: pick(fallbacks.name, "name"),
    detail: fallbacks.detail.map((name) => (typeof obj[name] === "string" ? /** @type {string} */ (obj[name]) : "")).find((value) => value !== "") ?? "",
    calls: obj.calls, errors: obj.errors, cost: obj.cost,
    tokens: obj.input + obj.output,
    share: periodTokens > 0 ? (obj.input + obj.output) / periodTokens : null,
  };
}

/**
 * Preserve a known Problem kind and a short detail. An ordinary fetch rejection
 * becomes "unreachable". Never includes a response body, stack, or payload.
 * The only unknown-error conversion.
 *
 * @param {unknown} error
 * @returns {Problem}
 */
function asProblem(error) {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = /** @type {any} */ (error).kind;
    if (kind === "not-running" || kind === "unreachable" || kind === "unsafe-address" || kind === "bad-response") {
      return { kind, detail: String(/** @type {any} */ (error).detail ?? "") };
    }
  }
  const reason = error instanceof Error ? error.message : String(error);
  return bad("unreachable", reason);
}

/**
 * Return {title, body} for an empty panel, or a short stale-tooltip sentence.
 * Raw error details stay out of the normal panel copy.
 *
 * @param {Problem} problem
 * @returns {{title: string, body: string}}
 */
function problemCopy(problem) {
  switch (problem.kind) {
    case "not-running":
      return { title: "Magpie isn't running", body: "Start the local gateway to see usage. Retrying every 30 seconds." };
    case "unreachable":
      return { title: "Magpie isn't answering", body: "Retrying every 30 seconds." };
    case "unsafe-address":
      return { title: "Magpie usage is unavailable", body: "The gateway address file is not a local address." };
    case "bad-response":
      return { title: "Magpie usage is unavailable", body: "The gateway's answer was not usable usage data." };
    default: {
      const never = /** @type {never} */ (problem.kind);
      throw new Error(`unhandled problem kind ${String(never)}`);
    }
  }
}

// The runtime carries no Intl data: toLocaleString and toLocaleTimeString
// fall back to the raw number or the whole date string. Format by hand.
function group(digits) {
  const [whole, fraction] = digits.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Format 7643 as "7,643". @param {number} value */
function formatInt(value) {
  return group(String(Math.round(value)));
}

/**
 * Format token counts with K, M, G, and T suffixes. One decimal below 100 of a
 * unit, no decimal above it, plain integers below 1,000.
 *
 * @param {number} value
 */
function formatTokens(value) {
  if (value < 1000) return String(Math.floor(value));
  const units = ["K", "M", "G", "T"];
  let scaled = value, unit = -1;
  while (scaled >= 1000 && unit < units.length - 1) { scaled /= 1000; unit++; }
  const number = scaled >= 99.95 ? String(Math.round(scaled)) : scaled.toFixed(1);
  return `${number}${units[unit]}`;
}

/** Format grouped USD with exactly two decimals, such as "$509.40". @param {number} value */
function formatCost(value) {
  return `$${group(value.toFixed(2))}`;
}

/** Format null as "n/a", a positive share below one percent as "<1%", and others rounded. @param {number | null} value */
function formatPercent(value) {
  if (value === null) return "n/a";
  const percent = value * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

/** Format a successful receipt time as local HH:MM. @param {number} receivedAt */
function formatTime(receivedAt) {
  const d = new Date(receivedAt);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

export default class MagpieStats extends View {
  init(_props, cx) {
    /** @type {InstanceRegistry} */
    this.registry = { additional: [] };

    /** @type {InstanceId} */
    this.selectedInstanceId = "default";

    /** @type {Map<InstanceId, Period>} */
    this.periodByInstance = new Map();

    /** @type {Map<InstanceId, InstanceRuntime>} */
    this.runtimes = new Map();

    /** @type {boolean} */
    this.tickInFlight = false;

    /** @type {"off" | "list" | "add"} */
    this.picker = "off";

    /** @type {RegistryProblem | null} */
    this.registryProblem = null;

    /** @type {RegistryProblem | null} */
    this.addProblem = null;

    // InputState needs a live host call, so both add-form states are made
    // once here and only re-filled when the form opens.
    this.nameState = InputState.new();
    this.pathState = InputState.new();

    /** @type {number} */
    this.width = 240;

    const stored = localStorage.getItem(SELECTED_INSTANCE_KEY);
    if (stored !== null) this.selectedInstanceId = /** @type {InstanceId} */ (stored);

    this.tick(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.tick(cx));
  }

  /** The default instance plus every additional one, the default first. */
  instances() {
    return [defaultInstance(), ...this.registry.additional];
  }

  /**
   * Resolve the selected id against the current watch list; a removed or
   * unknown id falls back to the default instance.
   */
  selectedInstance() {
    return this.instances().find((entry) => entry.id === this.selectedInstanceId) ?? defaultInstance();
  }

  /**
   * The selected instance's own period. Each instance starts at 30D.
   */
  selectedPeriod() {
    return this.periodByInstance.get(this.selectedInstanceId) ?? "30d";
  }

  /**
   * Find or create the runtime that owns one instance's states and inFlight.
   * Creating it here keeps every later capture one object reference.
   *
   * @param {InstanceId} id
   */
  runtimeFor(id) {
    let runtime = this.runtimes.get(id);
    if (runtime === undefined) {
      runtime = { states: new Map(), inFlight: new Set() };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  /**
   * One cycle: re-read the shared registry, adopt it (keeping the last valid
   * one on failure), reconcile selection, and refresh what is visible. One
   * tick may be in flight; timer ticks that overlap are skipped.
   *
   * @param {import("gpui-kit").Context} cx
   */
  tick(cx) {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    cx.spawn(async (cx) => {
      try {
        try {
          const { registry } = await readRegistry();
          this.adoptRegistry(cx, registry);
          this.registryProblem = null;
        } catch (error) {
          // Keep the last valid registry; junk in the file stays quiet here.
          this.registryProblem = asRegistryProblem(error);
        }
        this.refreshVisible(cx);
      } finally {
        this.tickInFlight = false;
        cx.notify();
      }
    });
  }

  /**
   * The sole writer of this.registry. Never edits a live runtime's maps; a
   * removed instance's runtime is dropped and its detached completions write
   * harmlessly to garbage. A selection that no longer resolves falls back to
   * the default instance.
   *
   * @param {import("gpui-kit").Context} cx
   * @param {InstanceRegistry} registry
   */
  adoptRegistry(cx, registry) {
    this.registry = registry;
    for (const id of [...this.runtimes.keys()]) {
      if (id !== "default" && !registry.additional.some((entry) => entry.id === id)) this.runtimes.delete(id);
    }
    if (!registry.additional.some((entry) => entry.id === this.selectedInstanceId)) {
      this.selectInstance(cx, "default");
    }
  }

  /**
   * Refresh the selected instance, and every listed one while the picker is
   * open. Never writes a state itself; each refresh owns its own runtime.
   *
   * @param {import("gpui-kit").Context} cx
   */
  refreshVisible(cx) {
    for (const instance of this.instances()) {
      this.refresh(cx, instance, this.periodFor(instance.id), false);
    }
  }

  /**
   * The period selected for one instance; every instance starts at 30D.
   *
   * @param {InstanceId} id
   */
  periodFor(id) {
    return this.periodByInstance.get(id) ?? "30d";
  }

  /**
   * Select and reveal one instance. Ignores an unknown id; writes only the
   * selection (and its localStorage mirror); states are never written here.
   * The cached snapshot shows at once and refreshes if older than 30 seconds.
   *
   * @param {Context} cx
   * @param {InstanceId} id
   */
  selectInstance(cx, id) {
    if (id !== "default" && !this.registry.additional.some((entry) => entry.id === id)) return;
    if (id === this.selectedInstanceId) return;
    this.selectedInstanceId = id;
    localStorage.setItem(SELECTED_INSTANCE_KEY, id);
    cx.notify();
    this.refresh(cx, this.selectedInstance(), this.selectedPeriod(), false);
  }

  /**
   * Select and reveal one period for the selected instance. Ignores an
   * unknown or already selected id; writes only periodByInstance; states are
   * never written here. A missing map entry renders as loading, while a
   * cached entry stays visible while refresh(cx, instance, period, false)
   * runs.
   *
   * @param {Period} period
   */
  selectPeriod(period, cx) {
    if (!PERIODS.some((p) => p.id === period)) return;
    const id = this.selectedInstanceId;
    if (period === this.periodFor(id)) return;
    this.periodByInstance.set(id, period);
    cx.notify();
    this.refreshVisible(cx);
  }

  /**
   * The sole owner of states and inFlight mutations, and the only refresh
   * entry point. The runtime object is captured before cx.spawn, so a
   * selection or registry change cannot redirect where a late answer lands;
   * a removed instance's completion writes to garbage. One request per
   * period may be in flight; a non-forced call skips a period that is ready
   * and younger than REFRESH_MS (stale data never counts as fresh). Results
   * land only in their own instance's entry.
   *
   * @param {GatewayInstance} instance
   * @param {Period} period
   * @param {boolean} force
   */
  refresh(cx, instance, period, force) {
    const runtime = this.runtimeFor(instance.id);
    if (runtime.inFlight.has(period)) return;
    const current = runtime.states.get(period);
    if (!force && current?.kind === "ready" && Date.now() - current.snapshot.receivedAt < REFRESH_MS) return;
    runtime.inFlight.add(period);
    cx.notify();
    cx.spawn(async (cx) => {
      let next;
      try {
        next = { kind: "ready", snapshot: await loadUsage(instance, period) };
      } catch (error) {
        const problem = asProblem(error);
        const existing = runtime.states.get(period);
        next = existing && existing.kind !== "unavailable"
          ? { kind: "stale", snapshot: existing.snapshot, problem }
          : { kind: "unavailable", problem };
      } finally {
        // Read the map entry at completion time; selection may have changed meanwhile.
        runtime.states.set(period, next);
        runtime.inFlight.delete(period);
        cx.notify();
      }
    });
  }

  /**
   * Open or close the picker. Opening re-reads the shared registry so a
   * change made in another docked copy shows at once.
   */
  togglePicker(cx) {
    if (this.picker === "off") {
      this.picker = "list";
      this.tick(cx);
    } else {
      this.picker = "off";
      this.addProblem = null;
      cx.notify();
    }
  }

  /**
   * Show the add form, prefilled with the next unused gateway number.
   */
  showAdd(cx) {
    this.picker = "add";
    this.addProblem = null;
    const taken = new Set(this.registry.additional.map((entry) => entry.name.toLowerCase()));
    let n = this.registry.additional.length + 2;
    while (taken.has(`magpie-${n}`)) n++;
    this.nameState.set_value(`magpie-${n}`);
    this.pathState.set_value(`~/.config/magpie/gateway-${n}.json`);
    cx.notify();
  }

  /**
   * Leave the add form back to the list; typed values are left alone.
   */
  cancelAdd(cx) {
    this.picker = "list";
    this.addProblem = null;
    cx.notify();
  }

  /**
   * Validate the add form and write it through updateRegistry; on success the
   * new instance is selected and the picker closes. A failure shows inline
   * and the form keeps its contents.
   */
  saveAdd(cx) {
    try {
      this.addProblem = null;
      const instance = parseInstanceDraft(this.nameState.value(), this.pathState.value());
      cx.notify();
      cx.spawn(async (cx) => {
        try {
          const registry = await updateRegistry({ kind: "add", instance });
          this.adoptRegistry(cx, registry);
          this.registryProblem = null;
          this.picker = "off";
          this.selectInstance(cx, instance.id);
        } catch (error) {
          this.addProblem = asRegistryProblem(error);
          cx.notify();
        }
      });
    } catch (error) {
      this.addProblem = asRegistryProblem(error);
      cx.notify();
    }
  }

  /**
   * Remove one additional instance through updateRegistry. The default has
   * no remove control; a copy watching a removed id falls back to the
   * default on its next registry read. A failure shows as the picker's
   * quiet line.
   *
   * @param {InstanceId} id
   */
  removeInstance(cx, id) {
    cx.spawn(async (cx) => {
      try {
        const registry = await updateRegistry({ kind: "remove", id });
        this.adoptRegistry(cx, registry);
        this.registryProblem = null;
        this.refreshVisible(cx);
      } catch (error) {
        this.registryProblem = asRegistryProblem(error);
        cx.notify();
      }
    });
  }

  /**
   * Build the header, picker, period buttons, compact rail, and current
   * state body. Reads only the registry, selection, per-instance states, and
   * width. No fetch, no notify.
   *
   * @param {unknown} _cx
   */
  render(_cx) {
    const t = theme();
    const instance = this.selectedInstance();
    const runtime = this.runtimeFor(instance.id);
    const state = runtime.states.get(this.periodFor(instance.id)) ?? { kind: "loading" };
    if (this.width < 160) return this.renderRail(instance, state, t);
    const busy = runtime.inFlight.has(this.periodFor(instance.id));
    const status = statusOf(state, t);
    return v_flex().id("magpie-stats").size_full().min_h(0).overflow_hidden().bg(t.chrome).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => {
        const width = size.width;
        if (width !== this.width) { this.width = width; cx.notify(); }
      })
      .child(h_flex().flex_none().px(10).pt(8).pb(4).gap(6).items_center()
        .child(div().font_semibold().cursor_pointer().tooltip("Switch gateway")
          .hover((s) => s.bg(t.hover)).rounded(5)
          .on_click((_e, cx) => this.togglePicker(cx))
          .child(instance.name))
        .child(div().size(5).rounded(3).bg(status.color))
        .child(div().text_size(11).text_color(status.color).tooltip(status.note).child(status.label))
        .when(this.instances().length >= 2, (e) => e.child(this.renderOtherDots(instance, t)))
        .child(div().flex_1())
        .child(div().id("magpie-refresh").flex_none().w(20).h(20).flex().items_center().justify_center().rounded(5)
          .text_size(12)
          .when(busy, (e) => e.text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
          .when(!busy, (e) => e.text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).child("↻"))
          .tooltip("Refresh now")
          .on_click((_e, cx) => this.refresh(cx, this.selectedInstance(), this.selectedPeriod(), true))))
      .when(this.picker !== "off", (e) => e.child(this.renderPicker(t)))
      .child(h_flex().flex_none().px(10).pb(6).gap(2)
        .children(PERIODS.map((p) => {
          const selected = p.id === this.periodFor(this.selectedInstanceId);
          return div().id(`magpie-period-${p.id}`).flex_1().h(20).flex().items_center().justify_center().rounded(5)
            .text_size(11).cursor_pointer()
            .bg(selected ? t.raised : "#00000000")
            .text_color(selected ? t.foreground : t.muted)
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.selectPeriod(p.id, cx))
            .child(p.label);
        })))
      .child(this.renderBody(state, t));
  }

  /**
   * One 5px dot per other instance (nothing at N=1), colored by that
   * instance's own status for its own selected period.
   *
   * @param {GatewayInstance} selected
   */
  renderOtherDots(selected, t) {
    if (this.instances().length < 2) return null;
    return h_flex().flex_none().gap(2).items_center()
      .children(this.instances().filter((entry) => entry.id !== selected.id).map((entry) => {
        const runtime = this.runtimeFor(entry.id);
        const status = statusOf(runtime.states.get(this.periodFor(entry.id)) ?? { kind: "loading" }, t);
        return div().id(`magpie-dot-${entry.id}`).size(5).rounded(3).bg(status.color)
          .tooltip(`${entry.name} · ${status.label}`);
      }));
  }

  /**
   * The picker: one row per instance plus an add footer, or the add form
   * with its inline problem line. One quiet registry-problem line sits at
   * the bottom either way.
   *
   * @param {*} t
   */
  renderPicker(t) {
    const selected = this.selectedInstance();
    const body = this.picker === "add" ? this.renderAddForm(t) : v_flex().flex_none().gap(2)
      .child(v_flex().id("magpie-picker").flex_none().max_h(110).overflow_y_scroll().gap(2)
        .children(this.instances().map((instance) => {
          const runtime = this.runtimeFor(instance.id);
          const status = statusOf(runtime.states.get(this.periodFor(instance.id)) ?? { kind: "loading" }, t);
          const isSelected = instance.id === selected.id;
          return h_flex().id(`magpie-instance-${instance.id}`).h(22).px(6).gap(6).items_center().rounded(5)
            .cursor_pointer()
            .bg(isSelected ? t.raised : "#00000000")
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.selectInstance(cx, instance.id))
            .child(div().flex_none().size(5).rounded(3).bg(status.color).tooltip(`${instance.name} · ${status.label}`))
            .child(div().flex_1().min_w(0).truncate()
              .text_color(isSelected ? t.foreground : t.muted)
              .child(instance.name))
            .when(instance.id !== "default", (e) => e
              .child(div().id(`magpie-remove-${instance.id}`).flex_none().text_size(11).text_color(t.muted)
                .cursor_pointer().rounded(3)
                .hover((s) => s.text_color(t.blocked))
                .tooltip(`Remove ${instance.name}`)
                .on_mouse_down("left", (_e2, cx) => cx.stop_propagation())
                .on_click((_e2, cx) => this.removeInstance(cx, instance.id))
                .child("✕")));
        })))
      .child(h_flex().id("magpie-add-open").flex_none().h(20).px(6).gap(6).items_center().rounded(5)
        .cursor_pointer().text_size(11).text_color(t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.showAdd(cx))
        .child("+ Add gateway"));
    return v_flex().flex_none().px(10).pb(4)
      .child(body)
      .when(this.registryProblem !== null, (e) => e
        .child(div().id("magpie-registry-problem").flex_none().text_size(11).text_color(t.dim)
          .tooltip(this.registryProblem?.detail)
          .child(registryProblemCopy(this.registryProblem))));
  }

  /**
   * The add form: two labeled fields, the inline problem line, Add and
   * Cancel. A failure keeps the typed values.
   *
   * @param {*} t
   */
  renderAddForm(t) {
    return v_flex().id("magpie-add").flex_none().px(0).pb(4).gap(6)
      .child(v_flex().flex_none().gap(3)
        .child(div().text_size(11).text_color(t.dim).child("Name"))
        .child(Input.new(this.nameState).h(22).px(6).rounded(5).border_1().border_color(t.border).bg(t.raised)
          .text_size(11).text_color(t.foreground)))
      .child(v_flex().flex_none().gap(3)
        .child(div().text_size(11).text_color(t.dim).child("Address file"))
        .child(Input.new(this.pathState).h(22).px(6).rounded(5).border_1().border_color(t.border).bg(t.raised)
          .text_size(11).text_color(t.foreground)))
      .when(this.addProblem !== null, (e) => e
        .child(div().id("magpie-add-problem").flex_none().text_size(11).text_color(t.blocked)
          .tooltip(this.addProblem?.detail)
          .child(this.addProblem?.detail)))
      .child(h_flex().flex_none().gap(6)
        .child(div().id("magpie-add-cancel").flex_none().h(24).px(8).flex().items_center().rounded(5)
          .text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.cancelAdd(cx))
          .child("Cancel"))
        .child(div().id("magpie-add-save").flex_none().h(24).px(8).flex().items_center().rounded(5)
          .text_size(11).text_color(t.accent).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.saveAdd(cx))
          .child("Add")));
  }

  /**
   * The panel below 160px: the selected instance's initial, its status dot,
   * one dot per other instance, one refresh click.
   *
   * @param {GatewayInstance} instance
   * @param {PeriodState} state
   */
  renderRail(instance, state, t) {
    const status = statusOf(state, t);
    const snapshot = state.kind === "ready" || state.kind === "stale" ? state.snapshot : null;
    const note = snapshot
      ? `${instance.name} ${status.label.toLowerCase()} · ${formatCost(snapshot.totals.cost)} · ${formatInt(snapshot.totals.calls)} calls · updated ${formatTime(snapshot.receivedAt)}`
      : `${instance.name} ${status.label.toLowerCase()} · ${status.note}`;
    const others = this.instances().filter((entry) => entry.id !== instance.id);
    return v_flex().id("magpie-stats").size_full().min_h(0).overflow_hidden().bg(t.chrome).text_color(t.foreground)
      .on_size_change((size, cx) => {
        const width = size.width;
        if (width !== this.width) { this.width = width; cx.notify(); }
      })
      .child(v_flex().id("magpie-rail").flex_1().min_h(0).items_center().justify_center().cursor_pointer()
        .text_size(12).font_semibold().text_color(t.muted).tooltip(note)
        .on_click((_e, cx) => this.refresh(cx, this.selectedInstance(), this.selectedPeriod(), true))
        .child(h_flex().gap(3).items_center()
          .child(instance.name.slice(0, 1).toUpperCase())
          .child(div().size(5).rounded(3).bg(status.color)))
        .when(others.length > 0, (e) => e.child(v_flex().pt(3).gap(2).items_center()
          .children(others.map((entry) => {
            const runtime = this.runtimeFor(entry.id);
            const other = statusOf(runtime.states.get(this.periodFor(entry.id)) ?? { kind: "loading" }, t);
            return div().id(`magpie-rail-dot-${entry.id}`).size(5).rounded(3).bg(other.color)
              .tooltip(`${entry.name} · ${other.label}`);
          })))));
  }

  /**
   * The state body: snapshot content for ready and stale (stale adds the
   * footer), one quiet line for loading, problemCopy for unavailable.
   *
   * @param {PeriodState} state
   */
  renderBody(state, t) {
    if (state.kind === "loading") {
      return div().flex_1().min_h(0).px(10).pt(8).text_color(t.dim).child("Reading Magpie usage…");
    }
    if (state.kind === "unavailable") {
      const copy = problemCopy(state.problem);
      return v_flex().flex_1().min_h(0).px(10).pt(10).gap(4)
        .child(div().font_medium().text_color(t.foreground).child(copy.title))
        .child(div().text_size(11).text_color(t.dim).tooltip(state.problem.detail).child(copy.body));
    }
    const content = this.renderSnapshot(state.snapshot);
    if (state.kind !== "stale") return content;
    return v_flex().flex_1().min_h(0)
      .child(content)
      .child(h_flex().flex_none().px(10).py(4).text_size(11).text_color(t.dim)
        .tooltip(problemCopy(state.problem).body)
        .child(`Can't refresh · updated ${formatTime(state.snapshot.receivedAt)}`));
  }

  /**
   * Render totals, token details, chart, agents, and models. Wire fields never
   * appear; everything comes from the validated snapshot.
   *
   * @param {UsageSnapshot} snapshot
   */
  renderSnapshot(snapshot) {
    const t = theme();
    const totals = snapshot.totals;
    const cost = h_flex().flex_none().px(10).pt(6).gap(6).items_end().flex_wrap()
      .child(div().text_size(17).font_semibold().child(formatCost(totals.cost)))
      .when(totals.unpriced > 0, (e) => e.child(div().text_size(11).pb(1).text_color(t.dim).child(`+ ${formatInt(totals.unpriced)} unpriced`)));
    const calls = h_flex().flex_none().px(10).pt(3).gap(6).items_center().flex_wrap().text_color(t.muted)
      .child(div().child(`${formatInt(totals.calls)} calls`))
      .when(totals.errors > 0, (e) => e.child(div().text_color(t.blocked).child(`· ${formatInt(totals.errors)} errors`)));
    // Input, output, and cache-read tokens share one tooltip with the classes
    // that don't get their own line; an all-zero period omits the line entirely.
    const shownTokens = totals.input > 0 || totals.output > 0 || totals.cacheRead > 0;
    const tokenTooltip = [
      `Input ${formatTokens(totals.input)} (${formatInt(totals.input)})`,
      `Output ${formatTokens(totals.output)} (${formatInt(totals.output)})`,
      `Cache read ${formatTokens(totals.cacheRead)} (${formatInt(totals.cacheRead)})`,
      `Cache write ${formatTokens(totals.cacheWrite)} (${formatInt(totals.cacheWrite)})`,
      `Reasoning ${formatTokens(totals.reasoning)} (${formatInt(totals.reasoning)})`,
      `Unpriced calls ${formatInt(totals.unpriced)}`,
    ].join("\n");
    const tokens = shownTokens
      ? h_flex().id("magpie-tokens").flex_none().px(10).pt(3).gap(6).items_center().flex_wrap().text_size(11).text_color(t.dim)
          .tooltip(tokenTooltip)
          .child(div().child(`${formatTokens(totals.input)} in · ${formatTokens(totals.output)} out`))
          .when(totals.cacheRead > 0, (e) => e.child(div().child(`${formatTokens(totals.cacheRead)} cache read`)))
      : null;
    return v_flex().id("magpie-snapshot").w_full().flex_1().min_h(0).overflow_y_scroll()
      .child(cost).child(calls).when(tokens !== null, (e) => e.child(tokens))
      .child(this.renderChart(snapshot.chart))
      // One agent at 100% carries no routing information.
      .when(snapshot.agents.totalCount > 1, (e) => e.child(this.renderShareSection("Agents", snapshot.agents)))
      .child(this.renderShareSection("Models", snapshot.models));
  }

  /**
   * Render at most CHART_LIMIT flex-sized bars. One maximum over the shown
   * bars; zero calls gets height zero; a nonzero bar is at least 2px. No SVG,
   * canvas, or animation timer.
   *
   * @param {Chart} chart
   */
  renderChart(chart) {
    const t = theme();
    const max = chart.bars.reduce((m, bar) => Math.max(m, bar.calls), 0);
    const height = (calls) => calls <= 0 ? 0 : Math.max(2, Math.round((calls / (max || 1)) * 28));
    const by = { hour: "hour", day: "day", week: "week" }[chart.bucket];
    return v_flex().flex_none().px(10).pt(8)
      .child(h_flex().id("magpie-chart").w_full().h(32).items_end().gap(1)
        .when(chart.bars.length === 0 || max === 0, (e) => e.items_center().justify_center().text_size(11).text_color(t.dim).child("No calls in this period"))
        .children(chart.bars.map((bar) => {
          const tooltip = [bar.label, `${formatInt(bar.calls)} calls`, `${formatInt(bar.errors)} errors`, formatCost(bar.cost)].join("\n");
          return div().id(`magpie-bar-${bar.key}`).flex_1().min_w(0).h(32).flex().items_end()
            .when(height(bar.calls) > 0, (e) => e.child(div().w_full().h(height(bar.calls)).flex_none().rounded(1).bg(t.accent)))
            .tooltip(tooltip);
        })))
      .when(chart.truncated, (e) => e.child(div().text_size(11).text_color(t.dim).child(`Calls by ${by} · last ${CHART_LIMIT}`)));
  }

  /**
   * Render one titled share section. Rows preserve parse order and have no
   * click handler; `+ N more` appears only when rows were actually omitted.
   *
   * @param {"Agents" | "Models"} title
   * @param {ShareList} list
   */
  renderShareSection(title, list) {
    const t = theme();
    return v_flex().flex_none().px(10).pt(8)
      .child(div().pb(2).text_size(11).font_medium().text_color(t.dim).child(title))
      .children(list.rows.map((row) => {
        const percent = formatPercent(row.share);
        const tooltip = [
          row.name + (row.detail ? ` (${row.detail})` : ""),
          `${formatInt(row.calls)} calls · ${formatInt(row.errors)} errors`,
          formatCost(row.cost),
          `${formatTokens(row.tokens)} tokens (${formatInt(row.tokens)})`,
          `Share of period tokens ${percent}`,
        ].join("\n");
        return h_flex().id(`magpie-${title.toLowerCase()}-${row.id}`).h(18).gap(6).items_center()
          .tooltip(tooltip)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(row.name))
          .child(div().flex_none().text_size(11).text_color(t.muted).child(formatTokens(row.tokens)))
          .child(div().flex_none().w(34).text_right().text_size(11).text_color(t.dim).child(percent));
      }))
      .when(list.totalCount > list.rows.length, (e) => e.child(div().text_size(11).text_color(t.dim).child(`+ ${list.totalCount - list.rows.length} more`)));
  }
}

/**
 * One short line for a registry problem, shown quietly in the picker.
 *
 * @param {RegistryProblem | null} problem
 * @returns {string}
 */
function registryProblemCopy(problem) {
  if (problem === null) return "";
  switch (problem.kind) {
    case "bad-registry": return "The gateway list file isn't valid; showing the last good list.";
    case "registry-io": return "Couldn't read or save the gateway list.";
    case "invalid-instance": return "That gateway can't be added.";
    default: {
      const never = /** @type {never} */ (problem.kind);
      throw new Error(`unhandled registry problem kind ${String(never)}`);
    }
  }
}

function statusOf(state, t) {
  switch (state.kind) {
    case "loading": return { label: "Working", color: t.dim, note: "Reading Magpie usage" };
    case "ready": return { label: "Live", color: t.working, note: "Showing the gateway's latest answer" };
    case "stale": return { label: "Stale", color: t.idle, note: problemCopy(state.problem).body };
    case "unavailable":
      if (state.problem.kind === "not-running" || state.problem.kind === "unreachable") {
        return { label: "Offline", color: t.blocked, note: problemCopy(state.problem).body };
      }
      return { label: "Unavailable", color: t.blocked, note: problemCopy(state.problem).body };
  }
}
