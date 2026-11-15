---
name: verify-magpie-stats
description: Verify the magpie-stats Herdr mod live, on this machine, in an isolated herdr home — launch the panel against real or mock magpie gateways, drive its state via files and the herdr-app CLI, and capture screenshot evidence. Use when changing mods/magpie-stats, adding a mod feature, or diagnosing why the panel shows wrong numbers or a wrong state.
---

# Verify magpie-stats

The mod is one file, `mods/magpie-stats/main.js`, docked as a sidebar block.
Verification means the panel shows the right thing on a real display, not that
it parses. This skill runs it against real magpie gateways on this machine
with no risk to the user's real Herdr or real magpie.

## Constants (verified this session)

- Repo: `~/projects/herdr-magpie-stats`
- herdr-app debug binary: `~/projects/herdr-app/target/debug/herdr-app`
- X11 runtime libs it needs on this machine:
  `LD_LIBRARY_PATH=/var/tmp/herdr-app-scratch/x11-dev/usr/lib/x86_64-linux-gnu`
  (if that dir is gone, install libxkbcommon-x11-dev properly; the binary
  will not start without it)
- Xvfb display: pick a fresh number, e.g. `:77` (`Xvfb :77 -screen 0
  1280x820x24 &`). **Do not trust `xdpyinfo` to probe it — not installed.
  Probe with `DISPLAY=:77 xdotool getdisplaygeometry`** (xdotool:
  `/home/linuxbrew/.linuxbrew/bin/xdotool`).
- **Pointer clicks do not reach the app on bare Xvfb.** GPUI's X11 backend
  logs `Found no xinput mouse pointers` and ignores button events; keyboard
  events do arrive. Drive everything through files and the herdr-app CLI
  (below). On a real desktop display or under Weston, clicks work and should
  be exercised there.

## Launch

```sh
# 1. scratch home with the mod under test
rm -rf /var/tmp/mstats-verify && mkdir -p /var/tmp/mstats-verify/home/mods
cp -r ~/projects/herdr-magpie-stats/mods/magpie-stats /var/tmp/mstats-verify/home/mods/

# 2. isolated second gateway (its whole config dir under home, XDG-scoped)
mkdir -p ~/.config/mstats-gw2
XDG_CONFIG_HOME=$HOME/.config/mstats-gw2 MAGPIE_ADDR=127.0.0.1:3525 \
  ~/.local/bin/magpie serve &> /var/tmp/mstats-verify/gw2.log &
# gateway.json lands at ~/.config/mstats-gw2/magpie/gateway.json

# 3. display + app
Xvfb :77 -screen 0 1280x820x24 &> /var/tmp/mstats-verify/xvfb.log &
HERDR_APP_HOME=/var/tmp/mstats-verify/home DISPLAY=:77 \
  LD_LIBRARY_PATH=/var/tmp/herdr-app-scratch/x11-dev/usr/lib/x86_64-linux-gnu \
  ~/projects/herdr-app/target/debug/herdr-app &> /var/tmp/mstats-verify/app.log &
```

The real gateway at `~/.config/magpie/gateway.json` is read-only for this
test; the mod never writes to it, and no test step may touch it except the
one backup/restore dance in the down-state feature file.

**Never run the binary without `HERDR_APP_HOME` pointing at the scratch
home**, and never run two app instances on one home: the second overwrites
the first's localStorage writes (this session's selection races were exactly
that). One home, one app process. `pgrep -af 'debug/herdr-app'` before
starting.

The block does not dock itself on a fresh home if the layout was already
initialized. Insert it into `home/layouts/main.json` under the
`sidebar-lists` column (this is also how the RECIPE says to place it by
hand):

```json
{"id": "magpie", "type": "block", "size": {"px": 240}, "min": 60,
 "content": {"mod": "magpie-stats"}}
```

If you edit main.json while the app is NOT running, Herdr may treat the
edited shipped layout as personal and set it aside as `main-edited.json` on
the next start, restoring the stock one. Insert the block while the app runs
(edits apply live), or re-check after a restart that the block is still in
the shown layout.

Ready = `herdr-app status` (with the env prefix) prints a JSON layout and
`errors: []`, and a first screenshot shows the sidebar. Teardown is in
Cleanup.

## Doctor

Run before the first drive and after anything surprising:

```sh
alias H='env LD_LIBRARY_PATH=/var/tmp/herdr-app-scratch/x11-dev/usr/lib/x86_64-linux-gnu HERDR_APP_HOME=/var/tmp/mstats-verify/home ~/projects/herdr-app/target/debug/herdr-app'
H status            # layout name, errors: [] — no errors means the mod loaded
```

- `status` errors mention the mod → the mod's top-level code threw; read
  `/var/tmp/mstats-verify/app.log`.
- No block in the sidebar → layout lost the magpie node (see Launch note).
- Numbers frozen across 2+ ticks (wait 35 s) → the gateway is down or the
  address file path is wrong; `curl -s http://127.0.0.1:3425/v1/magpie/usage?period=30d`
  (real) or `:3525` (gw2) proves the gateway side.

## Drive

There is no pointer input (see Constants). The mod's inputs are files and
time; drive them:

- Registry (shared watch list): write
  `/var/tmp/mstats-verify/home/magpie-stats-instances.json`, shape
  `{"version":1,"instances":[{"id":"i-...","name":"...","addressFile":"<abs under home>"}]}`.
  Adopted within one 30 s tick. The default gateway (id `default`) is
  derived, never stored.
- Selection (per docked copy): write
  `/var/tmp/mstats-verify/home/data/magpie-stats/store.json` to
  `{"selectedInstanceId":"i-..."}`, then restart the app process (init reads
  it once; hot-reloading the mod file does NOT re-run init against changed
  storage).
- Sidebar width: `H do layout.resize --id sidebar --px 60` (rail) or `240`.
- Period row / picker / refresh are click-only; on bare Xvfb verify their
  effects via the state readout recipe in
  [features/live-usage-panel.md](features/live-usage-panel.md) or drive them
  on a real display.

Evidence: `H shot /var/tmp/mstats-verify/shot-<n>-<what>.png` after every
state change, always after waiting one 30 s tick where the change rides the
tick. Read the PNG before claiming what it shows.

## Cleanup

```sh
pkill -f 'target/debug/herdr-app'          # only if you own every match; check with pgrep first
pkill -f 'XDG_CONFIG_HOME=.*/mstats-gw2'   # the scratch gateway
pkill -f 'Xvfb :77'
rm -rf /var/tmp/mstats-verify/home /var/tmp/mstats-verify/*.log ~/.config/mstats-gw2
```

Never kill the real magpie (`~/.local/bin/magpie serve --web`, the one whose
gateway.json sits in `~/.config/magpie/`). Evidence PNGs survive: they stay
in `/var/tmp/mstats-verify/` until the next run's `rm -rf home` misses them
(only `home/` and logs are removed). Copy any shot you cite into the repo's
`.scratch/<task>/` before a fresh run.

## Helpers

No scripts ship. Everything above is copy-paste shell; the two `alias`-style
env prefixes (LD_LIBRARY_PATH + HERDR_APP_HOME, the latter varying per run)
are the only fiddly parts.

## Feature map

- [features/README.md](features/README.md) — index
- [features/live-usage-panel.md](features/live-usage-panel.md) — the panel:
  live numbers, period row, chart, models
- [features/multi-gateway.md](features/multi-gateway.md) — watch list,
  switching, per-instance state isolation
- [features/down-states.md](features/down-states.md) — stale, not-running,
  isn't-answering, rail mode
