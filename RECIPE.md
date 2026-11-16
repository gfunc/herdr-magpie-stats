# Magpie stats

A panel, opened from the window's + menu as a tab, that shows what
[magpie](https://github.com/yetone/magpie) gateways have been doing: spend,
calls, tokens, a bar chart of activity, the top models, and the remaining quota
or balance of every account on each gateway. It refreshes live from the
gateway's own usage and quota endpoints. Click a period (Today, 7D, 30D, All)
and the whole panel follows. Click the title to switch between gateways or add
one by address file, or by URL and gateway key. When a gateway is stopped the
panel says so quietly and keeps trying. It opens nothing.

![Magpie stats](preview.png)

## What you see

One panel. In a sidebar it is 240 px wide. In a tab it is a centered column
560 px wide. The background is the theme's `chrome`, the text 12 px in the UI
font.

- Header row. The selected gateway's name in semibold (the built-in one is
  named "Magpie"; click the name to switch or add gateways), a status word
  with a colored dot (Live in the theme's working color, Stale in idle,
  Offline or Unavailable in blocked), a 5 px dot per other watched gateway
  (from two gateways on), and a refresh control (↻) at the right edge that
  spins while a request is in flight.
- Gateway picker. Click the header name. One row per gateway: its status dot
  for the selected period, its name, and a `✕` to remove it (the built-in
  Magpie has none). `+ Add gateway` opens a small form with two type buttons,
  **Address file** and **URL + key**. Address file asks for Name and Address
  file, prefilled `magpie-2` / `~/.config/magpie/gateway-2.json`. URL + key
  asks for Name, URL, and API key, prefilled `http://127.0.0.1:3425` and an
  empty key. Add writes the watch list and selects the new gateway. Cancel
  returns to the list. A failure keeps what you typed and says why inline.
  Removal is immediate, no confirm.
- Period row. Four equal segments, Today / 7D / 30D / All. The selected one has
  the theme's raised background. 30D is the default.
- Cost line. The period's cost in USD, 17 px semibold (`$519.97`). A dim
  `+ N unpriced` note follows it when some calls had no known price.
- Calls line. `7,944 calls` in muted text, `· 5 errors` in the blocked color,
  errors omitted at zero.
- Token line (dim, 11 px). `32.3M in · 4.4M out · 1.9G cache read`, segments
  at zero omitted, the whole line omitted when everything is zero. Hover it
  for the full breakdown including cache write, reasoning, and exact counts.
- Quota section. Up to four accounts, the one closest to its limit first, each
  with its remaining percentage (`10.1%`, in blocked color under 10, idle
  under 30) and a tooltip with plan, user, every window, and reset times. A
  `Balance` line lists balance-only accounts, for example
  `my ¥789.67 · milo ¥1481.66`. A refused account gets one line in the blocked
  color, for example `Copilot · GitHub refused this Copilot sign-in; sign in
  again`. `+ N more` when quota rows were omitted. The title reads
  `Quota · stale` while the last answer could not be refreshed.
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

In a sidebar narrower than 160 px, the panel becomes a rail: the selected
gateway's first letter with its status dot, plus one dot per other watched
gateway. Hover for a summary (status, cost, calls, last update), click to
refresh.

## How it behaves

- Live. The selected period refreshes every 30 seconds, and on first show.
  The status reads Live. Each gateway keeps its own states and its own
  selected period; a failure on one gateway never touches another's
  numbers (its late answer can only land in its own state map).
- Quota. Fetched with the same 30-second cycle and the same refresh click,
  from `/v1/magpie/quotas`. Quota is not period-scoped, so switching periods
  leaves it alone. A failure after a success keeps the rows and reads
  `Quota · stale` in the title; a first failure reads `Quota unavailable`.
  Usage stays visible either way.
- Key gateways. A key instance sends `Authorization: Bearer <key>` only to its
  own origin. A 401 or 403 reads `the gateway refused the key`. The key is
  masked in the form and never drawn.
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
  "Magpie isn't running" when a file gateway's address file is gone, "Magpie
  isn't answering" when the connection fails, "Magpie usage is unavailable"
  when the answer isn't usable usage data. Each with "Retrying every 30
  seconds." No error wall, no toasts.
- Nothing opens anything. Rows and bars are not clickable. The web UI is
  cookie-gated, so there is no click-through. A key instance sends its key
  only to its own gateway's origin.

## Built from

