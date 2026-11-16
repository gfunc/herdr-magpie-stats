import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { home, appHome, readTextFile, writeTextFile, theme } from "herdr";
import { URL } from "url";

const REFRESH_MS = 30_000;
const CHART_LIMIT = 30;
const QUOTA_LIMIT = 4;

// Rail, narrow, medium and wide, by the panel's own width. The content is one
// 560 column until it can hold two of them side by side.
const RAIL_WIDTH = 160;
const NARROW_WIDTH = 420;
const MEDIUM_WIDTH = 760;
const COLUMN_WIDTH = 560;
const COLUMN_GAP = 16;
const CONTENT_WIDTH = COLUMN_WIDTH * 2 + COLUMN_GAP;

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
/** @typedef {{id: InstanceId, name: string, kind: "file", addressFile: string} | {id: InstanceId, name: string, kind: "key", url: string, key: string}} GatewayInstance */
/** @typedef {{additional: GatewayInstance[]}} InstanceRegistry */
/** @typedef {{kind: "add", instance: GatewayInstance} | {kind: "remove", id: InstanceId}} RegistryChange */
/** @typedef {"bad-registry" | "registry-io" | "invalid-instance"} RegistryProblemKind */
/** @typedef {{kind: RegistryProblemKind, detail: string}} RegistryProblem */
/** @typedef {{states: Map<Period, PeriodState>, inFlight: Set<Period>, quota: QuotaState, quotaInFlight: boolean}} InstanceRuntime */

/**
 * @typedef {{
 *   calls: number, errors: number, retried: number, canceled: number, loops: number,
 *   input: number, output: number, cacheRead: number, cacheWrite: number,
 *   reasoning: number, cost: number, unpriced: number,
 *   credits: number, credited: number,
 *   timed: number, ttftMs: number, decodeMs: number, decodeOut: number, decodeN: number,
 *   upBytes: number, downBytes: number
 * }} Totals
 */

/**
 * One row of Agents, Models, Accounts or Gateway keys. tokens is input +
 * output; share is its part of the period's tokens, or 0 when the period has
 * none.
 *
 * @typedef {{
 *   id: string, name: string, detail: string,
 *   calls: number, errors: number, retried: number, canceled: number, loops: number,
 *   cost: number, unpriced: number,
 *   input: number, output: number,
 *   cacheRead: number, cacheWrite: number, reasoning: number,
 *   tokens: number, timed: number, ttftMs: number, decodeMs: number, decodeOut: number,
 *   decodeN: number, ownCalls: number, share: number
 * }} UsageRow
 */

/**
 * @typedef {{
 *   key: string, label: string,
 *   calls: number, errors: number, cost: number,
 *   input: number, output: number, cacheRead: number, cacheWrite: number,
 *   reasoning: number
 * }} ChartPoint
 */

/**
 * @typedef {{
 *   bucket: "hour" | "day" | "week", truncated: boolean, points: ChartPoint[]
 * }} Chart
 */

/**
 * @typedef {{
 *   period: Period, receivedAt: number, totals: Totals, chart: Chart,
 *   agents: UsageRow[], models: UsageRow[], accounts: UsageRow[], keys: UsageRow[]
 * }} UsagePageSnapshot
 */

/**
 * @typedef {{kind: "loading"}
 *   | {kind: "ready", snapshot: UsagePageSnapshot}
 *   | {kind: "stale", snapshot: UsagePageSnapshot, problem: Problem}
 *   | {kind: "unavailable", problem: Problem}} PeriodState
 */

/**
 * @typedef {{
 *   name: string, used: number | null, remaining: number | null,
 *   unlimited: boolean, display: string, unit: string,
 *   balance: number | null, resetsAt: string
 * }} QuotaWindow
 */

/**
 * `pressure` is the lowest remaining among finite, limited windows; `worst`
 * holds it.
 * @typedef {{
 *   id: string, provider: string, name: string, kind: string,
 *   plan: string, user: string, balance: string, error: string,
 *   windows: QuotaWindow[], pressure: number | null, worst: QuotaWindow | null,
 *   readAt: string
 * }} QuotaAccount
 */

/** @typedef {{receivedAt: number, accounts: QuotaAccount[]}} QuotaSnapshot */

/**
 * @typedef {{kind: "loading"}
 *   | {kind: "ready", snapshot: QuotaSnapshot}
 *   | {kind: "stale", snapshot: QuotaSnapshot, problem: Problem}
 *   | {kind: "unavailable", problem: Problem}} QuotaState
 */

/** @param {number} width */
function tierOf(width) {
  if (width < NARROW_WIDTH) return "narrow";
  if (width < MEDIUM_WIDTH) return "medium";
  return "wide";
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
  return { id: "default", name: "Magpie", kind: "file", addressFile: `${home()}/.config/magpie/gateway.json` };
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
    const { id, name } = entry;
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
    const kind = entry.kind === undefined ? "file" : entry.kind;
    if (kind === "file") {
      const { addressFile } = entry;
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
      additional.push({ id, name: trimmed, kind: "file", addressFile: absolute });
    } else if (kind === "key") {
      if (typeof entry.url !== "string" || typeof entry.key !== "string") {
        throw bad("bad-registry", `gateway "${trimmed}" needs a URL and an API key`);
      }
      try {
        const fields = keyFields(entry.url, entry.key);
        additional.push({ id, name: trimmed, kind: "key", url: fields.url, key: fields.key });
      } catch (error) {
        const detail = typeof error === "object" && error !== null && "detail" in error
          ? String(/** @type {any} */ (error).detail)
          : "its URL or API key is invalid";
        throw bad("bad-registry", `gateway "${trimmed}": ${detail}`);
      }
    } else {
      throw bad("bad-registry", `gateway "${trimmed}" has an unknown kind`);
    }
    ids.add(id);
    names.add(folded);
  }
  return { additional };
}

/**
 * @param {string} name
 */
function draftName(name) {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 24) {
    throw bad("invalid-instance", "name: give it a name of 1 to 24 characters");
  }
  return trimmed;
}

/**
 * @param {string} name
 * @param {string} addressFile
 * @returns {GatewayInstance}
 */
function parseInstanceDraft(name, addressFile) {
  const trimmed = draftName(name);
  const raw = addressFile.trim();
  if (raw === "") throw bad("invalid-instance", "address file: give the path to its gateway.json");
  const absolute = expandTilde(raw);
  if (!isAbsolutePath(absolute)) {
    throw bad("invalid-instance", "address file: give an absolute path, such as ~/.config/magpie/gateway-2.json");
  }
  if (!isUnderHome(absolute)) {
    throw bad("invalid-instance", "address file: it must live inside your home directory");
  }
  return { id: newInstanceId(), name: trimmed, kind: "file", addressFile: absolute };
}

