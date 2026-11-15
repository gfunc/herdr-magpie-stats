---
name: verify-magpie-stats-registry
description: Formally check the magpie-stats gateway-registry core — convergence of concurrent compare-and-swap updates, validator totality, retry idempotence — by exhaustive interleaving over the real functions extracted from mods/magpie-stats/main.js. Use after any change to parseRegistry, applyRegistryChange, readRegistry, updateRegistry, parseInstanceDraft, or the registry file format.
---

# Registry formal check

The gateway watch list (`<appHome>/magpie-stats-instances.json`) is written
by every docked copy through `writeTextFile`'s compare-and-swap with a
bounded retry loop. A bug here corrupts or silently loses a user's watch
list while tests would still pass in a single-window run. This check proves
the three properties that make the file safe, against the real code, in
under a second.

## What is verified

In plain words:

1. **Convergence.** Two copies changing the watch list at the same time
   (including a third copy writing in between) both land; the file ends
   equal to some sequential order of the changes, with no duplicate
   entries and no writer giving up.
2. **Validator totality.** Every malformed registry shape in a fixed
   corpus (bad JSON, wrong version, junk entries, duplicate ids,
   case-folded duplicate names, the reserved `default` id, relative or
   outside-home paths) is rejected; valid shapes (absent file, empty,
   populated) are accepted.
3. **Retry idempotence.** Replaying the same add after a lost CAS race
   leaves the file identical to a single add; removing a missing id or
   `default` changes nothing.

**Harm if broken:** a lost update means a user's added gateway vanishes on
a multi-window machine; a validator hole means a corrupt file becomes a
broken watch list instead of the quiet last-good-list fallback.

## Tool and why

A purpose-built exhaustive-interleaving checker (`check.mjs`, Node, no
dependencies), not a model checker: the functions are pure given the file
API, so the check extracts them verbatim from `main.js` and drives every
interleaving their `await` points actually create — both writers' orders,
plus an external racer — against a mock file whose write is CAS, exactly
like the runtime's. TLA+ would model the same three properties with an
installation this machine lacks; this checker runs the real code instead of
a transcription of it, which is the stronger guarantee here.

## Run it

```sh
node .kimi-code/skills/verify-magpie-stats-registry/check.mjs
```

Exit 0 and `all properties hold on the real code` is the pass. One run is
~26 checks, well under a second.

## Able to fail

Each property has a negative control that breaks the real code one way;
the check must FAIL on each break (`--break` exits 0 only when the break
was detected):

```sh
node .kimi-code/skills/verify-magpie-stats-registry/check.mjs --break=1  # drops the duplicate-name validator line
node .kimi-code/skills/verify-magpie-stats-registry/check.mjs --break=2  # swallows a CAS rejection, returns stale registry
node .kimi-code/skills/verify-magpie-stats-registry/check.mjs --break=3  # removes add's verbatim-duplicate early return
```

If a `--break` run ever reports the break did not fail any check, the
checker rotted: the extracted-code anchors no longer match `main.js`.
Fix the anchor (the exact strings in `breakBodies`), not the property.

## Coverage record

| Real code (mods/magpie-stats/main.js) | Properties |
| --- | --- |
| `parseRegistry` | 2 (totality) |
| `applyRegistryChange` | 1, 3 |
| `readRegistry` | 1 |
| `updateRegistry` (CAS retry loop) | 1, 3 |
| `parseInstanceDraft`, `expandTilde`, `isAbsolutePath`, `isUnderHome` | extracted; exercised via validator corpus paths |

The extraction is by function-boundary scan of `main.js`. If you rename or
move any listed function, update `NAMES` in `check.mjs`.

**Last confirmed against commit `e1f7899` (2026-11-16).** After changing
covered code, re-run the check and move this line to your commit only when
it passes there.

## Interpreting results

- A FAIL on the real code with `got [...] want one of [...]` means the
  concurrent result matched no sequential order — read it as "these two
  changes interleaved to a state neither order allows" and replay the
  scenario label by hand against `applyRegistryChange`.
- `a writer gave up` means `updateRegistry` exhausted its four attempts;
  under the model that only happens if the retry loop is broken (real runs
  may also hit it under extreme contention — the check treats it as a
  property failure because four CAS failures in a row with retries is not
  reachable in the model's interleavings).
- A `--break` crash (stack trace instead of FAIL lines) means the anchor
  string no longer matches the code shape: see Able to fail.

## Not covered

- The UI layer (picker, add form, selection persistence) — covered by the
  [verify-magpie-stats](../verify-magpie-stats/SKILL.md) skill instead.
- `gatewayOrigin`/`parseUsage` (gateway payload validation) — same,
  exercised live there.
- Filesystem durability (atomic rename semantics of `writeTextFile`) —
  trusted as the runtime's contract, mocked faithfully (CAS on expected).

After any registry change here, `/maintain-formal-verification-skill`
re-runs this against new commits and judges drift.