- `mods/magpie-stats/main.js`, one file, no assets. `mod.json` is
  `{"place": "none"}`, so it never docks by itself; open it from the + menu as
  a tab, or place a block by hand.
- The + menu needs two clones of shipped mods. The + button in `tabs`
  hardcodes `openOverlay({ mod: "new-menu", kind: "popup" })`, and shipped mods
  are rewritten on every start, so patch copies:
  - `mods/magpie-tabs/main.js`: the `tab-new` button opens `magpie-menu`.
  - `mods/magpie-menu/main.js`: one row after Terminal,
    `run("tab.new", { name: "Magpie stats", space: space?.id, mod: "magpie-stats" })`,
    and the fixed height constant 167 becomes 198.
  - The shown layout's tabs block names `magpie-tabs`.
  To place a sidebar block instead, add:
  `{"id": "magpie", "type": "block", "size": {"px": 240}, "min": 60, "content": {"mod": "magpie-stats"}}`.
- herdr functions used: `home()`, `appHome()`, `readTextFile()`,
  `writeTextFile()` (compare-and-swap), `theme()`, `InputState`/`Input` from
  gpui-base, and the built-in `fetch` with a `headers` option. No app
  commands, no `exec`, no programs.
- Watch list: `<appHome>/magpie-stats-instances.json`, one of two shapes per
  entry:
  `{"id":"i-…","name":"…","kind":"file","addressFile":"…"}` or
  `{"id":"i-…","name":"…","kind":"key","url":"http://host:port","key":"…"}`.
  A missing `kind` reads as `file`. The list is written only through a
  compare-and-swap read-merge-write with a bounded retry, so several docked
  copies share one list safely. The built-in Magpie gateway is derived, never
  stored. Each docked copy remembers its selected gateway in its own
  localStorage.
- Data source per gateway: `GET {origin}/v1/magpie/usage?period=today|7d|30d|all`
  and `GET {origin}/v1/magpie/quotas`. A file instance reads its address file
  on every request (default `~/.config/magpie/gateway.json`) and accepts
  loopback hosts only. A key instance uses its stored origin and sends
  `Authorization: Bearer <key>`. The endpoints are the ones magpie's Usage
  page reads, `internal/gateway/usage_api.go` in magpie's source.
- Structure: per gateway a `Map` from period to one of four states (loading /
  ready / stale / unavailable) plus a quota state of the same four kinds,
  owned by one runtime object captured before each fetch. One method owns all
  writes. A response is validated in full before it becomes a snapshot, and
  malformed data becomes "unavailable", never zero-filled numbers.

## Watch out

- File gateways stay loopback only, by design. magpie's usage endpoint answers
  this machine without a key and refuses other machines unless sharing is on
  with a key. A key gateway may point at any http or https origin; the key
  leaves this machine only to that origin. Do not add a key for a gateway you
  do not control.
- Keys sit in plain text in the watch list file under the app home. Treat that
  file as a secret. The form masks the key and the panel never draws it, but
  anyone who can read the file can use the key.
- The shipped + button and menu are rewritten on every start. The Magpie row
  lives in the two clones, so fixes to the shipped `tabs` or `new-menu` do not
  reach `magpie-tabs` or `magpie-menu` until you re-apply the three lines.
- A key URL is an origin only. Paths, queries, fragments, and credentials in
  the URL are rejected.
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
- The + menu lists Magpie stats and opens it as a tab. With magpie running, the
  panel shows Live, the cost matches
  `curl -s "http://127.0.0.1:3425/v1/magpie/usage?period=30d"`'s `cost`, and
  the quota rows match
  `curl -s "http://127.0.0.1:3425/v1/magpie/quotas"`.
- Adding a second gateway by address file (picker → `+ Add gateway` → Address
  file) shows it selected with its own numbers within a tick, and the header
  carries a second dot. Stopping only that gateway leaves the first one Live.
- Adding a key gateway against a gateway that requires a key shows that
  gateway's numbers. A wrong key reads `the gateway refused the key`.
- Switching periods twice quickly leaves the second period's numbers on
  screen, not the first's.
- Stopping magpie keeps the last numbers with a Stale status and the
  `Can't refresh` footer; deleting `gateway.json` (or pointing it at a closed
  port) with no cache shows the quiet "isn't running" / "isn't answering"
  state, and both recover on their own once magpie is back.
- `node .kimi-code/skills/verify-magpie-stats-registry/check.mjs` prints
  `all properties hold on the real code`.