/**
 * Neither the key nor the raw URL appears in an error.
 *
 * @param {string} urlText
 * @param {string} keyText
 * @returns {{url: string, key: string}}
 */
function keyFields(urlText, keyText) {
  const rawUrl = urlText.trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw bad("invalid-instance", "url: give an http or https URL such as http://127.0.0.1:3425");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw bad("invalid-instance", "url: use an http or https URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw bad("invalid-instance", "url: remove the username and password");
  }
  if (parsed.hostname === "") throw bad("invalid-instance", "url: give it a host");
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw bad("invalid-instance", "url: use the origin only, with no path");
  }
  if (rawUrl.includes("?") || rawUrl.includes("#") || parsed.search !== "" || parsed.hash !== "") {
    throw bad("invalid-instance", "url: remove the query and fragment");
  }
  const key = keyText.trim();
  if (key === "") throw bad("invalid-instance", "api key: give the gateway's API key");
  for (const char of key) {
    const code = char.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) {
      throw bad("invalid-instance", "api key: use printable ASCII characters with no spaces");
    }
  }
  return { url: parsed.origin, key };
}

/**
 * @param {string} name
 * @param {string} url
 * @param {string} key
 * @returns {GatewayInstance}
 */
function parseKeyInstanceDraft(name, url, key) {
  const trimmed = draftName(name);
  const fields = keyFields(url, key);
  return { id: newInstanceId(), name: trimmed, kind: "key", url: fields.url, key: fields.key };
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
  // Stored in explicit form, so a replay compares equal to the parsed entry
  // and a second write of the same entry is a no-op.
  const stored = instance.kind === "key"
    ? instance
    : { id: instance.id, name: instance.name, kind: "file", addressFile: instance.addressFile };
  const duplicate = stored.kind === "key"
    ? (entry) => entry.kind === "key" && entry.id === stored.id && entry.name === stored.name &&
        entry.url === stored.url && entry.key === stored.key
    : (entry) => entry.kind === "file" && entry.id === stored.id && entry.name === stored.name &&
        entry.addressFile === stored.addressFile;
  if (registry.additional.some(duplicate)) return registry;
  if (registry.additional.some((entry) => entry.id === stored.id)) {
    throw bad("invalid-instance", `id "${stored.id}" is already in the gateway list`);
  }
  if (registry.additional.some((entry) => entry.name.toLowerCase() === stored.name.toLowerCase())) {
    throw bad("invalid-instance", `a gateway named "${stored.name}" already exists`);
  }
  return { additional: [...registry.additional, stored] };
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
 * A file instance re-reads its address file on every request, so a port
 * change heals without a reload. A key instance puts the key in the request
 * header only.
 *
 * @param {GatewayInstance} instance
 * @returns {Promise<{origin: string, headers: Record<string, string> | undefined}>}
 */
async function resolveGateway(instance) {
  if (instance.kind === "key") {
    return { origin: instance.url, headers: { Authorization: `Bearer ${instance.key}` } };
  }
  let text;
  try {
    text = await readTextFile(instance.addressFile);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw bad("unreachable", `cannot read the gateway address file (${message})`);
  }
  if (text === null) throw bad("not-running", "the gateway address file is absent");
  return { origin: gatewayOrigin(text), headers: undefined };
}

/**
 * A redirect is refused because redirects are followed transparently:
 * response.url is the only evidence of one.
 *
 * @param {*} response
 * @param {string} url
 * @returns {Problem | null}
 */
function responseProblem(response, url) {
  if (response.status === 401 || response.status === 403) {
    return bad("bad-response", "the gateway refused the key");
  }
  if (!response.ok || response.url !== url) return bad("bad-response", `HTTP ${response.status}`);
  return null;
}

/**
 * @param {GatewayInstance} instance
 * @param {Period} period
 * @returns {Promise<UsagePageSnapshot>}
 */
async function loadUsage(instance, period) {
  const { origin, headers } = await resolveGateway(instance);
  const url = `${origin}/v1/magpie/usage?period=${period}`;
  const response = await fetch(url, headers ? { headers } : undefined);
  const problem = responseProblem(response, url);
  if (problem !== null) throw problem;
  return parseUsage(await response.json(), period, Date.now());
}

/**
 * @param {GatewayInstance} instance
 * @returns {Promise<QuotaSnapshot>}
 */
async function loadQuota(instance) {
  const { origin, headers } = await resolveGateway(instance);
  const url = `${origin}/v1/magpie/quotas`;
  const response = await fetch(url, headers ? { headers } : undefined);
  const problem = responseProblem(response, url);
  if (problem !== null) throw problem;
  return parseQuota(await response.json(), Date.now());
}

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function badResponse(detail) {
  return bad("bad-response", detail);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} name
 */
function requiredNumber(obj, name) {
  if (!finiteNonnegative(obj[name])) {
    throw badResponse(`field "${name}" is missing or not a finite nonnegative number`);
  }
  return /** @type {number} */ (obj[name]);
}

/**
 * A count the gateway may leave out: absent or unusable reads as 0, never NaN.
 *
 * @param {Record<string, unknown>} obj
 * @param {string} name
 */
function optionalNumber(obj, name) {
  const value = obj[name];
  return finiteNonnegative(value) ? /** @type {number} */ (value) : 0;
}

/**
 * A list the gateway may leave out: absent is empty, anything else is a bad
 * answer.
 *
 * @param {Record<string, unknown>} obj
 * @param {string} name
 */
function listOf(obj, name) {
  const value = obj[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badResponse(`${name} is not an array`);
  return value;
}

/**
 * Validate raw JSON and convert it to the domain model. Missing or malformed
 * required data throws "bad-response"; junk is never clamped into zero. Every
 * field not named in UsagePageSnapshot is ignored here and nowhere else.
 *
 * @param {unknown} raw
 * @param {Period} period
 * @param {number} receivedAt
 * @returns {UsagePageSnapshot}
 */
function parseUsage(raw, period, receivedAt) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw badResponse("payload is not an object");
  const obj = /** @type {Record<string, unknown>} */ (raw);
  if (obj.period !== period) throw badResponse(`payload period "${String(obj.period)}" does not match "${period}"`);
  const bucket = obj.bucket;
  if (bucket !== "hour" && bucket !== "day" && bucket !== "week") throw badResponse(`unknown bucket "${String(bucket)}"`);
  if (!Array.isArray(obj.series)) throw badResponse("series is not an array");
  if (!Array.isArray(obj.agents)) throw badResponse("agents is not an array");
  if (!Array.isArray(obj.models)) throw badResponse("models is not an array");

  const totals = {
    calls: requiredNumber(obj, "calls"),
    errors: requiredNumber(obj, "errors"),
    retried: optionalNumber(obj, "retried"),
    canceled: optionalNumber(obj, "canceled"),
    loops: optionalNumber(obj, "loops"),
    input: requiredNumber(obj, "input"),
    output: requiredNumber(obj, "output"),
    cacheRead: optionalNumber(obj, "cache_read"),
    cacheWrite: optionalNumber(obj, "cache_write"),
    reasoning: optionalNumber(obj, "reasoning"),
    cost: requiredNumber(obj, "cost"),
    unpriced: optionalNumber(obj, "unpriced"),
    credits: optionalNumber(obj, "credits"),
    credited: optionalNumber(obj, "credited"),
    timed: optionalNumber(obj, "timed"),
    ttftMs: optionalNumber(obj, "ttft_ms"),
    decodeMs: optionalNumber(obj, "decode_ms"),
    decodeOut: optionalNumber(obj, "decode_out"),
    decodeN: optionalNumber(obj, "decode_n"),
    upBytes: optionalNumber(obj, "up_bytes"),
    downBytes: optionalNumber(obj, "down_bytes"),
  };
  const periodTokens = totals.input + totals.output;

  const points = obj.series.slice(-CHART_LIMIT).map((point, i) => {
    if (typeof point !== "object" || point === null) throw badResponse("a series point is not an object");
    const p = /** @type {Record<string, unknown>} */ (point);
    if (typeof p.label !== "string" || typeof p.time !== "string") throw badResponse("a series point has no label or time");
    // The kept array's own indices keep keys unique after slicing; the point's
    // time makes them stable across refreshes whose windows shift.
    return {
      key: `${p.time}:${i}`, label: p.label,
      calls: requiredNumber(p, "calls"),
      errors: requiredNumber(p, "errors"),
      cost: requiredNumber(p, "cost"),
      input: requiredNumber(p, "input"),
      output: requiredNumber(p, "output"),
      cacheRead: optionalNumber(p, "cache_read"),
      cacheWrite: optionalNumber(p, "cache_write"),
      reasoning: optionalNumber(p, "reasoning"),
    };
  });
  const chart = { bucket, truncated: obj.series.length > points.length, points };

  const agents = obj.agents.map((entry) => parseUsageRow(entry, periodTokens, { name: ["name", "id"], detail: [] }));
  const models = obj.models.map((entry) => parseUsageRow(entry, periodTokens, { name: ["model", "name", "id"], detail: ["sub", "provider"] }));
  const accounts = listOf(obj, "accounts").map((entry) => parseUsageRow(entry, periodTokens, {
    name: ["account", "name", "id"], detail: ["sub", "provider"], emptyName: "account not recorded",
  }));
  const keys = listOf(obj, "callerKeys").map((entry) => parseUsageRow(entry, periodTokens, {
    name: ["callerKeyName", "name", "callerKeyId"], detail: ["sub", "provider"],
  }));
  return { period, receivedAt, totals, chart, agents, models, accounts, keys };
}

/**
 * Validate one list entry. calls, errors, cost, input and output are required;
 * everything else the server may leave out reads as 0. The server's order is
 * preserved instead of sorting again.
 *
 * @param {unknown} raw
 * @param {number} periodTokens
 * @param {{name: string[], detail: string[], emptyName?: string}} fallbacks
 * @returns {UsageRow}
 */
function parseUsageRow(raw, periodTokens, fallbacks) {
  if (typeof raw !== "object" || raw === null) throw badResponse("a usage row is not an object");
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const pick = (names) => {
    for (const name of names) {
      const value = obj[name];
      if (typeof value === "string" && value !== "") return value;
    }
    return "";
  };
  const own = typeof obj.own === "object" && obj.own !== null ? /** @type {Record<string, unknown>} */ (obj.own) : null;
  const input = requiredNumber(obj, "input");
  const output = requiredNumber(obj, "output");
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    name: pick(fallbacks.name) || fallbacks.emptyName || "",
    detail: pick(fallbacks.detail),
    calls: requiredNumber(obj, "calls"),
    errors: requiredNumber(obj, "errors"),
    retried: optionalNumber(obj, "retried"),
    canceled: optionalNumber(obj, "canceled"),
    loops: optionalNumber(obj, "loops"),
    cost: requiredNumber(obj, "cost"),
    unpriced: optionalNumber(obj, "unpriced"),
    input, output,
    cacheRead: optionalNumber(obj, "cache_read"),
    cacheWrite: optionalNumber(obj, "cache_write"),
    reasoning: optionalNumber(obj, "reasoning"),
    tokens: input + output,
    timed: optionalNumber(obj, "timed"),
    ttftMs: optionalNumber(obj, "ttft_ms"),
    decodeMs: optionalNumber(obj, "decode_ms"),
    decodeOut: optionalNumber(obj, "decode_out"),
    decodeN: optionalNumber(obj, "decode_n"),
    ownCalls: own === null ? 0 : optionalNumber(own, "calls"),
    share: periodTokens > 0 ? (input + output) / periodTokens : 0,
  };
}

