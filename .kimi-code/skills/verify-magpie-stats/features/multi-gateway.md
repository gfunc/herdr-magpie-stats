# Multi-gateway

## Sub-features

- Shared watch list (`<appHome>/magpie-stats-instances.json`), adopted within
  one 30 s tick; derived `default` gateway always present.
- Per-copy selection (`data/magpie-stats/store.json`), persisted, restored on
  app start; a removed selection falls back to default.
- Header title slot shows the selected instance's name; at N≥2 one 5 px dot
  per other instance.
- Per-instance period state: each instance keeps its own states/inFlight;
  picker rows show each instance's own status dot.

## How to get to it (user POV)

Click the header name to open the picker (switch/add/remove; add form with
Name + Address file inputs). Removing the watched gateway you're on falls
back to Magpie. On a real display this is all clickable; on bare Xvfb use
the file drives below.

## Driving it with files + CLI (bare Xvfb)

1. Launch with the scratch gw2 (skill Launch step 2).
2. Write the registry:
   `{"version":1,"instances":[{"id":"i-gw2","name":"magpie-2","addressFile":"<home>/.config/mstats-gw2/magpie/gateway.json"}]}`
   to `<home>/magpie-stats-instances.json`. Wait 35 s, shot: the header gains
   a second dot.
3. Select it: write `{"selectedInstanceId":"i-gw2"}` to
   `<home>/data/magpie-stats/store.json`, then kill and restart the app
   process (init reads storage once). Shot: header reads `magpie-2`, numbers
   are gw2's (empty gateway: `$0.00`, `0 calls`, `No calls in this period`).
4. State readout recipe (scratch-home instrumentation only, never the repo
   copy): append to the header `.child(...)` a string evaluating
   `this.runtimeFor(id).states.get(period).kind` for the selected instance
   and for `"default"`. That turns any state claim into a screenshot-legible
   fact. Delete before finishing.
5. Isolation: `kill <gw2 pid>`, wait 35 s, shot. Selected instance goes
   `stale` (or `unavailable` if it never got data) while `default` stays
   `ready`. Numbers of the dead one stay on screen.
6. Removal fallback: rewrite the registry with `"instances": []`, wait 35 s,
   shot: header back to `Magpie`, default's numbers, no error.

## Gotchas

- Only ONE app process per home. Two overlapping instances race their
  localStorage writes and you will chase ghost selections (measured this
  session).
- Restarting the app can set your edited `main.json` aside as
  `main-edited.json` (shipped-layout protection). Re-check the block exists
  after any restart.
- Registry entries must be absolute paths under the user's home (`~`
   expands). `/var/tmp` paths are rejected by design — point scratch
   gateways at `~/.config/<name>/`.
- The add form is click-only; its validation layer (`parseInstanceDraft`)
   is covered by the unit harness shipped with the formal skill:
   `node .kimi-code/skills/verify-magpie-stats-registry/unit.mjs`.
