# Magpie stats

A sidebar panel that shows what local [magpie](https://github.com/yetone/magpie)
gateways have been doing: spend, calls, tokens, a bar chart of activity, and the
top models, refreshed live from each gateway's own usage endpoint. Click a
period (Today, 7D, 30D, All) and the whole panel follows. Click the title to
switch between gateways or add more. When a gateway is stopped the panel says
so quietly and keeps trying; it never asks for a key or opens anything.

![Magpie stats](preview.png)

## What you see

One block in the left sidebar, 240 px tall, on the sidebar's background
(theme `chrome`), text 12 px in the UI font.

- Header row. The selected gateway's name in semibold (the built-in one is
  named "Magpie"; click the name to switch or add gateways), a status word
  with a colored dot (Live in the theme's working color, Stale in idle,
  Offline or Unavailable in blocked), a 5 px dot per other watched gateway
  (from two gateways on), and a refresh control (↻) at the right edge that
  spins while a request is in flight.
- Gateway picker. Click the header name. One row per gateway: its status dot
  for the selected period, its name, and a `✕` to remove it (the built-in
  Magpie has none). `+ Add gateway` opens a small form: Name and Address
  file (both real text inputs, prefilled `magpie-2` /
  `~/.config/magpie/gateway-2.json`). Add writes the watch list and selects
  the new gateway; Cancel returns to the list; a failure keeps what you
  typed and says why inline. Removal is immediate, no confirm.
- Period row. Four equal segments, Today / 7D / 30D / All. The selected one has
  the theme's raised background. 30D is the default.
- Cost line. The period's cost in USD, 17 px semibold (`$519.97`). A dim
  `+ N unpriced` note follows it when some calls had no known price.
- Calls line. `7,944 calls` in muted text, `· 5 errors` in the blocked color,
  errors omitted at zero.
- Token line (dim, 11 px). `32.3M in · 4.4M out · 1.9G cache read`, segments
  at zero omitted, the whole line omitted when everything is zero. Hover it
  for the full breakdown including cache write, reasoning, and exact counts.
- Chart. Up to 30 flex-width bars, 32 px tall, in the accent color, one per
  day (hour for Today, week when magpie says so). Bar height follows each
  bucket's calls, minimum 2 px for any nonzero bucket. Hover a bar for its
  label, calls, errors, and cost. An empty period shows "No calls in this
  period" centered instead.
- Models section. Up to three rows, the models magpie ranked highest by
  tokens: name (truncated), compact token count, share of the period's
  tokens. `+ N more` when magpie reported more models. Hover a row for its
  provider, calls, errors, cost, and exact token count.
- Agents section. Same shape, up to two rows, shown only when more than one
  agent routed traffic in the period. One agent at 100% tells you nothing, so
  the section is omitted.

Narrow the sidebar under 160 px and the block becomes a rail: the selected
gateway's first letter with its status dot, plus one dot per other watched
gateway. Hover for a summary (status, cost, calls, last update), click to
refresh.

## How it behaves

- Live. The selected period refreshes every 30 seconds, and on first show.
  The status reads Live. Each gateway keeps its own states and its own
  selected period; a failure on one gateway never touches another's
  numbers (its late answer can only land in its own state map).
- Period switch. Clicking a segment shows that period at once from its cache
  (each period keeps its own snapshot), then refreshes it if its data is
  older than 30 seconds. A late answer for a period you already left updates
  only that period's cache; it can never overwrite the one on screen.
- Refresh click. Forces a fetch of the selected period even when fresh. The
  control spins while the request is in flight; a second click during it does
  nothing.
- Failure after success. The last numbers stay, the status becomes Stale, and
  a footer reads `Can't refresh · updated 14:32` with the local time of the
  last good fetch. Hover the footer for the reason. Recovery is automatic.
- Gateway down, nothing ever fetched. One quiet state instead of numbers:
  "Magpie isn't running" when the gateway's address file is gone, "Magpie
  isn't answering" when the connection fails, "Magpie usage is unavailable"
  when the answer isn't usable usage data. Each with "Retrying every 30
  seconds." No error wall, no toasts.