/** @param {unknown} value */
function optionalString(value) {
  return typeof value === "string" ? value : "";
}

/** @param {unknown} value */
function optionalFinite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} raw
 * @param {number} receivedAt
 * @returns {QuotaSnapshot}
 */
function parseQuota(raw, receivedAt) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw badResponse("payload is not an object");
  const obj = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(obj.data)) throw badResponse("data is not an array");
  return {
    receivedAt,
    accounts: obj.data.map((entry, index) => parseQuotaAccount(entry, index)),
  };
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @returns {QuotaAccount}
 */
function parseQuotaAccount(raw, index) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw badResponse("a quota account is not an object");
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  for (const name of ["provider", "name", "kind"]) {
    if (typeof obj[name] !== "string" || obj[name] === "") {
      throw badResponse(`a quota account has no ${name}`);
    }
  }
  if (!Array.isArray(obj.windows)) throw badResponse(`quota account "${obj.name}" has no windows array`);
  const provider = /** @type {string} */ (obj.provider);
  const name = /** @type {string} */ (obj.name);
  const kind = /** @type {string} */ (obj.kind);
  const user = optionalString(obj.user);
  const windows = obj.windows.map((entry) => parseQuotaWindow(entry, name));
  let pressure = null;
  let worst = null;
  for (const window of windows) {
    if (window.unlimited || window.remaining === null) continue;
    if (pressure === null || window.remaining < pressure) {
      pressure = window.remaining;
      worst = window;
    }
  }
  return {
    id: `${provider}:${user}:${index}`,
    provider, name, kind,
    plan: optionalString(obj.plan),
    user,
    balance: optionalString(obj.balance),
    error: optionalString(obj.error),
    windows, pressure, worst,
    readAt: optionalString(obj.readAt),
  };
}

