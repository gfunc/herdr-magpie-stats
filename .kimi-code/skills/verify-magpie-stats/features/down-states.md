# Down states

## Sub-features

- Stale (failure after success): last numbers stay, status word Stale,
  `Can't refresh · updated HH:MM` footer.
- Not-running: address file absent → "Magpie isn't running", retrying.
- Unreachable ("isn't answering"): connection refused.
- Unavailable ("usage is unavailable"): unusable answer (bad JSON, redirect).
- Rail: below 160 px width, one letter + status dot, click refreshes (on a
  real display).

## How to get to it (user POV)

Nothing to click. Kill the gateway or move its address file; the panel
quiets itself and recovers on its own within one 30 s cycle.

## Driving it with files + CLI (bare Xvfb)

1. Stale: with a ready snapshot on screen, `kill <gw2 pid>` (address file
   still present), wait 35 s, shot. Expect `stale` state, last numbers
   kept, footer present.
2. Not-running: `mv <gw2 config>/magpie/gateway.json{,.bak}` with the
   gateway dead, wait 35 s, shot. Expect "Magpie isn't running". Restore
   with `mv` back.
3. Isn't answering: gateway dead but address file present (that is the
   stale test's first tick; the distinction shows in the problem tooltip).
4. Rail: `H do layout.resize --id sidebar --px 60`, shot. Expect the
   instance initial + status dot centered in the narrow strip.
5. Recovery: restart gw2 (same XDG_CONFIG_HOME + MAGPIE_ADDR), wait 35 s,
   shot: back to Live with fresh numbers, no restart of the app needed.

## Gotchas

- These states are per-instance: killing gw2 must never disturb the default
   gateway's panel — if it does, that's the isolation invariant breaking
   and a real bug.
- The real gateway's gateway.json must be restored byte-for-byte if you
   ever borrow it for the default's down-state test: `cp` it aside, never
   `mv` without an immediate restore plan, and diff afterwards. Prefer
   testing down-states on gw2 only.
