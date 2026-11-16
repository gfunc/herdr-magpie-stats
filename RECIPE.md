# Magpie stats

A Herdr panel that copies magpie's Usage overview: spend, four headline
tiles, a token chart, every agent and model that routed traffic, the
accounts and gateway keys behind them, and the remaining quota or balance of
each allowance. It opens from the window's + menu as a tab, or docks in a
sidebar, and it adapts its layout to the width it is given.

![Magpie stats](preview.png)

## What you see

The panel has four width tiers. Below 160 px it is a rail. Below 420 px it is
narrow. Below 760 px it is medium. At 760 px and above it is wide. Narrow and
medium keep one 560 px column. Wide keeps two 560 px columns with a 16 px gap.
The header and period row span the content.

- Header row. The selected gateway's name in semibold (the built-in one is
  named "Magpie"; click the name to switch or add gateways), a status word
  with a colored dot (Live, Stale, Offline or Unavailable), a 5 px dot per
  other watched gateway, and a refresh control (↻) that spins while a request
  is in flight.
- Gateway picker. Click the header name. One row per gateway, with its status
  dot and a `✕` to remove it. `+ Add gateway` opens a form with two type
  buttons, **Address file** and **URL + key**. Address file asks for Name and
  Address file. URL + key asks for Name, URL, and API key. A failure keeps
  what you typed and says why inline.
- Period row. Four equal segments, Today / 7D / 30D / All. The selected one
  has the raised background. 30D is the default.
- Cost line. `≈$2.54` in semibold, beside `effective prices`, or
  `N calls unpriced` when some calls had no known price.
- Allowances. In medium and wide, one card per account, two cards per row.
  A card shows the account name, its plan and user, one line per window
  (name, remaining percentage, reset time, a 3 px bar), and the balance string
  when it has one. Narrow keeps compact rows: the accounts closest to their
  limit first, then a `Balance` line and any refused account. `Allowances ·
  stale` means the last answer could not be refreshed.
- Tiles. Four of them: tokens (input plus output, with `in · out` under),
  cache read (with `hit rate N%`), reasoning (`inside output`), and calls
  (with failed, retried, canceled and unpriced counts). Narrow stacks them two
  by two. Medium and wide keep one row.
- Chart. One bar per hour, day, or week, with input stacked dim under output.
  The height follows the tier: 32 px, 56 px, or 72 px. A peak label sits at
  the right, about six date labels under the bars, and a hover gives the
  bucket's tokens, calls, and cost. An empty period shows "No calls in this
  period".
- Agents. One row per agent, all of them. The left side is the name and a
  wrapped sub-line: provider, calls, failed, looped, retried, canceled, mean
  first token (TTFT), decode speed, and any calls magpie made by itself. A
  4 px bar shows its share of the period's tokens. The right side is the token
  count with `in · out · cached` under it, and the cost.
- Models, Accounts, Gateway keys. The same row shape, in that order. Accounts
  and Gateway keys appear only when the gateway reports any.
- Narrow rows stack. Name and cost come first, then the sub-line, then the
  share bar and the token count.
- Rail. In a sidebar narrower than 160 px the panel is the selected gateway's
  first letter with its status dot, one dot per other gateway, and a refresh
  click.

## How it behaves

- Live. The selected period refreshes every 30 seconds, and on first show.
  Each gateway keeps its own states and its own selected period. A failure on
  one gateway never touches another's numbers.
- Allowances. Fetched with the same cycle from `/v1/magpie/quotas`. Quota is
  not period-scoped, so switching periods leaves it alone. A failure after a
  success keeps the last cards and marks the title stale. A first failure
  shows `Quota unavailable`. Usage stays visible either way.
- Key gateways. A key instance sends `Authorization: Bearer <key>` only to
  its own origin. A 401 or 403 reads `the gateway refused the key`. The key is
  masked in the form and never drawn.
- Period switch. Clicking a segment shows that period from its cache and
  refreshes it when the data is older than 30 seconds. A late answer for a
  period you left updates only that period's cache.
- Refresh click forces a fetch of the selected period and the allowances. The
  control spins while the request is in flight.
- Failure after success. The last numbers stay, the status becomes Stale, and
  a footer reads `Can't refresh · updated 14:32`. Hover it for the reason.
- Gateway down. One quiet state instead of numbers: "Magpie isn't running"
  when a file gateway's address file is gone, "Magpie isn't answering" when
  the connection fails, "Magpie usage is unavailable" when the answer is not
  usable usage data. Recovery is automatic.
- Nothing opens anything. Rows and bars are not clickable. A key instance
  sends its key only to its own gateway's origin.

## Built from

- `mods/magpie-stats/main.js`, one file, no assets. `mod.json` is
  `{"place": "none"}`, so it never docks by itself. Open it from the + menu as
  a tab, or place a block by hand:
  `{"id": "magpie", "type": "block", "size": {"px": 240}, "min": 60, "content": {"mod": "magpie-stats"}}`.