/**
 * @param {unknown} raw
 * @param {string} account
 * @returns {QuotaWindow}
 */
function parseQuotaWindow(raw, account) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw badResponse("a quota window is not an object");
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  if (typeof obj.name !== "string" || obj.name === "") {
    throw badResponse(`quota account "${account}" has a window with no name`);
  }
  const name = /** @type {string} */ (obj.name);
  const unlimited = obj.unlimited === true;
  const remaining = optionalFinite(obj.remaining);
  if (!unlimited && (remaining === null || remaining < 0 || remaining > 100)) {
    throw badResponse(`quota window "${name}" has no usable remaining value`);
  }
  return {
    name,
    used: optionalFinite(obj.used),
    remaining,
    unlimited,
    display: optionalString(obj.display),
    unit: optionalString(obj.unit),
    balance: optionalFinite(obj.balance),
    resetsAt: optionalString(obj.resetsAt),
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

/**
 * A first-token wait: whole milliseconds under a second, then seconds with a
 * decimal under ten. Rounding first keeps 999.6 ms reading "1.0 s", not
 * "1000 ms".
 *
 * @param {number} ms
 */
function formatTook(ms) {
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded} ms` : `${(rounded / 1000).toFixed(rounded < 10_000 ? 1 : 0)} s`;
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

/**
 * Date.parse is unreliable for nanosecond fractions here, so split the
 * fields by hand.
 *
 * @param {string} text
 */
function formatIsoTime(text) {
  if (text === "") return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (match === null) return text;
  const [, year, month, day, hour, minute, second, zone] = match;
  if (zone === undefined) return `${hour}:${minute}`;
  let offset = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), second === undefined ? 0 : Number(second));
  return formatTime(utc - offset * 60_000);
}

/** @param {number} value */
function formatQuotaPercent(value) {
  const fixed = value.toFixed(1);
  return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}%`;
}

/** @param {QuotaAccount} account */
function quotaValue(account) {
  return account.pressure === null ? "unlimited" : formatQuotaPercent(account.pressure);
}

/** @param {QuotaAccount[]} accounts */
function limitedAccounts(accounts) {
  return accounts
    .filter((account) => account.error === "" && account.pressure !== null)
    .sort((a, b) => (a.pressure ?? 0) - (b.pressure ?? 0));
}

/** @param {QuotaAccount[]} accounts */
function unlimitedAccounts(accounts) {
  return accounts.filter((account) => account.error === "" && account.pressure === null && account.windows.length > 0);
}

/** @param {QuotaAccount[]} accounts */
function balanceAccounts(accounts) {
  return accounts.filter((account) => account.error === "" && account.windows.length === 0 && account.balance !== "");
}

