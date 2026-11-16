import { View, div, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { home, appHome, readTextFile, writeTextFile, theme } from "herdr";
import { URL } from "url";

const REFRESH_MS = 30_000;
const CHART_LIMIT = 30;
const QUOTA_LEFT_KEY = "magpie-stats.quotaLeft";
const FOLDED_KEY = "magpie-stats.folded";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ICON_FILES = {
  kimi: "kimi.svg",
  "deepseek-color": "deepseek-color.svg",
  magpie: "magpie.svg",
  githubcopilot: "githubcopilot.svg",
  zcode: "zcode.png",
};

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
 *   id: string, name: string, detail: string, icon: string,
 *   calls: number, errors: number, retried: number, canceled: number, loops: number,
 *   cost: number, unpriced: number,
 *   input: number, output: number,
 *   cacheRead: number, cacheWrite: number, reasoning: number,
 *   credits: number, credited: number,
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
 *   period: Period, receivedAt: number, path: string, totals: Totals, chart: Chart,
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
 *   tokens: number, cost: number, priced: boolean, used: number,
 *   calls: number, routedTokens: number, cacheRead: number
 * }} QuotaHolds
 */

/**
 * @typedef {{
 *   name: string, used: number | null, remaining: number | null,
 *   amount: number, limit: number, unit: string,
 *   unlimited: boolean, text: boolean, display: string,
 *   balance: number | null, spent: number | null,
 *   resetsAt: string, runsOutAt: string, runsOut: number,
 *   holds: QuotaHolds | null, holdsWhy: string
 * }} QuotaWindow
 */

/**
 * `pressure` is the lowest remaining among finite, limited windows; `worst`
 * holds it. `lines` is the account's history, one entry per window name.
 * @typedef {{
 *   id: string, provider: string, name: string, kind: string,
 *   plan: string, user: string, alias: string, seat: string,
 *   balance: string, error: string, icon: string,
 *   until: string, renew: string, asOf: string, readAt: string,
 *   windows: QuotaWindow[], pressure: number | null, worst: QuotaWindow | null,
 *   lines: QuotaLine[]
 * }} QuotaAccount
 */

/**
 * One window's readings over time. Times are epoch milliseconds; start and
 * reset are null when the reading didn't carry them.
 * @typedef {{
 *   name: string,
 *   points: {at: number, left: number, start: number | null, reset: number | null}[]
 * }} QuotaLine
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
 * The snapshot plus the two optional reads. Cards carry the provider icons
 * and history the curves; either endpoint missing leaves the panel with no
 * icons or no curve, never an error state.
 *
 * @param {GatewayInstance} instance
 * @returns {Promise<QuotaSnapshot>}
 */
async function loadQuota(instance) {
  const { origin, headers } = await resolveGateway(instance);
  const url = `${origin}/v1/magpie/quotas`;
  const response = await fetch(url, headers ? { headers } : undefined);
  const problem = responseProblem(response, url);
  if (problem !== null) throw problem;
  const snapshot = parseQuota(await response.json(), Date.now());
  const [cards, history, remote] = await Promise.all([
    loadOptional(`${origin}/v1/magpie/quotas/cards`, headers),
    loadOptional(`${origin}/v1/magpie/quotas/history?days=45`, headers),
    loadRemoteHistories(snapshot),
  ]);
  return mergeQuotaExtras(snapshot, cards, history, remote);
}

/**
 * The histories of the remote magpies this computer's providers name, as
 * the Usage page's own read merges them: a gateway answers its own accounts'
 * history only, and a remote account's curve lives on that remote. Each
 * entry's provider gains the remote's id, the way magpie names them.
 *
 * @param {QuotaSnapshot} snapshot
 * @returns {Promise<unknown[]>}
 */
