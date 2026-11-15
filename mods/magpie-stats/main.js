import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, readTextFile, theme } from "herdr";

const REFRESH_MS = 30_000;
const CHART_LIMIT = 30;
const AGENT_LIMIT = 2;
const MODEL_LIMIT = 3;

const PERIODS = /** @type {const} */ ([
  { id: "today", label: "Today" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
  { id: "all", label: "All" },
]);

/** @typedef {(typeof PERIODS)[number]["id"]} Period */
/** @typedef {"not-running" | "unreachable" | "unsafe-address" | "bad-response"} ProblemKind */
/** @typedef {{kind: ProblemKind, detail: string}} Problem */

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
 * Read and validate one period at the system boundary.
 * See the checks in order below; the gateway file is re-read every call so a
 * gateway restart on a new port needs no mod restart.
 *
 * @param {Period} period
 * @returns {Promise<UsageSnapshot>}
 */
async function loadUsage(period) {
  let text;
  try {
    text = await readTextFile(`${home()}/.config/magpie/gateway.json`);
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
    /** @type {Period} */
    this.selectedPeriod = "30d";

    /** @type {Map<Period, PeriodState>} */
    this.states = new Map();

    /** @type {Set<Period>} */
    this.inFlight = new Set();

    /** @type {number} */
    this.width = 240;

    this.refresh(cx, this.selectedPeriod, false);
    cx.timer.every(REFRESH_MS, (cx) => {
      this.refresh(cx, this.selectedPeriod, false);
    });
  }

  /**
   * Select and reveal one period. Ignores an unknown or already selected id;
   * writes only selectedPeriod; states are never written here. A missing map
   * entry renders as loading, while a cached entry stays visible while
   * refresh(cx, period, false) runs.
   *
   * @param {Period} period
   */
  selectPeriod(period, cx) {
    if (!PERIODS.some((p) => p.id === period) || period === this.selectedPeriod) return;
    this.selectedPeriod = period;
    cx.notify();
    this.refresh(cx, period, false);
  }

  /**
   * The sole owner of states and inFlight mutations, and the only refresh
   * entry point. One request per period may be in flight; a non-forced call
   * skips a period that is ready and younger than REFRESH_MS (stale data never
   * counts as fresh). Results land only in their own period's entry.
   *
   * @param {Period} period
   * @param {boolean} force
   */
  refresh(cx, period, force) {
    if (this.inFlight.has(period)) return;
    const current = this.states.get(period);
    if (!force && current?.kind === "ready" && Date.now() - current.snapshot.receivedAt < REFRESH_MS) return;
    this.inFlight.add(period);
    cx.notify();
    cx.spawn(async (cx) => {
      let next;
      try {
        next = { kind: "ready", snapshot: await loadUsage(period) };
      } catch (error) {
        const problem = asProblem(error);
        const existing = this.states.get(period);
        next = existing && existing.kind !== "unavailable"
          ? { kind: "stale", snapshot: existing.snapshot, problem }
          : { kind: "unavailable", problem };
      } finally {
        // Read the map entry at completion time; selection may have changed meanwhile.
        this.states.set(period, next);
        this.inFlight.delete(period);
        cx.notify();
      }
    });
  }

  /**
   * Build the header, period buttons, compact rail, and current state body.
   * Reads only selectedPeriod, states, inFlight, and width. No fetch, no notify.
   *
   * @param {unknown} _cx
   */
  render(_cx) {
    const t = theme();
    const state = this.states.get(this.selectedPeriod) ?? { kind: "loading" };
    if (this.width < 160) return this.renderRail(state, t);
    const busy = this.inFlight.has(this.selectedPeriod);
    const status = statusOf(state, t);
    return v_flex().id("magpie-stats").size_full().min_h(0).overflow_hidden().bg(t.chrome).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => {
        const width = size.width;
        if (width !== this.width) { this.width = width; cx.notify(); }
      })
      .child(h_flex().flex_none().px(10).pt(8).pb(4).gap(6).items_center()
        .child(div().font_semibold().child("Magpie"))
        .child(div().size(5).rounded(3).bg(status.color))
        .child(div().text_size(11).text_color(status.color).tooltip(status.note).child(status.label))
        .child(div().flex_1())
        .child(div().id("magpie-refresh").flex_none().w(20).h(20).flex().items_center().justify_center().rounded(5)
          .text_size(12)
          .when(busy, (e) => e.text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
          .when(!busy, (e) => e.text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).child("↻"))
          .tooltip("Refresh now")
          .on_click((_e, cx) => this.refresh(cx, this.selectedPeriod, true))))
      .child(h_flex().flex_none().px(10).pb(6).gap(2)
        .children(PERIODS.map((p) => {
          const selected = p.id === this.selectedPeriod;
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
   * The panel below 160px: one status letter, one dot, one refresh click.
   *
   * @param {PeriodState} state
   */
  renderRail(state, t) {
    const status = statusOf(state, t);
    const snapshot = state.kind === "ready" || state.kind === "stale" ? state.snapshot : null;
    const note = snapshot
      ? `Magpie ${status.label.toLowerCase()} · ${formatCost(snapshot.totals.cost)} · ${formatInt(snapshot.totals.calls)} calls · updated ${formatTime(snapshot.receivedAt)}`
      : `Magpie ${status.label.toLowerCase()} · ${status.note}`;
    return v_flex().id("magpie-stats").size_full().min_h(0).overflow_hidden().bg(t.chrome).text_color(t.foreground)
      .on_size_change((size, cx) => {
        const width = size.width;
        if (width !== this.width) { this.width = width; cx.notify(); }
      })
      .child(div().id("magpie-rail").flex_1().min_h(0).flex().items_center().justify_center().cursor_pointer()
        .text_size(12).font_semibold().text_color(t.muted).tooltip(note)
        .on_click((_e, cx) => this.refresh(cx, this.selectedPeriod, true))
        .child("M")
        .child(div().ml(3).size(5).rounded(3).bg(status.color)));
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