/** @param {QuotaAccount} account */
function quotaTooltip(account) {
  const lines = [account.name];
  if (account.plan !== "") lines.push(`Plan ${account.plan}`);
  if (account.user !== "") lines.push(`User ${account.user}`);
  for (const window of account.windows) {
    const amount = window.display !== ""
      ? window.display
      : window.unlimited
        ? "unlimited"
        : window.remaining !== null
          ? formatQuotaPercent(window.remaining)
          : "";
    const reset = window.resetsAt !== "" ? ` · resets ${formatIsoTime(window.resetsAt)}` : "";
    lines.push(amount === "" ? `${window.name}${reset}` : `${window.name} · ${amount}${reset}`);
  }
  if (account.readAt !== "") lines.push(`Read at ${formatIsoTime(account.readAt)}`);
  if (account.error !== "") lines.push(account.error);
  return lines.join("\n");
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

    /** @type {"file" | "key"} */
    this.addKind = "file";

    // InputState needs a live host call, so the add-form states are made once
    // here and only re-filled when the form opens.
    this.nameState = InputState.new();
    this.pathState = InputState.new();
    this.urlState = InputState.new();
    this.keyState = InputState.new();
    this.keyState.set_masked(true);

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
   *
   * @param {InstanceId} id
   */
  runtimeFor(id) {
    let runtime = this.runtimes.get(id);
    if (runtime === undefined) {
      runtime = { states: new Map(), inFlight: new Set(), quota: { kind: "loading" }, quotaInFlight: false };
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
   *
   * @param {import("gpui-kit").Context} cx
   */
  refreshVisible(cx) {
    for (const instance of this.instances()) {
      this.refresh(cx, instance, this.periodFor(instance.id), false);
      this.refreshQuota(cx, instance, false);
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
    const instance = this.selectedInstance();
    this.refresh(cx, instance, this.selectedPeriod(), false);
    this.refreshQuota(cx, instance, false);
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
   *
   * @param {GatewayInstance} instance
   * @param {boolean} force
   */
  refreshQuota(cx, instance, force) {
    const runtime = this.runtimeFor(instance.id);
    if (runtime.quotaInFlight) return;
    const current = runtime.quota;
    if (!force && current.kind === "ready" && Date.now() - current.snapshot.receivedAt < REFRESH_MS) return;
    runtime.quotaInFlight = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let next;
      try {
        next = { kind: "ready", snapshot: await loadQuota(instance) };
      } catch (error) {
        const problem = asProblem(error);
        const existing = runtime.quota;
        next = existing.kind === "ready" || existing.kind === "stale"
          ? { kind: "stale", snapshot: existing.snapshot, problem }
          : { kind: "unavailable", problem };
      } finally {
        runtime.quota = next;
        runtime.quotaInFlight = false;
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

  showAdd(cx) {
    this.picker = "add";
    this.addKind = "file";
    this.addProblem = null;
    const taken = new Set(this.registry.additional.map((entry) => entry.name.toLowerCase()));
    let n = this.registry.additional.length + 2;
    while (taken.has(`magpie-${n}`)) n++;
    this.nameState.set_value(`magpie-${n}`);
    this.pathState.set_value(`~/.config/magpie/gateway-${n}.json`);
    this.urlState.set_value("http://127.0.0.1:3425");
    this.keyState.set_value("");
    cx.notify();
  }

  /**
   *
   * @param {"file" | "key"} kind
   */
  selectAddKind(cx, kind) {
    if (kind === this.addKind) return;
    this.addKind = kind;
    this.addProblem = null;
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
      const name = this.nameState.value();
      const instance = this.addKind === "key"
        ? parseKeyInstanceDraft(name, this.urlState.value(), this.keyState.value())
        : parseInstanceDraft(name, this.pathState.value());
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
    const quota = runtime.quota;
    if (this.width < RAIL_WIDTH) return this.renderRail(instance, state, t);
    const tier = tierOf(this.width);
    const busy = runtime.inFlight.has(this.periodFor(instance.id));
    const status = statusOf(state, t);
    const column = v_flex().min_h(0).h_full().w_full()
      .max_w(tier === "wide" ? CONTENT_WIDTH : COLUMN_WIDTH)
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
          .on_click((_e, cx) => {
            this.refresh(cx, this.selectedInstance(), this.selectedPeriod(), true);
            this.refreshQuota(cx, this.selectedInstance(), true);
          })))
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
      .child(this.renderBody(state, quota, tier, t));
    return v_flex().id("magpie-stats").size_full().min_h(0).overflow_hidden().items_center()
      .bg(t.chrome).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => {
        const width = size.width;
        if (width !== this.width) { this.width = width; cx.notify(); }
      })
      .child(column);
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
   *
   * @param {*} t
   */
  renderAddForm(t) {
    const kinds = /** @type {const} */ ([
      { id: "file", label: "Address file" },
      { id: "key", label: "URL + key" },
    ]);
    return v_flex().id("magpie-add").flex_none().px(0).pb(4).gap(6)
      .child(h_flex().flex_none().gap(2)
        .children(kinds.map((option) => {
          const selected = option.id === this.addKind;
          return div().id(`magpie-add-kind-${option.id}`).flex_1().h(20).flex().items_center().justify_center().rounded(5)
            .text_size(11).cursor_pointer()
            .bg(selected ? t.raised : "#00000000")
            .text_color(selected ? t.foreground : t.muted)
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.selectAddKind(cx, option.id))
            .child(option.label);
        })))
      .child(v_flex().flex_none().gap(3)
        .child(div().text_size(11).text_color(t.dim).child("Name"))
        .child(Input.new(this.nameState).h(22).px(6).rounded(5).border_1().border_color(t.border).bg(t.raised)
          .text_size(11).text_color(t.foreground)))
      .when(this.addKind === "file", (e) => e
        .child(v_flex().flex_none().gap(3)
          .child(div().text_size(11).text_color(t.dim).child("Address file"))
          .child(Input.new(this.pathState).h(22).px(6).rounded(5).border_1().border_color(t.border).bg(t.raised)
            .text_size(11).text_color(t.foreground))))
      .when(this.addKind === "key", (e) => e
        .child(v_flex().flex_none().gap(3)
          .child(div().text_size(11).text_color(t.dim).child("URL"))
          .child(Input.new(this.urlState).h(22).px(6).rounded(5).border_1().border_color(t.border).bg(t.raised)
            .text_size(11).text_color(t.foreground)))
        .child(v_flex().flex_none().gap(3)
          .child(div().text_size(11).text_color(t.dim).child("API key"))
          .child(Input.new(this.keyState).h(22).px(6).rounded(5).border_1().border_color(t.border).bg(t.raised)
            .text_size(11).text_color(t.foreground))))
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
        .on_click((_e, cx) => {
          this.refresh(cx, this.selectedInstance(), this.selectedPeriod(), true);
          this.refreshQuota(cx, this.selectedInstance(), true);
        })
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
   * @param {QuotaState} quota
   * @param {"narrow" | "medium" | "wide"} tier
   */
  renderBody(state, quota, tier, t) {
    if (state.kind === "loading") {
      return div().flex_1().min_h(0).px(10).pt(8).text_color(t.dim).child("Reading Magpie usage…");
    }
    if (state.kind === "unavailable") {
      const copy = problemCopy(state.problem);
      return v_flex().flex_1().min_h(0).px(10).pt(10).gap(4)
        .child(div().font_medium().text_color(t.foreground).child(copy.title))
        .child(div().text_size(11).text_color(t.dim).tooltip(state.problem.detail).child(copy.body));
    }
    const content = this.renderSnapshot(state.snapshot, quota, tier);
    if (state.kind !== "stale") return content;
    return v_flex().flex_1().min_h(0)
      .child(content)
      .child(h_flex().flex_none().px(10).py(4).text_size(11).text_color(t.dim)
        .tooltip(problemCopy(state.problem).body)
        .child(`Can't refresh · updated ${formatTime(state.snapshot.receivedAt)}`));
  }

  /**
   * The Overview: cost, tiles, chart and the four lists. Wide splits it into
   * two columns; narrow and medium keep one, in the page's order.
   *
   * @param {UsagePageSnapshot} snapshot
   * @param {QuotaState} quota
   * @param {"narrow" | "medium" | "wide"} tier
   */
  renderSnapshot(snapshot, quota, tier) {
    const cost = this.renderCost(snapshot.totals);
    const kpis = this.renderKpis(snapshot.totals, tier);
    const chart = this.renderChart(snapshot.chart, tier);
    const allowances = this.renderAllowances(quota, tier);
    const scroll = v_flex().id("magpie-snapshot").w_full().flex_1().min_h(0).overflow_y_scroll().items_center();

    if (tier === "wide") {
      const left = [cost, kpis, chart];
      if (snapshot.agents.length > 0) left.push(this.renderRows("Agents", "agents", snapshot.agents, tier));
      const right = [];
      if (allowances !== null) right.push(allowances);
      if (snapshot.models.length > 0) right.push(this.renderRows("Models", "models", snapshot.models, tier));
      if (snapshot.accounts.length > 0) right.push(this.renderRows("Accounts", "accounts", snapshot.accounts, tier));
      if (snapshot.keys.length > 0) right.push(this.renderRows("Gateway keys", "gateway-keys", snapshot.keys, tier));
      return scroll.child(h_flex().flex_none().w_full().max_w(CONTENT_WIDTH).gap(COLUMN_GAP).items_start()
        .child(v_flex().flex_1().min_w(0).max_w(COLUMN_WIDTH).children(left))
        .child(v_flex().flex_1().min_w(0).max_w(COLUMN_WIDTH).children(right)));
    }

    const sections = [cost];
    if (allowances !== null) sections.push(allowances);
    sections.push(kpis, chart);
    if (snapshot.agents.length > 0) sections.push(this.renderRows("Agents", "agents", snapshot.agents, tier));
    if (snapshot.models.length > 0) sections.push(this.renderRows("Models", "models", snapshot.models, tier));
    if (snapshot.accounts.length > 0) sections.push(this.renderRows("Accounts", "accounts", snapshot.accounts, tier));
    if (snapshot.keys.length > 0) sections.push(this.renderRows("Gateway keys", "gateway-keys", snapshot.keys, tier));
    return scroll.child(v_flex().flex_none().w_full().max_w(COLUMN_WIDTH).children(sections));
  }

  /**
   * The period's cost at effective prices, or the count that has none beside
   * it, so a total never reads as if those cost nothing.
   *
   * @param {Totals} totals
   */
  renderCost(totals) {
    const t = theme();
    const unpriced = totals.unpriced;
    const note = unpriced > 0
      ? `${formatInt(unpriced)} ${unpriced === 1 ? "call" : "calls"} unpriced`
      : "effective prices";
    const tooltip = unpriced > 0
      ? `${formatInt(unpriced)} ${unpriced === 1 ? "call had" : "calls had"} no known price and ${unpriced === 1 ? "is" : "are"} not counted`
      : "Estimated at effective model prices. A model's price at one provider is set in that provider's Model settings and counts over its list price";
    return h_flex().id("magpie-cost").flex_none().px(10).pt(6).gap(6).items_end().flex_wrap()
      .child(div().text_size(17).font_semibold().child(`≈${formatCost(totals.cost)}`))
      .child(div().text_size(11).pb(1).text_color(t.dim).tooltip(tooltip).child(note));
  }

  /**
   * Four tiles: tokens, cache read, reasoning, calls. Narrow stacks them two
   * by two; medium and wide keep one row.
   *
   * @param {Totals} totals
   * @param {"narrow" | "medium" | "wide"} tier
   */
  renderKpis(totals, tier) {
    const t = theme();
    const tokens = totals.input + totals.output;
    const prompt = tokens + totals.cacheRead + totals.cacheWrite;
    const hit = totals.cacheRead > 0 && prompt > 0 ? totals.cacheRead / prompt : null;
    const failed = [
      totals.errors > 0 ? `${formatInt(totals.errors)} failed` : "",
      totals.retried > 0 ? `${formatInt(totals.retried)} retried` : "",
      totals.canceled > 0 ? `${formatInt(totals.canceled)} canceled` : "",
      totals.unpriced > 0 ? `${formatInt(totals.unpriced)} unpriced` : "",
    ].filter(Boolean).join(" · ");
    const cacheTooltip = [
      `Cache written ${formatTokens(totals.cacheWrite)} (${formatInt(totals.cacheWrite)})`,
      `Reasoning ${formatTokens(totals.reasoning)} (${formatInt(totals.reasoning)})`,
    ].join("\n");
    const unpricedTooltip = totals.unpriced > 0
      ? `${formatInt(totals.unpriced)} ${totals.unpriced === 1 ? "call had" : "calls had"} no known price and ${totals.unpriced === 1 ? "is" : "are"} not counted`
      : "";
    const tile = (id, value, label, sub, tooltip) => v_flex().id(id).flex_1().min_w(0).p(8).gap(1).bg(t.raised)
      .when(tooltip !== "", (e) => e.tooltip(tooltip))
      .child(div().text_size(16).font_semibold().truncate().child(value))
      .child(div().text_size(10).text_color(t.muted).child(label))
      .when(sub !== "", (e) => e.child(div().text_size(10).text_color(t.dim).whitespace_normal().child(sub)));
    const tiles = [
      tile("magpie-kpi-tokens", formatTokens(tokens), "tokens", `${formatTokens(totals.input)} in · ${formatTokens(totals.output)} out`, ""),
      tile("magpie-kpi-cache", formatTokens(totals.cacheRead), "cache read", hit === null ? "" : `hit rate ${formatPercent(hit)}`, cacheTooltip),
      tile("magpie-kpi-reasoning", formatTokens(totals.reasoning), "reasoning", "inside output", ""),
      tile("magpie-kpi-calls", formatInt(totals.calls), "calls", failed, unpricedTooltip),
    ];
    const grid = v_flex().flex_none().w_full().gap(1).bg(t.border).border_1().border_color(t.border).rounded(8).overflow_hidden();
    if (tier === "narrow") {
      return v_flex().flex_none().px(10).pt(8)
        .child(grid.child(h_flex().gap(1).children(tiles.slice(0, 2))).child(h_flex().gap(1).children(tiles.slice(2))));
    }
    return v_flex().flex_none().px(10).pt(8).child(grid.child(h_flex().gap(1).children(tiles)));
  }

  /**
   * The chart: input stacked under output, scaled by tokens. The height
   * follows the tier; a nonzero bar is at least 2px. No SVG, canvas, or
   * animation timer.
   *
   * @param {Chart} chart
   * @param {"narrow" | "medium" | "wide"} tier
   */
  renderChart(chart, tier) {
    const t = theme();
    const height = tier === "narrow" ? 32 : tier === "medium" ? 56 : 72;
    const peak = chart.points.reduce((max, point) => Math.max(max, point.input + point.output), 0);
    const every = chart.points.length <= 8 ? 1 : Math.ceil(chart.points.length / 6);
    const empty = chart.points.length === 0 || peak === 0;
    const bars = h_flex().id("magpie-chart").w_full().h(height).items_end().gap(1)
      .when(empty, (e) => e.items_center().justify_center().text_size(11).text_color(t.dim).child("No calls in this period"))
      .when(!empty, (e) => e.children(chart.points.map((point) => {
        const tokens = point.input + point.output;
        const barHeight = tokens <= 0 ? 0 : Math.max(2, Math.round((tokens / peak) * height));
        const outputHeight = tokens <= 0 ? 0 : Math.round((point.output / tokens) * barHeight);
        const inputHeight = barHeight - outputHeight;
        return div().id(`magpie-bar-${point.key}`).flex_1().min_w(0).h(height).flex().items_end()
          .when(barHeight > 0, (e) => e.child(v_flex().w_full().h(barHeight).flex_none().rounded(1).overflow_hidden()
            .when(outputHeight > 0, (x) => x.child(div().w_full().h(outputHeight).flex_none().bg(t.accent)))
            .when(inputHeight > 0, (x) => x.child(div().w_full().h(inputHeight).flex_none().bg(t.accent).opacity(0.38)))))
          .tooltip(pointTooltip(point, chart.bucket));
      })));
    return v_flex().flex_none().px(10).pt(8)
      .child(v_flex().flex_none().w_full().gap(3).p(8).rounded(8).border_1().border_color(t.border).bg(t.raised)
        .when(!empty, (e) => e.child(h_flex().w_full().items_end().justify_end()
          .child(div().text_size(10).text_color(t.dim).child(formatTokens(peak)))))
        .child(bars)
        .when(!empty, (e) => e.child(h_flex().w_full().gap(1)
          .children(chart.points.map((point, i) => div().flex_1().min_w(0).text_size(9).text_color(t.dim)
            .whitespace_nowrap().child(i % every === 0 ? point.label : "")))))
        .when(chart.truncated, (e) => e.child(div().text_size(10).text_color(t.dim)
          .child(`Calls by ${chart.bucket} · last ${CHART_LIMIT}`))));
  }

  /**
   * The allowances: a card per account, two per row, at medium and wide; the
   * compact rows in narrow. Loading and an empty payload draw nothing, and a
   * refused account keeps its one line.
   *
   * @param {QuotaState} quota
   * @param {"narrow" | "medium" | "wide"} tier
   */
  renderAllowances(quota, tier) {
    const t = theme();
    if (quota.kind === "loading") return null;
    if (quota.kind === "unavailable") {
      return div().px(10).pt(8).text_size(11).text_color(t.dim)
        .tooltip(problemCopy(quota.problem).body)
        .child("Quota unavailable");
    }
    const accounts = quota.snapshot.accounts;
    if (accounts.length === 0) return null;
    const title = div().pb(2).text_size(11).font_medium().text_color(t.dim)
      .when(quota.kind === "stale", (e) => e.tooltip(problemCopy(quota.problem).body))
      .child(quota.kind === "stale" ? "Allowances · stale" : "Allowances");
    if (tier === "narrow") {
      return v_flex().flex_none().px(10).pt(8).child(title).children(this.renderQuotaRows(accounts));
    }
    const cards = accounts.filter((account) => account.error === "");
    const errored = accounts.filter((account) => account.error !== "");
    const rows = [];
    for (let i = 0; i < cards.length; i += 2) {
      rows.push(h_flex().flex_none().w_full().gap(8).items_start()
        .child(this.renderQuotaCard(cards[i]))
        .child(i + 1 < cards.length ? this.renderQuotaCard(cards[i + 1]) : div().flex_1()));
    }
    return v_flex().flex_none().px(10).pt(8)
      .child(title)
      .when(rows.length > 0, (e) => e.child(v_flex().flex_none().w_full().gap(8).children(rows)))
      .when(errored.length > 0, (e) => e.child(this.renderQuotaErrors(errored)));
  }

  /** @param {QuotaAccount} account */
  renderQuotaCard(account) {
    const t = theme();
    const head = [account.plan, account.user].filter((part) => part !== "").join(" · ");
    return v_flex().id(`magpie-quota-card-${account.id}`).flex_1().min_w(0).gap(3).p(8)
      .rounded(8).border_1().border_color(t.border).bg(t.raised)
      .tooltip(quotaTooltip(account))
      .child(div().font_medium().truncate().text_color(t.foreground).child(account.name))
      .when(head !== "", (e) => e.child(div().text_size(10).text_color(t.dim).truncate().child(head)))
      .children(account.windows.map((window) => this.renderQuotaWindowLine(window)))
      .when(account.balance !== "", (e) => e.child(div().text_size(10).text_color(t.muted).child(account.balance)));
  }

  /** @param {QuotaWindow} window */
  renderQuotaWindowLine(window) {
    const t = theme();
    const remaining = window.unlimited || window.remaining === null ? 100 : window.remaining;
    const color = window.unlimited || window.remaining === null ? t.muted
      : window.remaining < 10 ? t.blocked
      : window.remaining < 30 ? t.idle
      : t.muted;
    const reset = window.resetsAt === "" ? "" : `resets ${formatIsoTime(window.resetsAt)}`;
    return v_flex().flex_none().w_full().gap(2).pb(2)
      .child(h_flex().w_full().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.muted).child(window.name))
        .child(div().flex_none().text_size(10).text_color(color)
          .child(window.unlimited ? "unlimited" : formatQuotaPercent(remaining)))
        .when(reset !== "", (e) => e.child(div().flex_none().text_size(9).text_color(t.dim).child(reset))))
      .child(div().h(3).w_full().rounded(2).bg(t.hover).overflow_hidden()
        .child(div().h_full().rounded(2).bg(t.accent).opacity(0.7)
          .w(`${Math.max(1.5, Math.min(100, remaining)).toFixed(1)}%`)));
  }

  /**
   * The compact rows narrow keeps: the accounts nearest their limit, the
   * unlimited ones, then balances and any refused account.
   *
   * @param {QuotaAccount[]} accounts
   */
  renderQuotaRows(accounts) {
    const t = theme();
    const limited = limitedAccounts(accounts);
    const unlimited = unlimitedAccounts(accounts);
    const balances = balanceAccounts(accounts);
    const errored = accounts.filter((account) => account.error !== "");
    const rows = [...limited, ...unlimited].slice(0, QUOTA_LIMIT);
    const hidden = limited.length + unlimited.length - rows.length;
    const lines = rows.map((account) => {
      const color = account.pressure === null ? t.muted
        : account.pressure < 10 ? t.blocked
        : account.pressure < 30 ? t.idle
        : t.muted;
      return h_flex().id(`magpie-quota-${account.id}`).h(18).gap(6).items_center()
        .tooltip(quotaTooltip(account))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(account.name))
        .child(div().flex_none().text_size(11).text_color(color).child(quotaValue(account)));
    });
    if (hidden > 0) {
      lines.push(div().text_size(11).text_color(t.dim).child(`+ ${hidden} more`));
    }
    if (balances.length > 0) {
      lines.push(h_flex().id("magpie-quota-balances").h(18).gap(6).items_center().text_size(11)
        .tooltip(balances.map((account) => `${account.name}${account.user === "" ? "" : ` · ${account.user}`}: ${account.balance}`).join("\n"))
        .child(div().flex_none().text_color(t.dim).child("Balance"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted)
          .child(balances.map((account) => account.user === "" ? account.balance : `${account.user} ${account.balance}`).join(" · "))));
    }
    if (errored.length > 0) lines.push(this.renderQuotaErrors(errored));
    return lines;
  }

  /** @param {QuotaAccount[]} errored */
  renderQuotaErrors(errored) {
    const t = theme();
    return h_flex().id("magpie-quota-error").flex_none().w_full().h(18).gap(6).items_center().text_size(11)
      .tooltip(errored.map((account) => `${account.name}: ${account.error}`).join("\n"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.blocked).child(`${errored[0].name} · ${errored[0].error}`))
      .when(errored.length > 1, (e) => e.child(div().flex_none().text_color(t.dim).child(`+ ${errored.length - 1}`)));
  }

  /**
   * One titled list. Rows keep the server's order and open nothing.
   *
   * @param {string} title
   * @param {string} slug
   * @param {UsageRow[]} rows
   * @param {"narrow" | "medium" | "wide"} tier
   */
  renderRows(title, slug, rows, tier) {
    const t = theme();
    return v_flex().flex_none().w_full().px(10).pt(8)
      .child(div().pb(4).text_size(11).font_medium().text_color(t.dim).child(title))
      .children(rows.map((row, i) => this.renderRow(slug, i, row, tier)));
  }

  /**
   * One usage row. Medium and wide put a wrapped sub-line under the name
   * beside the share bar, the tokens and the cost; narrow stacks the name and
   * cost over the sub-line, the bar and the token count.
   *
   * @param {string} slug
   * @param {number} index
   * @param {UsageRow} row
   * @param {"narrow" | "medium" | "wide"} tier
   */
  renderRow(slug, index, row, tier) {
    const t = theme();
    const sub = rowSubLine(row);
    const tooltip = rowTooltip(row);
    if (tier === "narrow") {
      return v_flex().id(`magpie-${slug}-${index}`).flex_none().w_full().py(4).gap(2).tooltip(tooltip)
        .child(h_flex().w_full().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().child(row.name))
          .child(div().flex_none().text_size(11).text_color(t.ansi2).child(formatCost(row.cost))))
        .when(sub !== "", (e) => e.child(div().text_size(10).text_color(t.muted).whitespace_normal().child(sub)))
        .child(h_flex().w_full().gap(6).items_center()
          .child(this.renderShareBar(row, 2, null))
          .child(div().flex_none().text_size(10).text_color(t.muted).child(formatTokens(row.tokens))));
    }
    return h_flex().id(`magpie-${slug}-${index}`).flex_none().w_full().py(4).gap(8).items_center().tooltip(tooltip)
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().child(row.name))
        .when(sub !== "", (e) => e.child(div().text_size(10).text_color(t.muted).whitespace_normal().child(sub))))
      .child(this.renderShareBar(row, 4, 48))
      .child(v_flex().flex_none().items_end()
        .child(div().text_size(11).child(formatTokens(row.tokens)))
        .child(div().text_size(10).text_color(t.dim).child(tokenBreakdown(row))))
      .child(div().flex_none().w(52).text_right().text_size(11).text_color(t.ansi2).child(formatCost(row.cost)));
  }

  /**
   * @param {UsageRow} row
   * @param {number} height
   * @param {number | null} width null fills the row
   */
  renderShareBar(row, height, width) {
    const t = theme();
    const bar = v_flex().h(height).rounded(height / 2).bg(t.hover).overflow_hidden()
      .when(row.share > 0, (e) => e.child(div().h_full().rounded(height / 2).bg(t.accent).opacity(0.7)
        .w(`${Math.max(1.5, Math.min(100, row.share * 100)).toFixed(1)}%`)));
    return width === null ? bar.flex_1().min_w(0) : bar.flex_none().w(width);
  }
}