- The + menu needs two clones of shipped mods. The + button in `tabs`
  hardcodes `openOverlay({ mod: "new-menu" })`, and shipped mods are rewritten
  on every start, so patch copies:
  - `mods/magpie-tabs/main.js`: the `tab-new` button opens `magpie-menu`.
  - `mods/magpie-menu/main.js`: one row after Terminal,
    `run("tab.new", { name: "Magpie stats", space: space?.id, mod: "magpie-stats" })`,
    and the fixed height constant 167 becomes 198.
  - The shown layout's tabs block names `magpie-tabs`.
- herdr functions used: `home()`, `appHome()`, `readTextFile()`,
  `writeTextFile()` (compare-and-swap), `theme()`, `InputState`/`Input` from
  gpui-base, and the built-in `fetch` with a `headers` option. No app
  commands, no `exec`, no programs.
- Watch list: `<appHome>/magpie-stats-instances.json`, one of two shapes per
  entry: `{"id":"i-…","name":"…","kind":"file","addressFile":"…"}` or
  `{"id":"i-…","name":"…","kind":"key","url":"http://host:port","key":"…"}`.
  A missing `kind` reads as `file`. The list is written only through a
  compare-and-swap read-merge-write with a bounded retry, so several copies
  share one list safely. The built-in Magpie gateway is derived, never stored.
- Data source per gateway: `GET {origin}/v1/magpie/usage?period=today|7d|30d|all`
  and `GET {origin}/v1/magpie/quotas`. A file instance reads its address file
  on every request and accepts loopback hosts only. A key instance uses its
  stored origin and sends `Authorization: Bearer <key>`. The usage answer is
  the one magpie's Usage page reads. Its Overview is
  `internal/gui/assets/plugins/usage/` in magpie's source.
- Structure: one `UsagePageSnapshot` per period with totals, chart points, and
  four row lists. One `parseUsageRow` validates all four lists. One
  `tierOf(width)` decides the layout tier. A quota state of four kinds sits
  beside each gateway's period map, owned by the runtime captured before each
  fetch.
- Width constants: `RAIL_WIDTH` 160, `NARROW_WIDTH` 420, `MEDIUM_WIDTH` 760,
  `COLUMN_WIDTH` 560, `COLUMN_GAP` 16. Change these to retune the layout.

## Watch out

- Scope. This copies the Usage page's Overview. The Requests, Sessions and
  Context tabs are separate views and are not copied. Row actions (hide an
  agent, set a model price, clear usage) and the allowance trend curves are
  not copied either. The quotas payload carries no history.
- Tokens count input plus output, as the page does by default. Cache read and
  written sit in the tooltips and row sub-values, not in the token totals.
- File gateways stay loopback only. A key gateway may point at any http or
  https origin; the key leaves this machine only to that origin. Do not add a
  key for a gateway you do not control.
- Keys sit in plain text in the watch list file under the app home. Treat that
  file as a secret.
- The shipped + button and menu are rewritten on every start. The Magpie row
  lives in the two clones, so fixes to the shipped `tabs` or `new-menu` do not
  reach them until you re-apply the three lines.
- A key URL is an origin only. Paths, queries, fragments, and credentials are
  rejected.
- Each gateway's address file is re-read on every refresh, so a gateway
  restarted on a new port heals within one cycle. Do not cache it.
- Added address files must be absolute paths inside the user's home (`~`
  expands).
- The runtime's JavaScript has no locale data. The formatters (cost,
  thousands grouping, clock time, token counts) are hand-written. Keep them
  that way.
- The chart keeps the last 30 series points. A longer period shows the last 30
  buckets while the totals cover everything.
- Responses over Herdr's 8 MiB fetch cap fail into the unavailable state.
  Period payloads here measure 6 to 14 KB.
- Redirects are rejected (`response.url` must equal the request), so a proxy
  or captive portal becomes "unavailable" rather than trusted output.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/magpie-stats` passes.
- The + menu lists Magpie stats and opens it as a tab. Wide shows two columns
  of 560 px. Narrowing the pane to a sidebar stacks it into one column, and
  below 160 px it becomes the rail.
- With magpie running, the panel shows Live, the cost and calls match
  `curl -s "http://127.0.0.1:3425/v1/magpie/usage?period=30d"`, and the
  allowance cards match `curl -s "http://127.0.0.1:3425/v1/magpie/quotas"`.
- The Agents, Models, Accounts and Gateway keys lists show every row the
  gateway reports, with its tokens, share, and cost.
- Adding a key gateway against a gateway that requires a key shows that
  gateway's numbers. A wrong key reads `the gateway refused the key`.
- Switching periods twice quickly leaves the second period's numbers on
  screen.
- Stopping magpie keeps the last numbers with a Stale status and the
  `Can't refresh` footer, and the quiet down states recover on their own.
- `node .kimi-code/skills/verify-magpie-stats-registry/check.mjs` prints
  `all properties hold on the real code`, and `unit.mjs` prints
  `26 passed, 0 failed`.
