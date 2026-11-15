# Live usage panel

## Sub-features

- Cost line for the selected period, with `+ N unpriced` when present.
- Calls line with errors count in the blocked color at nonzero.
- Token line (in / out / cache read) with full breakdown tooltip.
- Bar chart, one bar per bucket (hour for Today, day for 30D).
- Models section: top rows by tokens with share.
- Period row: Today / 7D / 30D / All, 30D default.
- Refresh control (↻): click-only; on bare Xvfb verify via numbers advancing.

## How to get to it (user POV)

The panel is always in the left sidebar. It loads 30D on first show and
refreshes every 30 seconds. Numbers are the gateway's own
`/v1/magpie/usage` answer for the period.

## Driving it with files + CLI (bare Xvfb)

1. Launch per the skill's Launch; the default gateway is the real one at
   `~/.config/magpie/gateway.json`.
2. `H shot .../shot-panel.png` after ~2 s (first fetch) and again after 35 s.
3. Compare against the gateway directly:
   `curl -s "http://127.0.0.1:3425/v1/magpie/usage?period=30d" | python3 -m json.tool`
   — the panel's cost must equal `cost` to the cent (formatCost rounds to 2
   decimals), calls equal `calls`, and the bar count equal `len(series)`.

## Gotchas

- Period switching is click-only. On bare Xvfb, verify the per-period cache
  logic only via the state readout recipe (multi-gateway.md), or drive on a
  real display.
- The numbers legitimately move between screenshots (live gateway); compare
  curl-to-shot taken seconds apart, allowing small drift, or snapshot a
  quiet period.
- The runtime has no Intl: if you ever see a raw float where currency
  should be, that's the no-Intl trap the RECIPE warns about — a regression
  in the hand formatters.