/**
 * The part list under a row's name, in the page's order: the provider, its
 * calls, failures, cancels, the mean first token, the decode speed, and the
 * calls magpie made by itself. A zero part is left out.
 *
 * @param {UsageRow} row
 */
function rowSubLine(row) {
  const parts = [];
  if (row.detail !== "") parts.push(row.detail);
  if (row.calls > 0) parts.push(`${formatInt(row.calls)} ${row.calls === 1 ? "call" : "calls"}`);
  if (row.errors > 0) parts.push(`${formatInt(row.errors)} failed`);
  if (row.loops > 0) parts.push(`${formatInt(row.loops)} looped`);
  if (row.retried > 0) parts.push(`${formatInt(row.retried)} retried`);
  if (row.canceled > 0) parts.push(`${formatInt(row.canceled)} canceled`);
  if (row.timed > 0) parts.push(`TTFT ${formatTook(row.ttftMs / row.timed)}`);
  if (row.decodeMs > 0 && row.decodeOut > 0) parts.push(`${formatInt((row.decodeOut / row.decodeMs) * 1000)} tok/s`);
  if (row.ownCalls > 0) parts.push(`${formatInt(row.ownCalls)} by magpie itself`);
  return parts.join(" · ");
}

/** @param {UsageRow} row */
function tokenBreakdown(row) {
  const parts = [`${formatTokens(row.input)} in`, `${formatTokens(row.output)} out`];
  if (row.cacheRead > 0) parts.push(`${formatTokens(row.cacheRead)} cached`);
  return parts.join(" · ");
}