- Nothing opens anything. Rows and bars are not clickable. The web UI is
  cookie-gated and the panel carries no credential, so there is no
  click-through to it.

## Built from

- `mods/magpie-stats/main.js`, one file, no assets. `mod.json` is
  `{"place": "left", "size": 240}`, so the first time Herdr sees the folder it
  docks one copy into the shown layout's left sidebar; after that the layout
  decides. No props, no keys of its own, no `focusable`.
- The mod docks itself; no layout file ships. To place it by hand, add to a
  sidebar column:
  `{"id": "magpie", "type": "block", "size": {"px": 240}, "min": 60, "content": {"mod": "magpie-stats"}}`.
- herdr functions used: `home()`, `appHome()`, `readTextFile()`,
  `writeTextFile()` (compare-and-swap), `theme()`, `InputState`/`Input` from
  gpui-base, and the built-in `fetch`. No app commands, no `exec`, no
  programs.
- Watch list: `<appHome>/magpie-stats-instances.json`,
  `{"version":1,"instances":[{"id":"i-…","name":"…","addressFile":"…"}]}`,
  written only through a compare-and-swap read-merge-write with a bounded
  retry, so several docked copies share one list safely. The built-in
  Magpie gateway is derived, never stored. Each docked copy remembers its
  selected gateway in its own localStorage. That is the one thing the mod
  persists.
- Data source per gateway: `GET http://127.0.0.1:<port>/v1/magpie/usage?period=today|7d|30d|all`,
  read from that gateway's own address file (default
  `~/.config/magpie/gateway.json`), re-read on every refresh, loopback hosts
  only, no key. The endpoint is the one magpie's Usage page reads,
  `internal/gateway/usage_api.go` in magpie's source.
- Structure: per gateway a `Map` from period to one of four states (loading /
  ready / stale / unavailable), owned by one runtime object captured before
  each fetch. One method owns all writes to it; a response is validated in
  full (period match, known bucket, finite nonnegative numbers) before it
  becomes a snapshot, and malformed data becomes "unavailable", never
  zero-filled numbers.

## Watch out

- Loopback only, by design. magpie's usage endpoint answers this machine
  without a key and refuses other machines unless sharing is on with a key.
  Do not add a key or a remote address to this mod.
- Each gateway's address file is re-read on every refresh, so a gateway
  restarted on a new port heals within one cycle. Do not cache it.
- Added address files must be absolute paths inside the user's home (`~`
  expands). That is deliberate: a path outside home is almost certainly
  another machine's or a mistake.
- The runtime's JavaScript has no locale data. `toLocaleString` for currency
  returns the raw number on screen. The formatters (cost, thousands grouping,
  clock time) are hand-written for that reason; keep them that way.
- The chart keeps the last 30 series points; a longer period (All) shows the
  last 30 buckets with a `· last 30` note, while the totals still cover
  everything.
- Responses over Herdr's 8 MiB fetch cap fail into the unavailable state.
  Period payloads here measure 6 to 14 KB; the risk only grows if a history
  grows enormous.
- Redirects are rejected (`response.url` must equal the request), so a
  proxy or captive portal on loopback becomes "unavailable" rather than
  trusted output.
- Numbers are one glance deep on purpose. Sessions, accounts, caller keys,
  and per-request rows exist in the payload and are deliberately ignored.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/magpie-stats` passes.
- With magpie running, the panel shows Live, the cost matches
  `curl -s "http://127.0.0.1:3425/v1/magpie/usage?period=30d"`'s `cost`, and
  the bar count matches the period (24 for today's hours, 30 for 30D).
- Adding a second gateway (picker → `+ Add gateway` → its address file) shows
  it selected with its own numbers within a tick, and the header carries a
  second dot; stopping only that gateway leaves the first one Live.
- Switching periods twice quickly leaves the second period's numbers on
  screen, not the first's.
- Stopping magpie keeps the last numbers with a Stale status and the
  `Can't refresh` footer; deleting `gateway.json` (or pointing it at a closed
  port) with no cache shows the quiet "isn't running" / "isn't answering"
  state, and both recover on their own once magpie is back.
- `node .kimi-code/skills/verify-magpie-stats-registry/check.mjs` prints
  `all properties hold on the real code`.