async function loadRemoteHistories(snapshot) {
  let text;
  try {
    text = await readTextFile(`${home()}/.config/magpie/providers.json`);
  } catch {
    return [];
  }
  if (text === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const providers = typeof parsed === "object" && parsed !== null && Array.isArray(parsed.providers) ? parsed.providers : [];
  const wanted = new Set(snapshot.accounts.map((a) => a.provider.split("/")[0]));
  const remotes = providers.filter((p) => typeof p === "object" && p !== null &&
    p.preset === "remote-magpie" && p.off !== true && typeof p.id === "string" && wanted.has(p.id) &&
    typeof p.key === "string" && p.key !== "" && typeof p.anthropic === "string" && /^https?:\/\//.test(p.anthropic));
  const lists = await Promise.all(remotes.map(async (p) => {
    const raw = await loadOptional(`${p.anthropic.replace(/\/$/, "")}/v1/magpie/quotas/history?days=45`, { Authorization: `Bearer ${p.key}` });
    const data = typeof raw === "object" && raw !== null && Array.isArray(/** @type {any} */ (raw).data) ? /** @type {any} */ (raw).data : [];
    return data.map((entry) => (typeof entry === "object" && entry !== null && typeof entry.provider === "string"
      ? { ...entry, provider: `${p.id}/${entry.provider}` }
      : entry));
  }));
  return lists.flat();
}

/**
 * A read the panel can do without: any failure, including a malformed
 * payload, answers null and the caller falls back.
 *
 * @param {string} url
 * @param {Record<string, string> | undefined} headers
 * @returns {Promise<unknown | null>}
 */
async function loadOptional(url, headers) {
  try {
    const response = await fetch(url, headers ? { headers } : undefined);
    if (responseProblem(response, url) !== null) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Fold the cards' icons and the history's lines into the snapshot by
 * provider and user. Both extras are optional data: a junk entry is skipped,
 * never thrown, so one bad card cannot take the allowances down.
 *
 * @param {QuotaSnapshot} snapshot
 * @param {unknown} cardsRaw
 * @param {unknown} historyRaw
 * @param {unknown[]} remoteHistories
 * @returns {QuotaSnapshot}
 */
function mergeQuotaExtras(snapshot, cardsRaw, historyRaw, remoteHistories = []) {
  const icons = new Map();
  if (typeof cardsRaw === "object" && cardsRaw !== null && Array.isArray(/** @type {any} */ (cardsRaw).data)) {
    for (const entry of /** @type {any} */ (cardsRaw).data) {
      if (typeof entry !== "object" || entry === null) continue;
      if (typeof entry.provider !== "string" || typeof entry.icon !== "string") continue;
      icons.set(`${entry.provider}\n${optionalString(entry.user).toLowerCase()}`, entry.icon);
    }
  }
  const lines = new Map();
  const addHistory = (entry) => {
    if (typeof entry !== "object" || entry === null || typeof entry.provider !== "string") return;
    const parsed = [];
    for (const line of Array.isArray(entry.lines) ? entry.lines : []) {
      if (typeof line !== "object" || line === null || typeof line.name !== "string" || !Array.isArray(line.points)) continue;
      const points = [];
      for (const point of line.points) {
        if (typeof point !== "object" || point === null) continue;
        const at = parseTime(point.at);
        const left = optionalFinite(point.left);
        if (at === null || left === null) continue;
        points.push({ at, left, start: parseTime(point.start), reset: parseTime(point.resetsAt) });
      }
      if (points.length > 0) parsed.push({ name: line.name, points });
    }
    if (parsed.length > 0) lines.set(`${entry.provider}\n${optionalString(entry.user).toLowerCase()}`, parsed);
  };
  if (typeof historyRaw === "object" && historyRaw !== null && Array.isArray(/** @type {any} */ (historyRaw).data)) {
    for (const entry of /** @type {any} */ (historyRaw).data) addHistory(entry);
  }
  for (const entry of remoteHistories) addHistory(entry);
  for (const account of snapshot.accounts) {
    const key = `${account.provider}\n${account.user.toLowerCase()}`;
    account.icon = icons.get(key) ?? "";
    account.lines = lines.get(key) ?? [];
  }
  return snapshot;
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
  return { period, receivedAt, path: optionalString(obj.path), totals, chart, agents, models, accounts, keys };
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
    icon: optionalString(obj.icon),
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
    credits: optionalNumber(obj, "credits"),
    credited: optionalNumber(obj, "credited"),
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
    alias: optionalString(obj.alias),
    seat: optionalString(obj.seat),
    balance: optionalString(obj.balance),
    error: optionalString(obj.error),
    icon: "",
    until: optionalString(obj.until),
    renew: optionalString(obj.renew),
    asOf: optionalString(obj.asOf),
    readAt: optionalString(obj.readAt),
    windows, pressure, worst,
    lines: [],
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
    amount: optionalNumber(obj, "amount"),
    limit: optionalNumber(obj, "limit"),
    unit: optionalString(obj.unit),
    unlimited,
    text: obj.text === true,
    display: optionalString(obj.display),
    balance: optionalFinite(obj.balance),
    spent: optionalFinite(obj.spent),
    resetsAt: optionalString(obj.resetsAt),
    runsOutAt: optionalString(obj.runsOutAt),
    runsOut: optionalNumber(obj, "runsOut"),
    holds: parseHolds(obj.holds),
    holdsWhy: optionalString(obj.holdsWhy),
  };
}

/**
 * A window's whole-window estimate, or null when the gateway left it out.
 * A malformed holds object reads as null rather than a bad answer: the
 * figure is an estimate the panel can do without.
 *
 * @param {unknown} raw
 * @returns {QuotaHolds | null}
 */
function parseHolds(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const tokens = optionalFinite(obj.tokens);
  if (tokens === null) return null;
  const routed = typeof obj.routed === "object" && obj.routed !== null ? /** @type {Record<string, unknown>} */ (obj.routed) : {};
  return {
    tokens,
    cost: optionalFinite(obj.cost) ?? 0,
    priced: obj.priced === true,
    used: optionalFinite(obj.used) ?? 0,
    calls: optionalNumber(routed, "calls"),
    routedTokens: optionalNumber(routed, "tokens"),
    cacheRead: optionalNumber(routed, "cacheRead"),
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

/** Format grouped USD with exactly two decimals, such as "$509.40". @param {number} value */
function formatCost(value) {
  return `$${group(value.toFixed(2))}`;
}

/**
 * A cost as the Usage page's rows say it: at least two decimals, three under
 * a dollar, a sub-mill amount to its first two digits, and a trailing + when
 * some calls had no price. Nothing priced and nothing known is no figure,
 * not $0.000.
 *
 * @param {number} value
 * @param {number} unpriced
 */
function formatRowCost(value, unpriced) {
  if (value === 0 && unpriced > 0) return "";
  const digits = value >= 1 ? 2 : value > 0 && value < 1e-3 ? 1 - Math.floor(Math.log10(value)) : 3;
  return `≈$${group(value.toFixed(digits))}${unpriced > 0 ? "+" : ""}`;
}

/**
 * A token count as the page's tiles and rows say it: one decimal below ten
 * of a unit, none above, B past a billion.
 *
 * @param {number} value
 */
function formatN(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e7) return `${Math.round(value / 1e6)}M`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e5) return `${Math.round(value / 1e3)}K`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.floor(value));
}

/**
 * A window's own count, "576 / 28,000" with its unit, used or left as the
 * toggle says; the vendor's display when there is no limit to count against.
 *
 * @param {QuotaWindow} window
 * @param {boolean} left
 */
function quotaCount(window, left) {
  if (!(window.limit > 0)) return window.display;
  const n = left ? Math.max(0, window.limit - window.amount) : window.amount;
  return `${group(String(n))} / ${group(String(window.limit))}${window.unit === "" ? "" : ` ${window.unit}`}`;
}

/**
 * A window's figure: its count and share, the share alone, "Unlimited", a
 * wallet's balance, or the vendor's own text.
 *
 * @param {QuotaWindow} window
 * @param {boolean} left
 */
function quotaText(window, left) {
  if (window.unlimited) return "Unlimited";
  if (window.balance !== null) return `${group(String(window.balance))}${window.unit === "" ? "" : ` ${window.unit}`} left`;
  if (window.text && window.used !== null && window.used >= 100) return "In use";
  if (window.text || window.used === null || window.balance !== null) return window.display === "" ? "No allowance reported" : window.display;
  const used = clamp100(window.used);
  const n = left ? 100 - used : used;
  const pct = `${Number.isInteger(n) ? n : n.toFixed(1)}% ${left ? "left" : "used"}`;
  const count = quotaCount(window, left);
  return count === "" ? pct : `${count} · ${pct}`;
}

/** @param {number} value */
function clamp100(value) {
  return Math.max(0, Math.min(100, value));
}

/**
 * The fill's width: used, or what is left of it, as the toggle says.
 *
 * @param {QuotaWindow} window
 * @param {boolean} left
 */
function quotaFill(window, left) {
  if (window.used === null) return 0;
  const used = Math.round(clamp100(window.used));
  return left ? 100 - used : used;
}

/**
 * A window's distance from an even pace through it, in points; null without
 * a known start and reset. Over means more used than an even pace would have
 * used by now.
 *
 * @param {QuotaWindow} window
 * @param {number | null} start
 * @param {boolean} left
 * @param {number} now
 * @returns {{n: number, over: boolean} | null}
 */
function quotaPace(window, start, left, now) {
  if (window.unlimited || window.text || window.used === null || window.balance !== null) return null;
  const reset = parseTime(window.resetsAt);
  if (start === null || reset === null || !(reset > start) || now < start || now >= reset) return null;
  const d = clamp100(window.used) - (100 * (now - start)) / (reset - start);
  const n = Math.round(left ? -d : d);
  return { n, over: Math.round(d) > 0 };
}

/** @param {number} n */
function paceNumber(n) {
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)}%`;
}

/**
 * "14:30", "tomorrow 09:00", "Thu 14:30", else "Oct 12 08:05", by hand
 * because the runtime carries no Intl data.
 *
 * @param {number} at
 * @param {number} now
 */
function resetClock(at, now) {
  const d = new Date(at), n = new Date(now);
  const time = formatTime(at);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(n)) / 864e5);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days <= 6 - ((n.getDay() + 6) % 7)) return `${WEEKDAYS[d.getDay()]} ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

/** @param {number} at */
function untilText(at) {
  if (at <= Date.now()) return "Reset time passed";
  const mins = Math.max(1, Math.round((at - Date.now()) / 60000));
  if (mins < 60) return `in ${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/**
 * A plan's paid end: "Renews Aug 27", "Expires Dec 28", or "Until Nov 30"
 * when the vendor doesn't say which.
 *
 * @param {QuotaAccount} account
 */
function planTerm(account) {
  const at = parseTime(account.until);
  if (at === null) return "";
  const d = new Date(at);
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${account.renew === "auto" ? "Renews" : account.renew === "off" ? "Expires" : "Until"} ${date}`;
}

/** @param {QuotaAccount} account */
function planSpanText(account) {
  return [account.plan, planTerm(account)].filter((part) => part !== "").join(" · ");
}

/**
 * How long ago a reading was taken, "just now" under a minute.
 *
 * @param {number} at
 */
function agoText(at) {
  const sec = Math.max(0, (Date.now() - at) / 1000);
  for (const [unit, n] of /** @type {const} */ ([["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]])) {
    if (sec >= n) {
      const v = Math.round(sec / n);
      return `${v} ${unit}${v === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

/**
 * An ISO timestamp as epoch milliseconds, or null. The hand-split parse
 * keeps nanosecond fractions and numeric zones working where Date.parse
 * is unreliable in this runtime.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseTime(value) {
  if (typeof value !== "string" || value === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (match === null) {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
  }
  const [, year, month, day, hour, minute, second, zone] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), second === undefined ? 0 : Number(second));
  if (zone === undefined) return utc - new Date(utc).getTimezoneOffset() * 60_000;
  if (zone === "Z") return utc;
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  return utc - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
}

/**
 * A curve's axis time: the clock on the same day, the date and clock
 * otherwise, "Now" within a minute.
 *
 * @param {number} at
 * @param {number} now
 */
function curveTimeText(at, now) {
  if (Math.abs(at - now) < 60e3) return "Now";
  const d = new Date(at), n = new Date(now);
  const time = formatTime(at);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return time;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

/**
 * The current cycle of one window's line: its start from the newest
 * reading, its reset from the window itself, shifted along when the window
 * has rolled since that reading.
 *
 * @param {QuotaLine} line
 * @param {QuotaWindow} window
 * @param {number} now
 * @returns {{start: number, reset: number | null}}
 */
function windowCycle(line, window, now) {
  const last = line.points[line.points.length - 1];
  let reset = parseTime(window.resetsAt) ?? last.reset;
  let start = last.start;
  if (start !== null && last.reset !== null && reset !== null) start += reset - last.reset;
  if (start === null) start = last.at;
  if (reset !== null && reset <= now) reset = null;
  return { start: Math.min(start, now), reset };
}

/**
 * The readings since the last refill, fitted to a line and carried to zero:
 * when the window empties at this pace, and whether that is past its reset.
 * Null with under three readings, an hour of them, or nothing left.
 *
 * @param {{at: number, left: number}[]} points
 * @param {number} start
 * @param {number | null} reset
 * @param {number} now
 * @returns {{out: number | null, lasts: boolean} | null}
 */
function curveEta(points, start, reset, now) {
  if (reset !== null && reset <= now) return null;
  const cycle = points.filter((p) => p.at >= start && p.at <= now);
  let i = cycle.length - 1;
  while (i > 0 && cycle[i - 1].left >= cycle[i].left && now - cycle[i - 1].at <= 7 * 86400e3) i--;
  const pts = cycle.slice(i);
  const last = pts[pts.length - 1];
  if (pts.length < 3 || !last || !(last.left > 0) || last.at - pts[0].at < 3600e3) return null;
  const t0 = pts[0].at, n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { const x = (p.at - t0) / 86400e3; sx += x; sy += p.left; sxx += x * x; sxy += x * p.left; }
  const den = n * sxx - sx * sx;
  if (!(den > 0)) return null;
  const slope = (n * sxy - sx * sy) / den;
  if (!(slope < 0)) return reset !== null ? { out: null, lasts: true } : null;
  const out = t0 + (-(sy - slope * sx) / n / slope) * 86400e3;
  if (!(out > now)) return null;
  return { out, lasts: reset !== null && out >= reset };
}

/**
 * The page's own palette for the content area, light and dark as app.css
 * draws them. The header and period row keep Herdr's theme tokens; only the
 * content below them is the page's. Herdr's theme() carries colors alone,
 * so the theme's own background decides which pair to draw.
 */
function pagePalette() {
  const bg = theme().background ?? "#FFFFFF";
  const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
  const dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  return dark ? {
    bg: "#1A1A1E", card: "#232327", card2: "#1F1F23", pill: "#2D2D33",
    line: "#333339", line2: "#2C2C32",
    fg: "#EDEDF1", fg2: "#B9B9C1", muted: "#8B8B94", faint: "#56565F",
    accent: "#A5B4FC", green: "#6FD99B", amber: "#F2B544", red: "#F28B82",
    series: ["#A5B4FC", "#7DD3FC", "#6EE7B7", "#FCD34D", "#F9A8D4", "#C4B5FD", "#94A3B8"],
  } : {
    bg: "#F6F6F8", card: "#FFFFFF", card2: "#F9F9FB", pill: "#F1F1F4",
    line: "#E3E3E8", line2: "#ECECF0",
    fg: "#1C1C21", fg2: "#4B4B53", muted: "#85858D", faint: "#B9B9C2",
    accent: "#5B5BD6", green: "#1A7F37", amber: "#B45309", red: "#D64545",
    series: ["#5B5BD6", "#0EA5E9", "#10B981", "#F59E0B", "#EC4899", "#8B5CF6", "#64748B"],
  };
}

/**
 * The five provider icons the panel ships; anything else, including the
 * gateway's own picture files, falls back to magpie's.
 *
 * @param {string} name
 */
function iconFile(name) {
  return ICON_FILES[name] ?? "magpie.svg";
}

/**
 * @param {string} name
 * @param {number} size
 * @param {{fg: string}} p
 */
function providerIcon(name, size, p) {
  return image(`mods/magpie-stats/${iconFile(name)}`).w(size).h(size).flex_none().text_color(p.fg);
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
 * Group a provider's accounts into one card when every one of them has a
 * user, as the page does; an account without one keeps its own card.
 *
 * @param {QuotaAccount[]} accounts
 * @returns {QuotaAccount[][]}
 */
function groupAccounts(accounts) {
  const groups = [];
  for (const account of accounts) {
    const g = account.user !== "" && groups.find((x) => x[0].user !== "" && x[0].provider === account.provider);
    if (g) g.push(account); else groups.push([account]);
  }
  return groups;
}

/**
 * A card's height before it has been measured: enough to place it in a
 * column on the first frame; the measurement replaces it at once.
 *
 * @param {QuotaAccount[]} group
 * @param {boolean} left
 */
function estimateCardHeight(group, left) {
  let h = 42;
  for (const account of group) {
    if (account.user !== "" || account.alias !== "") h += 20;
    if (account.error !== "") { h += 34; continue; }
    if (account.windows.length === 0) { h += account.balance === "" ? 8 : 46; continue; }
    const rows = Math.ceil(account.windows.length / 2);
    h += rows * 74 + (rows - 1) * 9;
    if (account.lines.some((l) => l.points.length > 0)) h += 118;
    if (account.balance !== "") h += 46;
    h += 18;
  }
  if (group.length > 1) h += 78;
  return h;
}

/**
 * One provider's accounts as one figure a window: counted windows add their
 * amounts and limits, a share is averaged over accounts on one plan, and
 * only windows two or more accounts share go in. A failed reading is
 * unknown, never zero.
 *
 * @param {QuotaAccount[]} accounts
 * @returns {{name: string, amount: number, limit: number, unit: string, used: number, accounts: number}[]}
 */
function aggregateWindows(accounts) {
  const read = accounts.filter((a) => a.error === "" && a.windows.length > 0);
  const by = new Map();
  for (const account of read) {
    for (const window of account.windows) {
      if (window.text || window.unlimited || window.used === null || window.balance !== null) continue;
      const kind = window.limit > 0 ? "count" : `share:${account.plan}`;
      const key = `${window.name}\n${window.unit}\n${kind}`;
      let m = by.get(key);
      if (!m) by.set(key, (m = { name: window.name, unit: window.unit, kind, n: 0, amount: 0, limit: 0, used: 0 }));
      m.n++;
      if (kind === "count") { m.amount += window.amount; m.limit += window.limit; }
      else m.used += clamp100(window.used);
    }
  }
  const out = [];
  for (const m of by.values()) {
    if (m.n < 2) continue;
    out.push({
      name: m.name, unit: m.unit, accounts: m.n,
      amount: m.amount, limit: m.limit,
      used: m.kind === "count" ? (100 * m.amount) / m.limit : Math.round((10 * m.used) / m.n) / 10,
    });
  }
  return out;
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

    /** @type {boolean} */
    this.quotaLeft = localStorage.getItem(QUOTA_LEFT_KEY) === "1";

    /** @type {Set<string>} */
    this.folded = new Set();
    try {
      const stored = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]");
      if (Array.isArray(stored)) this.folded = new Set(stored.filter((x) => typeof x === "string"));
    } catch { /* a junk stored value folds nothing */ }

    /** @type {Map<string, number>} */
    this.cardHeights = new Map();
    this.cardPackSignature = "";

    const stored = localStorage.getItem(SELECTED_INSTANCE_KEY);
    if (stored !== null) this.selectedInstanceId = /** @type {InstanceId} */ (stored);

    this.tick(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.tick(cx));
  }

  /**
   * Flip every window between used and left, kept across a restart.
   */
  setQuotaLeft(left, cx) {
    if (left === this.quotaLeft) return;
    this.quotaLeft = left;
    localStorage.setItem(QUOTA_LEFT_KEY, left ? "1" : "0");
    cx.notify();
  }

  /**
   * Fold or unfold one list, kept across a restart by its name.
   *
   * @param {string} name
   */
  toggleFold(name, cx) {
    if (this.folded.has(name)) this.folded.delete(name); else this.folded.add(name);
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...this.folded]));
    cx.notify();
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
    const p = pagePalette();
    if (state.kind === "loading") {
      return div().flex_1().min_h(0).w_full().bg(p.bg).px(10).pt(8).text_color(p.muted).child("Reading Magpie usage…");
    }
    if (state.kind === "unavailable") {
      const copy = problemCopy(state.problem);
      return v_flex().flex_1().min_h(0).w_full().bg(p.bg).px(10).pt(10).gap(4)
        .child(div().font_medium().text_color(p.fg).child(copy.title))
        .child(div().text_size(11).text_color(p.muted).tooltip(state.problem.detail).child(copy.body));
    }
    const content = this.renderSnapshot(state.snapshot, quota, tier);
    if (state.kind !== "stale") return content;
    return v_flex().flex_1().min_h(0).w_full().bg(p.bg)
      .child(content)
      .child(h_flex().flex_none().px(10).py(4).text_size(11).text_color(p.muted)
        .tooltip(problemCopy(state.problem).body)
        .child(`Can't refresh · updated ${formatTime(state.snapshot.receivedAt)}`));
  }

  /**
   * The Overview in the page's order: allowances, the scope note, tiles,
   * chart, the four lists, the footer note. Wide splits it into two columns;
   * narrow and medium keep one. The content area is the page's own palette;
   * the header and period row above keep Herdr's.
   *
   * @param {UsagePageSnapshot} snapshot
   * @param {QuotaState} quota
   * @param {"narrow" | "medium" | "wide"} tier
   */
  renderSnapshot(snapshot, quota, tier) {
    const p = pagePalette();
    const cost = this.renderCost(snapshot.totals, p);
    const allowances = this.renderAllowances(quota, tier, p);
    const scope = div().flex_none().px(10).pt(8).text_size(11).text_color(p.faint)
      .child("Gateway calls only; session-log calls are in Requests. Local rejections are excluded from totals.");
    const kpis = this.renderKpis(snapshot.totals, tier, p);
    const chart = this.renderChart(snapshot.chart, tier, p);
    const footer = div().flex_none().px(10).pt(10).pb(6).text_size(11).text_color(p.faint).whitespace_normal()
      .child(`Counted from the providers' own usage reports on every call through the gateway · ${snapshot.path === "" ? "~/.config/magpie/usage.jsonl" : snapshot.path}`);
    const scroll = v_flex().id("magpie-snapshot").w_full().flex_1().min_h(0).overflow_y_scroll().items_center().bg(p.bg);

    const lists = (names) => names.map(([title, slug, rows]) => this.renderRows(title, slug, rows, tier, p));
    if (tier === "wide") {
      const left = [cost, allowances, scope, kpis, chart,
        ...lists([["Agents", "agents", snapshot.agents]])];
      const right = lists([["Models", "models", snapshot.models], ["Accounts", "accounts", snapshot.accounts], ["Gateway keys", "gateway-keys", snapshot.keys]]);
      right.push(footer);
      return scroll.child(h_flex().flex_none().w_full().max_w(CONTENT_WIDTH).gap(COLUMN_GAP).items_start()
        .child(v_flex().flex_1().min_w(0).max_w(COLUMN_WIDTH).children(left.filter((x) => x !== null)))
        .child(v_flex().flex_1().min_w(0).max_w(COLUMN_WIDTH).children(right.filter((x) => x !== null))));
    }

    const sections = [cost, allowances, scope, kpis, chart,
      ...lists([["Agents", "agents", snapshot.agents], ["Models", "models", snapshot.models], ["Accounts", "accounts", snapshot.accounts], ["Gateway keys", "gateway-keys", snapshot.keys]]),
      footer];
    return scroll.child(v_flex().flex_none().w_full().max_w(COLUMN_WIDTH).children(sections.filter((x) => x !== null)));
  }

  /**
   * The period's cost at effective prices, or the count that has none beside
   * it, so a total never reads as if those cost nothing.
   *
   * @param {Totals} totals
   * @param {*} p
   */
  renderCost(totals, p) {
    const unpriced = totals.unpriced;
    const note = unpriced > 0
      ? `${formatInt(unpriced)} ${unpriced === 1 ? "call" : "calls"} unpriced`
      : "effective prices";
    const tooltip = unpriced > 0
      ? `${formatInt(unpriced)} ${unpriced === 1 ? "call had" : "calls had"} no known price and ${unpriced === 1 ? "is" : "are"} not counted`
      : "Estimated at effective model prices. A model's price at one provider is set in that provider's Model settings and counts over its list price";
    return h_flex().id("magpie-cost").flex_none().px(10).pt(6).gap(6).items_end().flex_wrap()
      .child(div().text_size(15).font_semibold().text_color(p.fg).child(formatRowCost(totals.cost, unpriced)))
      .child(div().text_size(12).pb(1).text_color(p.muted).tooltip(tooltip).child(note));
  }

  /**
   * Four tiles: tokens, cache read, reasoning, calls. White cells with 1px
   * gaps inside a 12px rounded bordered strip; narrow stacks them two by two.
   *
   * @param {Totals} totals
   * @param {"narrow" | "medium" | "wide"} tier
   * @param {*} p
   */
  renderKpis(totals, tier, p) {
    const tokens = totals.input + totals.output;
    const prompt = tokens + totals.cacheRead + totals.cacheWrite;
    const hit = totals.cacheRead > 0 && prompt > 0 ? totals.cacheRead / prompt : null;
    const failed = [
      totals.credited > 0 ? `${formatN(totals.credits)} credits` : "",
      totals.errors > 0 ? `${formatInt(totals.errors)} failed` : "",
      totals.retried > 0 ? `${formatInt(totals.retried)} answered on a retry` : "",
      totals.canceled > 0 ? `${formatInt(totals.canceled)} canceled` : "",
      totals.unpriced > 0 ? `${formatInt(totals.unpriced)} ${totals.unpriced === 1 ? "call" : "calls"} unpriced` : "",
    ].filter(Boolean).join(" · ");
    const cacheTooltip = [
      `Cache written ${formatN(totals.cacheWrite)} (${formatInt(totals.cacheWrite)})`,
      `Reasoning ${formatN(totals.reasoning)} (${formatInt(totals.reasoning)})`,
    ].join("\n");
    const unpricedTooltip = totals.unpriced > 0
      ? `${formatInt(totals.unpriced)} ${totals.unpriced === 1 ? "call had" : "calls had"} no known price and ${totals.unpriced === 1 ? "is" : "are"} not counted`
      : "";
    const tile = (id, value, label, sub, tooltip) => v_flex().id(id).flex_1().min_w(0).px(14).pt(12).pb(11).bg(p.card)
      .when(tooltip !== "", (e) => e.tooltip(tooltip))
      .child(div().text_size(20).font_semibold().text_color(p.fg).truncate().child(value))
      .child(div().pt(3).text_size(11).font_semibold().text_color(p.muted).child(label))
      .when(sub !== "", (e) => e.child(div().pt(3).text_size(11).text_color(p.muted).truncate().child(sub)));
    const tiles = [
      tile("magpie-kpi-tokens", formatN(tokens), "TOKENS", `${formatN(totals.input)} in · ${formatN(totals.output)} out`, ""),
      tile("magpie-kpi-cache", formatN(totals.cacheRead), "CACHE READ", hit === null ? "" : `hit rate ${formatPercent(hit)}`, cacheTooltip),
      tile("magpie-kpi-reasoning", formatN(totals.reasoning), "REASONING", "inside output", ""),
      tile("magpie-kpi-calls", formatInt(totals.calls), totals.calls === 1 ? "CALL" : "CALLS", failed, unpricedTooltip),
    ];
    const grid = v_flex().flex_none().w_full().gap(1).bg(p.line).border_1().border_color(p.line).rounded(12).overflow_hidden();
    if (tier === "narrow") {
      return v_flex().flex_none().px(10).pt(8)
        .child(grid.child(h_flex().gap(1).children(tiles.slice(0, 2))).child(h_flex().gap(1).children(tiles.slice(2))));
    }
    return v_flex().flex_none().px(10).pt(8).child(grid.child(h_flex().gap(1).children(tiles)));
  }

  /**
   * The chart: input stacked under output, scaled by tokens, in a white 12px
   * card. The height follows the tier; a nonzero bar is at least 2px. No SVG,
   * canvas, or animation timer.
   *
   * @param {Chart} chart
   * @param {"narrow" | "medium" | "wide"} tier
   * @param {*} p
   */
  renderChart(chart, tier, p) {
    const height = tier === "narrow" ? 32 : tier === "medium" ? 56 : 72;
    const peak = chart.points.reduce((max, point) => Math.max(max, point.input + point.output), 0);
    const every = chart.points.length <= 8 ? 1 : chart.points.length <= 31 ? Math.ceil(chart.points.length / 6) : Math.ceil(chart.points.length / 5);
    const empty = chart.points.length === 0 || peak === 0;
    const bars = h_flex().id("magpie-chart").w_full().h(height).items_end().gap(3).border_b_1().border_color(p.line2)
      .when(empty, (e) => e.items_center().justify_center().text_size(11).text_color(p.muted).child("No calls in this period"))
      .when(!empty, (e) => e.children(chart.points.map((point) => {
        const tokens = point.input + point.output;
        const barHeight = tokens <= 0 ? 0 : Math.max(2, Math.round((tokens / peak) * height));
        const outputHeight = tokens <= 0 ? 0 : Math.round((point.output / tokens) * barHeight);
        const inputHeight = barHeight - outputHeight;
        return div().id(`magpie-bar-${point.key}`).flex_1().min_w(0).h(height).flex().items_end()
          .when(barHeight > 0, (e) => e.child(v_flex().w_full().h(barHeight).flex_none().rounded_tl(3).rounded_tr(3).overflow_hidden()
            .when(outputHeight > 0, (x) => x.child(div().w_full().h(outputHeight).flex_none().bg(p.accent)))
            .when(inputHeight > 0, (x) => x.child(div().w_full().h(inputHeight).flex_none().bg(p.accent).opacity(0.38)))))
          .tooltip(pointTooltip(point, chart.bucket));
      })));
    return v_flex().flex_none().px(10).pt(8)
      .child(v_flex().flex_none().w_full().px(14).pt(12).pb(8).rounded(12).border_1().border_color(p.line).bg(p.card)
        .when(!empty, (e) => e.child(h_flex().w_full().pb(5).items_end().justify_end()
          .child(div().text_size(10.5).text_color(p.faint).child(formatN(peak)))))
        .child(bars)
        .when(!empty, (e) => e.child(h_flex().w_full().pt(5).gap(3)
          .children(chart.points.map((point, i) => div().flex_1().min_w(0).text_size(10.5).text_color(p.muted)
            .whitespace_nowrap().child(i % every === 0 ? point.label : "")))))
        .when(chart.truncated, (e) => e.child(div().text_size(10).text_color(p.muted)
          .child(`Calls by ${chart.bucket} · last ${CHART_LIMIT}`))));
  }

  /**
   * The allowances: grouped cards, floor(width/268) per row at medium and
   * wide; one full-width card per group in narrow. Loading and an empty
   * payload draw nothing. The head carries the Used/Left toggle.
   *
   * @param {QuotaState} quota
   * @param {"narrow" | "medium" | "wide"} tier
   * @param {*} p
   */
  renderAllowances(quota, tier, p) {
    if (quota.kind === "loading") return null;
    if (quota.kind === "unavailable") {
      return div().px(10).pt(8).text_size(11).text_color(p.muted)
        .tooltip(problemCopy(quota.problem).body)
        .child("Quota unavailable");
    }
    const accounts = quota.snapshot.accounts;
    if (accounts.length === 0) return null;
    const groups = groupAccounts(accounts);
    const hasWindows = accounts.some((a) => a.error === "" && a.windows.length > 0);
    const head = h_flex().flex_none().w_full().px(10).pt(8).pb(6).gap(6).items_center()
      .child(div().text_size(11).font_semibold().text_color(p.muted)
        .when(quota.kind === "stale", (e) => e.tooltip(problemCopy(quota.problem).body))
        .child(quota.kind === "stale" ? "ALLOWANCES · STALE" : "ALLOWANCES"))
      .child(div().flex_1())
      .when(hasWindows, (e) => e.child(this.renderQuotaMode(p)));
    const cols = tier === "narrow" ? 1 : Math.max(1, Math.floor((Math.min(this.width, COLUMN_WIDTH) - 20 + 7) / (260 + 7)));
    const cards = groups.map((group) => this.renderQuotaCard(group, p));
    if (cols === 1) {
      return v_flex().flex_none().w_full()
        .child(head)
        .child(v_flex().flex_none().w_full().px(10).gap(7).children(cards));
    }
    // Masonry, as the page packs its cards: each card measured once at this
    // column width, then placed in the shortest column. The estimate stands
    // in until a card's first measurement.
    const inner = Math.min(this.width, COLUMN_WIDTH) - 20;
    const cardWidth = (inner - (cols - 1) * 7) / cols;
    const signature = `${cols}|${Math.round(cardWidth)}|${this.quotaLeft ? 1 : 0}`;
    if (this.cardPackSignature !== signature) {
      this.cardPackSignature = signature;
      this.cardHeights = new Map();
    }
    const heights = this.cardHeights ?? new Map();
    const ends = Array(cols).fill(0);
    const placed = [];
    let tall = 0;
    groups.forEach((group, i) => {
      const key = group[0].id;
      const h = heights.get(key) ?? estimateCardHeight(group, this.quotaLeft);
      let c = 0;
      for (let k = 1; k < cols; k++) if (ends[k] < ends[c]) c = k;
      const top = ends[c];
      ends[c] += h + 7;
      tall = Math.max(tall, ends[c] - 7);
      placed.push(div().absolute().top(top).left(`${(c * (100 / cols)).toFixed(3)}%`).w(`${(100 / cols).toFixed(3)}%`)
        .px(c === 0 ? 0 : 3.5).pr(c === cols - 1 ? 0 : 3.5)
        .child(cards[i]
          .id(`magpie-card-measure-${key}`)
          .on_size_change((size, cx) => {
            if (size.height > 0 && heights.get(key) !== size.height) {
              heights.set(key, size.height);
              this.cardHeights = heights;
              cx.notify();
            }
          })));
    });
    return v_flex().flex_none().w_full()
      .child(head)
      .child(v_flex().flex_none().w_full().px(10)
        .child(div().relative().w_full().h(tall).children(placed)));
  }

  /**
   * The Used/Left switch: a pill track with the chosen side on a white thumb.
   *
   * @param {*} p
   */
  renderQuotaMode(p) {
    const opt = (left, label) => div().id(`magpie-quota-${left ? "left" : "used"}`).flex_none().h(22).px(10)
      .flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_size(12).text_color(left === this.quotaLeft ? p.fg : p.muted)
      .bg(left === this.quotaLeft ? p.card : "#00000000")
      .tooltip(left ? "Show how much of each window is left" : "Show how much of each window is used")
      .on_click((_e, cx) => this.setQuotaLeft(left, cx))
      .child(label);
    return h_flex().flex_none().p(2).gap(0).rounded(7).bg(p.pill)
      .child(opt(false, "Used")).child(opt(true, "Left"));
  }

  /**
   * One provider's card: head icon, bold name, plan · term; of several
   * accounts an "All N accounts" aggregate block and a section per account.
   *
   * @param {QuotaAccount[]} group
   * @param {*} p
   */
  renderQuotaCard(group, p) {
    const first = group[0];
    const several = group.length > 1;
    const head = h_flex().flex_none().w_full().gap(7).pb(9).items_center()
      .child(providerIcon(first.icon, 17, p))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(p.fg).child(first.name))
      .when(!several && planSpanText(first) !== "", (e) => e
        .child(div().flex_none().text_size(10.5).text_color(p.muted).truncate().child(planSpanText(first))));
    const card = v_flex().id(`magpie-quota-card-${first.id}`).flex_1().min_w(0).px(12).pt(10).pb(11)
      .rounded(10).border_1().border_color(p.line).bg(p.card)
      .child(head);
    if (several) {
      const aggregate = aggregateWindows(group);
      if (aggregate.length > 0) card.child(this.renderQuotaAll(group.length, aggregate, p));
      group.forEach((account, i) => {
        card.child(v_flex().flex_none().w_full()
          .when(i > 0, (e) => e.mt(10).pt(9).border_t_1().border_color(p.line))
          .child(this.renderQuotaAccount(account, p)));
      });
    } else {
      card.child(this.renderQuotaAccount(first, p));
    }
    return card;
  }

  /**
   * The "All N accounts" block: each shared window's summed count and share
   * over a 3px bar, on the page's faint fill.
   *
   * @param {number} count
   * @param {{name: string, amount: number, limit: number, unit: string, used: number}[]} windows
   * @param {*} p
   */
  renderQuotaAll(count, windows, p) {
    const left = this.quotaLeft;
    return v_flex().flex_none().w_full().gap(6).px(10).pt(8).pb(9).mb(10).rounded(8).bg(p.pill)
      .child(div().text_size(10.5).font_semibold().text_color(p.muted).child(`All ${count} accounts`))
      .child(h_flex().flex_none().w_full().gap(14).flex_wrap()
        .children(windows.map((w) => {
          const used = clamp100(w.used);
          const n = left ? 100 - used : used;
          const pct = `${Number.isInteger(n) ? n : n.toFixed(1)}% ${left ? "left" : "used"}`;
          const figure = w.limit > 0
            ? `${group(String(left ? Math.max(0, w.limit - w.amount) : w.amount))} / ${group(String(w.limit))}${w.unit === "" ? "" : ` ${w.unit}`} · ${pct}`
            : pct;
          return v_flex().flex_1().min_w(120).gap(2)
            .child(div().text_size(10.5).text_color(p.muted).truncate().child(w.name))
            .child(div().text_size(10.5).font_semibold().text_color(p.fg2).whitespace_normal().child(figure))
            .child(div().h(3).w_full().rounded(2).bg(p.line).overflow_hidden()
              .child(div().h_full().rounded(2).bg(used >= 90 ? p.amber : p.accent).w(`${Math.round(left ? 100 - used : used)}%`)));
        })));
  }

  /**
   * One account's section: user left and plan right, its windows, the curve,
   * its balance and when it was read. A refused account keeps its error line.
   *
   * @param {QuotaAccount} account
   * @param {*} p
   */
  renderQuotaAccount(account, p) {
    const box = v_flex().flex_none().w_full().gap(6);
    if (account.user !== "" || account.alias !== "" || planSpanText(account) !== "") {
      box.child(h_flex().flex_none().w_full().gap(7).items_baseline()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(p.fg2)
          .child(account.alias !== "" ? account.alias : account.user))
        .when(planSpanText(account) !== "", (e) => e
          .child(div().flex_none().text_size(10.5).text_color(p.muted).truncate().child(planSpanText(account)))));
    }
    if (account.error !== "") {
      return box.child(div().text_size(11).text_color(p.muted).whitespace_normal().tooltip(account.error).child(account.error));
    }
    if (account.windows.length === 0 && account.balance !== "") {
      return box.child(this.renderBalance(account, p));
    }
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < account.windows.length; i += 2) {
      rows.push(h_flex().flex_none().w_full().gap(14).items_start()
        .child(this.renderQuotaWindow(account, account.windows[i], now, p))
        .child(i + 1 < account.windows.length ? this.renderQuotaWindow(account, account.windows[i + 1], now, p) : div().flex_1()));
    }
    box.child(v_flex().flex_none().w_full().gap(9).children(rows));
    const curve = this.renderQuotaCurve(account, now, p);
    if (curve !== null) box.child(curve);
    if (account.balance !== "" && account.windows.length > 0) box.child(this.renderBalance(account, p));
    // The curve carries its own "Updated …", as the page's card does.
    if (curve === null) {
      const read = this.renderReadWhen(account, p);
      if (read !== null) box.child(read);
    }
    return box;
  }

  /**
   * One window: name and figure over a 3px track, the reset line with its
   * pace and the whole-window estimate under it.
   *
   * @param {QuotaAccount} account
   * @param {QuotaWindow} window
   * @param {number} now
   * @param {*} p
   */
  renderQuotaWindow(account, window, now, p) {
    const left = this.quotaLeft;
    const noShare = window.text || window.used === null || window.balance !== null;
    const line = account.lines.find((l) => l.name === window.name) ?? null;
    const start = line !== null && line.points.length > 0 ? line.points[line.points.length - 1].start : null;
    const pace = quotaPace(window, start, left, now);
    const resetAt = parseTime(window.resetsAt);
    const resetParts = [];
    if (resetAt !== null) {
      resetParts.push(resetAt <= now ? `Reset time passed ${resetClock(resetAt, now)}` : `Resets ${resetClock(resetAt, now)}`);
      if (resetAt > now) resetParts.push(untilText(resetAt));
    }
    if (window.runsOutAt !== "" && window.runsOut > 0) {
      const outAt = parseTime(window.runsOutAt);
      if (outAt !== null && outAt > now) resetParts.push(`${group(String(window.runsOut))}${window.unit === "" ? "" : ` ${window.unit}`} expire ${resetClock(outAt, now)}`);
    }
    const holds = window.holds !== null
      ? `Whole ≈ ${formatN(window.holds.tokens)} tokens${window.holds.priced ? ` · ≈ ${formatCost(window.holds.cost)}` : ""}`
      : window.holdsWhy !== "" ? "Whole: not enough data" : "";
    return v_flex().flex_1().min_w(0).gap(4)
      .child(v_flex().w_full().gap(1)
        .child(div().w_full().truncate().text_size(10.5).text_color(p.muted).child(window.name))
        .child(div().w_full().text_size(10.5).font_semibold().text_color(p.fg2).whitespace_normal().child(quotaText(window, left))))
      .when(!window.unlimited && !noShare, (e) => e
        .child(div().h(3).w_full().rounded(2).bg(p.pill).overflow_hidden()
          .child(div().h_full().rounded(2).bg(p.accent).w(`${quotaFill(window, left)}%`))))
      .when(resetParts.length > 0 || pace !== null || holds !== "", (e) => e
        .child(v_flex().w_full().gap(2).pt(2)
          .when(resetParts.length > 0 || pace !== null, (x) => x.child(h_flex().w_full().gap(4).flex_wrap()
            .child(div().text_size(10).text_color(p.muted).whitespace_normal().child(resetParts.join(" · ")))
            .when(pace !== null, (y) => y.child(div().text_size(10).text_color(pace.over ? p.amber : p.muted)
              .child(`· Pace ${paceNumber(pace.n)}`)))))
          .when(holds !== "", (x) => x.child(div().text_size(10).text_color(p.muted).whitespace_normal().child(holds)))));
  }

  /**
   * The balance line: "Balance" left, the amount bold right, and the amber
   * "As of …" under it when the reading stands in for one that failed.
   *
   * @param {QuotaAccount} account
   * @param {*} p
   */
  renderBalance(account, p) {
    const asOf = parseTime(account.asOf);
    return v_flex().flex_none().w_full().gap(2)
      .child(h_flex().w_full().gap(6).items_baseline()
        .child(div().flex_1().text_size(10.5).text_color(p.muted).child("Balance"))
        .child(div().flex_none().text_size(15).font_semibold().text_color(p.fg).child(account.balance)))
      .when(asOf !== null, (e) => e.child(div().text_size(10).text_color(p.amber).whitespace_normal()
        .child(`As of ${curveTimeText(asOf, Date.now())} — couldn't be read just now`)));
  }

  /**
   * When the windows were read: "Updated …", or nothing when unknown.
   *
   * @param {QuotaAccount} account
   * @param {*} p
   */
  renderReadWhen(account, p) {
    const at = parseTime(account.readAt);
    if (at === null || account.windows.length === 0) return null;
    return div().flex_none().pt(2).text_size(10).text_color(p.muted).child(`Updated ${agoText(at)}`);
  }

  /**
   * "Left over time": each window's left % over the current cycle, a dashed
   * projection to the reset, axis times, legend dots and the reading's age.
   * Nothing without history or without paint_path at runtime.
   *
   * @param {QuotaAccount} account
   * @param {number} now
   * @param {*} p
   */
  renderQuotaCurve(account, now, p) {
    if (typeof window === "undefined" || typeof window.paint_path !== "function") return null;
    const lines = [];
    for (const w of account.windows) {
      if (w.unlimited) continue;
      const line = account.lines.find((l) => l.name === w.name);
      if (!line || line.points.length === 0) continue;
      lines.push({ window: w, line, cycle: windowCycle(line, w, now) });
    }
    if (lines.length === 0) return null;
    let x0 = Infinity, x1 = now;
    for (const { cycle } of lines) {
      x0 = Math.min(x0, cycle.start);
      if (cycle.reset !== null) x1 = Math.max(x1, cycle.reset);
    }
    if (!(x0 < now)) x0 = now - 3600e3;
    if (!(x1 > x0)) x1 = x0 + 1;
    const X = (at) => `${(((at - x0) / (x1 - x0)) * 100).toFixed(2)}%`;
    const Y = (left) => `${(100 - clamp100(left)).toFixed(2)}%`;
    const plot = div().relative().w_full().h(60).mt(5).overflow_hidden();
    for (const v of [0, 50, 100]) {
      plot.child(window.paint_path(PathBuilder.stroke(1).move_to("0%", `${100 - v}%`).line_to("100%", `${100 - v}%`).build(), p.line)
        .absolute().inset_0());
    }
    let longest = null, latest = -Infinity;
    lines.forEach(({ window: w, line, cycle }, i) => {
      const color = p.series[i % p.series.length];
      if (cycle.reset !== null && cycle.reset > latest) { latest = cycle.reset; longest = { line, cycle }; }
      const pts = line.points.filter((pt) => pt.at >= x0 && pt.at <= x1);
      if (pts.length > 0) {
        let builder = PathBuilder.stroke(1.5).move_to(X(pts[0].at), Y(pts[0].left));
        for (const pt of pts.slice(1)) builder = builder.line_to(X(pt.at), Y(pt.left));
        plot.child(window.paint_path(builder.build(), color).absolute().inset_0());
      }
      const last = line.points[line.points.length - 1];
      if (cycle.reset !== null && cycle.reset > now && last.at <= now) {
        const eta = curveEta(line.points, cycle.start, cycle.reset, now);
        const projected = eta !== null && eta.out !== null && eta.out < cycle.reset
          ? Math.max(0, last.left + ((eta.out - last.at) > 0 ? -last.left / (eta.out - last.at) : 0) * (cycle.reset - last.at))
          : last.left;
        plot.child(window.paint_path(PathBuilder.stroke(1).dash_array([3, 3])
          .move_to(X(last.at), Y(last.left)).line_to(X(cycle.reset), Y(projected)).build(), color)
          .absolute().inset_0());
      }
    });
    if (now >= x0 && now <= x1) {
      plot.child(window.paint_path(PathBuilder.stroke(1).dash_array([1, 2]).move_to(X(now), "0%").line_to(X(now), "100%").build(), p.faint)
        .absolute().inset_0());
    }
    const eta = longest === null ? null : curveEta(longest.line.points, longest.cycle.start, longest.cycle.reset, now);
    const paceText = eta === null ? "" : eta.lasts ? "Lasts past the reset at this pace" : `Runs out ${curveTimeText(Math.max(eta.out ?? now, now + 60e3), now)} at this pace`;
    const readAt = parseTime(account.readAt);
    return v_flex().flex_none().w_full().pt(4)
      .child(h_flex().w_full().gap(6).items_baseline()
        .child(div().flex_none().text_size(10.5).text_color(p.muted).child("Left over time"))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(p.muted).child(paceText))
        .child(div().flex_none().text_size(10).text_color(p.muted).child("Cycle")))
      .child(plot)
      .child(h_flex().w_full().pt(3).justify_between()
        .child(div().text_size(10).text_color(p.muted).child(curveTimeText(x0, now)))
        .child(div().text_size(10).text_color(p.muted).child(curveTimeText(x1, now))))
      .child(h_flex().w_full().pt(5).gap(12).flex_wrap()
        .children(lines.map(({ window: w, line }, i) => {
          const last = line.points[line.points.length - 1];
          return h_flex().flex_none().gap(5).items_center()
            .child(div().size(7).rounded(4).bg(p.series[i % p.series.length]))
            .child(div().text_size(10.5).text_color(p.muted).child(w.name))
            .child(div().text_size(10.5).font_semibold().text_color(p.fg2).child(`${Math.round(last.left)}%`));
        })))
      .when(readAt !== null, (e) => e.child(div().pt(5).text_size(10).text_color(p.muted).child(`Updated ${agoText(readAt)}`)));
  }

  /**
   * One titled list in a white 10px card, its head uppercase with a fold
   * chevron. Rows keep the server's order and open nothing.
   *
   * @param {string} title
   * @param {string} slug
   * @param {UsageRow[]} rows
   * @param {"narrow" | "medium" | "wide"} tier
   * @param {*} p
   */
  renderRows(title, slug, rows, tier, p) {
    if (rows.length === 0) return null;
    const folded = this.folded.has(slug);
    return v_flex().flex_none().w_full().px(10).pt(14)
      .child(h_flex().flex_none().w_full().pb(6).gap(5).items_center()
        .child(div().id(`magpie-fold-${slug}`).flex_none().size(14).flex().items_center().justify_center()
          .text_size(9).text_color(p.faint).cursor_pointer().rounded(3)
          .hover((s) => s.bg(p.pill))
          .tooltip(folded ? `Show the ${title.toLowerCase()}` : `Fold the ${title.toLowerCase()} away`)
          .on_click((_e, cx) => this.toggleFold(slug, cx))
          .child(folded ? "▸" : "▾"))
        .child(div().text_size(11).font_semibold().text_color(p.muted).child(title.toUpperCase())))
      .when(!folded, (e) => e.child(v_flex().flex_none().w_full().rounded(10).border_1().border_color(p.line).bg(p.card).overflow_hidden()
        .children(rows.map((row, i) => this.renderRow(slug, i, row, tier, p)))));
  }

  /**
   * One usage row: 16px icon, name and wrapped sub-line, the 4px share bar,
   * tokens with their breakdown under, and the green cost. Narrow stacks the
   * name and cost over the sub-line, the bar and the token count.
   *
   * @param {string} slug
   * @param {number} index
   * @param {UsageRow} row
   * @param {"narrow" | "medium" | "wide"} tier
   * @param {*} p
   */
  renderRow(slug, index, row, tier, p) {
    const sub = rowSubLine(row);
    const tooltip = rowTooltip(row);
    const cost = formatRowCost(row.cost, row.unpriced);
    const border = index > 0 ? (e) => e.border_t_1().border_color(p.line2) : (e) => e;
    if (tier === "narrow") {
      return v_flex().id(`magpie-${slug}-${index}`).flex_none().w_full().py(7).pl(14).pr(12).gap(2).tooltip(tooltip).map(border)
        .child(h_flex().w_full().gap(6).items_center()
          .child(providerIcon(row.icon, 16, p))
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(p.fg).child(row.name))
          .when(cost !== "", (e) => e.child(div().flex_none().text_size(12).text_color(p.green).child(cost))))
        .when(sub !== "", (e) => e.child(div().text_size(11.5).text_color(p.muted).whitespace_normal().child(sub)))
        .child(h_flex().w_full().gap(6).items_center()
          .child(this.renderShareBar(row, p))
          .child(div().flex_none().text_size(11).font_semibold().text_color(p.fg).child(formatN(row.tokens))));
    }
    return h_flex().id(`magpie-${slug}-${index}`).flex_none().w_full().py(7).pl(14).pr(12).gap(12).items_center().tooltip(tooltip).map(border)
      .child(providerIcon(row.icon, 16, p))
      .child(v_flex().flex_1().min_w(120).max_w(180)
        .child(div().truncate().text_size(13).font_medium().text_color(p.fg).child(row.name))
        .when(sub !== "", (e) => e.child(div().pt(1).text_size(11.5).text_color(p.muted).whitespace_normal().child(sub))))
      .child(this.renderShareBar(row, p))
      .child(v_flex().flex_none().items_end()
        .child(div().text_size(13).font_semibold().text_color(p.fg).child(formatN(row.tokens)))
        .child(div().text_size(10.5).text_color(p.muted).whitespace_nowrap().child(tokenBreakdown(row))))
      .child(div().flex_none().w(64).text_right().text_size(12).text_color(p.green).child(cost));
  }

  /**
   * The row's share of the period's tokens: a 4px track filling the row's
   * middle, the fill at least 1.5% so a tiny share still shows.
   *
   * @param {UsageRow} row
   * @param {*} p
   */
  renderShareBar(row, p) {
    return v_flex().flex_1().min_w(0).h(4).rounded(2).bg(p.pill).overflow_hidden()
      .tooltip(`${Math.round(row.share * 100)}% of tokens`)
      .child(div().h_full().rounded(2).bg(p.accent).opacity(0.7)
        .w(`${Math.max(1.5, Math.min(100, row.share * 100)).toFixed(1)}%`));
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
  if (row.credited > 0) parts.push(`${formatN(row.credits)} credits`);
  if (row.ownCalls > 0) parts.push(`${formatInt(row.ownCalls)} by magpie itself`);
  if (row.errors > 0) parts.push(`${formatInt(row.errors)} failed`);
  if (row.loops > 0) parts.push(`${formatInt(row.loops)} looped`);
  if (row.retried > 0) parts.push(`${formatInt(row.retried)} answered on a retry`);
  if (row.canceled > 0) parts.push(`${formatInt(row.canceled)} canceled`);
  if (row.timed > 0) parts.push(`TTFT ${formatTook(row.ttftMs / row.timed)}`);
  if (row.decodeMs > 0 && row.decodeOut > 0) parts.push(`${formatInt((row.decodeOut / row.decodeMs) * 1000)} tok/s`);
  if (row.timed > 0) parts.push(`${formatInt(row.timed)} timed ${row.timed === 1 ? "reply" : "replies"}`);
  return parts.join(" · ");
}

/** @param {UsageRow} row */
function tokenBreakdown(row) {
  const parts = [`${formatN(row.input)} in`, `${formatN(row.output)} out`];
  if (row.cacheRead > 0) parts.push(`${formatN(row.cacheRead)} cached`);
  const prompt = row.input + row.cacheRead + row.cacheWrite;
  if (row.cacheRead > 0 && prompt > 0) parts.push(`hit rate ${formatPercent(row.cacheRead / prompt)}`);
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