/** @param {UsageRow} row */
function rowTooltip(row) {
  const lines = [row.detail === "" ? row.name : `${row.name} · ${row.detail}`];
  lines.push(`${formatInt(row.calls)} ${row.calls === 1 ? "call" : "calls"} · ${formatInt(row.errors)} failed · ${formatInt(row.canceled)} canceled`);
  if (row.loops > 0) lines.push(`${formatInt(row.loops)} looped`);
  if (row.retried > 0) lines.push(`${formatInt(row.retried)} answered on a retry`);
  if (row.timed > 0) lines.push(`First token ${formatTook(row.ttftMs / row.timed)} on average over ${formatInt(row.timed)} timed replies`);
  if (row.decodeMs > 0 && row.decodeOut > 0) {
    const speed = `${formatInt((row.decodeOut / row.decodeMs) * 1000)} tok/s`;
    lines.push(row.decodeN > 0 ? `${speed} over ${formatInt(row.decodeN)} replies` : speed);
  }
  lines.push(`${formatInt(row.tokens)} tokens (${formatInt(row.input)} in · ${formatInt(row.output)} out)`);
  if (row.cacheRead > 0 || row.cacheWrite > 0) {
    lines.push(`${formatInt(row.cacheRead)} cache read · ${formatInt(row.cacheWrite)} cache written`);
  }
  if (row.reasoning > 0) lines.push(`${formatInt(row.reasoning)} reasoning inside output`);
  if (row.unpriced > 0) lines.push(`${formatInt(row.unpriced)} unpriced`);
  lines.push(`${formatCost(row.cost)} · ${formatPercent(row.share)} of the period's tokens`);
  if (row.ownCalls > 0) lines.push(`${formatInt(row.ownCalls)} of these calls magpie made by itself`);
  return lines.join("\n");
}

/**
 * @param {ChartPoint} point
 * @param {"hour" | "day" | "week"} bucket
 */
function pointTooltip(point, bucket) {
  const when = bucket === "hour" ? `${point.label}:00` : bucket === "week" ? `week of ${point.label}` : point.label;
  const tokens = point.input + point.output;
  if (point.calls === 0 && tokens === 0) return `${when} · nothing`;
  const lines = [when, `${formatInt(tokens)} tokens`, `${formatInt(point.calls)} ${point.calls === 1 ? "call" : "calls"}`];
  if (point.cost > 0) lines.push(formatCost(point.cost));
  return lines.join("\n");
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
