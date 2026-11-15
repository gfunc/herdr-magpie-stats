#!/usr/bin/env node
// Formal check for the magpie-stats registry core: extracts the REAL
// functions from mods/magpie-stats/main.js and exhaustively drives the
// interleavings two concurrent updateRegistry writers actually have, over a
// mock file whose writeTextFile is compare-and-swap (CAS), as in herdr.
//
// Properties (each has a negative control; run with --break=1|2|3):
//  1 convergence — two concurrent changes over one file both land; no lost
//    update, no duplicate entry, whatever the interleaving.
//  2 validator totality — every malformed registry shape in the corpus is
//    rejected as bad-registry; valid shapes (including a null file) pass.
//  3 idempotence — replaying a change (retry after a lost CAS race) equals
//    applying it once; removing a missing id or "default" changes nothing.
//
// Usage: node check.mjs [--break=1|2|3]   (from anywhere; paths resolve)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const modPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mods", "magpie-stats", "main.js");
const source = readFileSync(modPath, "utf8");

function extract(name) {
  const fn = `function ${name}(`;
  const asyncFn = `async ${fn}`;
  const at = source.indexOf(asyncFn);
  const start = at >= 0 ? at : source.indexOf(fn);
  if (start < 0) throw new Error(`${name} not found in main.js`);
  let i = source.indexOf("{", start), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") if (--depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const NAMES = ["expandTilde", "defaultInstance", "newInstanceId", "parseRegistry",
  "parseInstanceDraft", "applyRegistryChange", "isAbsolutePath", "isUnderHome",
  "readRegistry", "updateRegistry", "asRegistryProblem"];
const realBodies = NAMES.map(extract).join("\n\n");

const HOME = "/home/u";
const inst = (n) => ({ id: `i-${n}`, name: `gw-${n}`, addressFile: `${HOME}/.config/magpie-${n}/gateway.json` });
const rawOf = (arr) => JSON.stringify({ version: 1, instances: arr });

// A store plus optional race injection: the first CAS attempt whose expected
// matches is made to lose (a racer writes first), exactly the window between
// a writer's readRegistry and writeTextFile.
function makeStore(raw, { raceFirstWrite = false, racerRaw = null } = {}) {
  return { raw, raceFirstWrite, racerRaw, raced: false };
}

function makeApi(bodies, store) {
  const writeTextFile = async (_path, text, expected) => {
    const matches = expected === null ? store.raw === null : store.raw === expected;
    if (matches && store.raceFirstWrite && !store.raced) {
      store.raced = true;
      store.raw = store.racerRaw;
      throw new Error("stale snapshot");
    }
    if (!matches) throw new Error("stale snapshot");
    store.raw = text;
    return true;
  };
  const readTextFile = async () => store.raw;
  const body = '"use strict";\n' +
    'const REGISTRY_ATTEMPTS = 4;\n' +
    'const REGISTRY_PATH = () => "/home/u/.config/herdr/magpie-stats-instances.json";\n' +
    'function bad(kind, detail) { return { kind, detail }; }\n' +
    bodies + '\n' +
    'return { parseRegistry, parseInstanceDraft, applyRegistryChange, readRegistry, updateRegistry, newInstanceId, defaultInstance };';
  return new Function("home", "appHome", "readTextFile", "writeTextFile", body)(
    () => HOME, () => HOME + "/.config/herdr", readTextFile, writeTextFile);
}

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : " — " + detail}`);
  if (!ok) failures++;
}

async function propertyConvergence(bodies) {
  const scenarios = [
    ["add+add", { kind: "add", instance: inst(1) }, { kind: "add", instance: inst(2) }],
    ["add+remove-same", { kind: "add", instance: inst(1) }, { kind: "remove", id: "i-1" }],
    ["remove+add", { kind: "remove", id: "i-9" }, { kind: "add", instance: inst(3) }],
    ["add+add-same", { kind: "add", instance: inst(4) }, { kind: "add", instance: inst(4) }],
    ["remove+remove", { kind: "remove", id: "i-5" }, { kind: "remove", id: "i-5" }],
  ];
  for (const [label, a, b] of scenarios) {
    for (const racer of [false, true]) {
      // ONE shared store: both writers' compare-and-swap writes go through
      // the same slot, so a writer whose expected text went stale fails and
      // retries, exactly as against the real single file. racer=true injects
      // an external write (a third docked copy adding i-8) between the first
      // matching CAS attempt and its retry.
      const external = inst(8);
      const start = [inst(9), inst(5)];
      const store = makeStore(rawOf(start), racer
        ? { raceFirstWrite: true, racerRaw: rawOf([...start, external]) }
        : {});
      const api = makeApi(bodies, store);
      const settled = await Promise.allSettled([api.updateRegistry(a), api.updateRegistry(b)]);
      const rejected = settled.find(s => s.status === "rejected");
      if (rejected) {
        check(`convergence ${label}/racer=${racer}`, false, `a writer gave up: ${String(rejected.reason?.kind ?? rejected.reason)}`);
        continue;
      }
      const [ra, rb] = settled.map(s => s.value);
      let final = null;
      try { final = api.parseRegistry(store.raw); } catch (e) { final = null; }
      if (final === null) { check(`convergence ${label}/racer=${racer}`, false, `final file unparsable: ${store.raw}`); continue; }
      const pure = makeApi(bodies, makeStore(null));
      const base = racer
        ? pure.applyRegistryChange({ additional: [...start] }, { kind: "add", instance: external })
        : { additional: [...start] };
      // A concurrent execution is correct when it equals SOME linearization:
      // a-then-b or b-then-a (a conflicting pair may reject one order; that
      // order then simply isn't reachable and the other must match).
      const outcomes = new Set();
      for (const [first, second] of [[a, b], [b, a]]) {
        try {
          const o = pure.applyRegistryChange(pure.applyRegistryChange(base, first), second);
          outcomes.add(o.additional.map(e => e.id).sort().join(","));
        } catch { /* conflicting order not reachable */ }
      }
      const gotIds = final.additional.map(e => e.id).sort().join(",");
      check(`convergence ${label}/racer=${racer}`, outcomes.has(gotIds),
        `got [${gotIds}] want one of [${[...outcomes].join(" | ")}]`);
      check(`no-duplicates ${label}/racer=${racer}`, new Set(final.additional.map(e => e.id)).size === final.additional.length);
    }
  }
}

async function propertyIdempotence(bodies) {
  // Two separate homes: one replayed add, one single add. The files and the
  // returned registries must be structurally equal (object identity cannot
  // survive a re-parse and is not the promise).
  const s1 = makeStore(rawOf([inst(7)]));
  const s2 = makeStore(rawOf([inst(7)]));
  const api1 = makeApi(bodies, s1);
  const api2 = makeApi(bodies, s2);
  const run = (api, c) => api.updateRegistry(c).then(v => ({ ok: true, v }), e => ({ ok: false, e }));
  const r1s = await run(api1, { kind: "add", instance: inst(8) });
  const r1bs = await run(api1, { kind: "add", instance: inst(8) });
  const r2s = await run(api2, { kind: "add", instance: inst(8) });
  for (const [tag, r] of [["first add", r1s], ["replayed add", r1bs], ["single add", r2s]]) {
    if (!r.ok) { check(`${tag} resolves`, false, String(r.e?.kind ?? r.e)); return; }
  }
  const r1 = r1s.v, r1b = r1bs.v, r2 = r2s.v;
  check("replayed add leaves the file identical to a single add", s1.raw === s2.raw,
    `replay produced ${s1.raw} vs single ${s2.raw}`);
  check("replayed add reports the same registry", JSON.stringify(r1.additional) === JSON.stringify(r1b.additional));
  const r3s = await run(api1, { kind: "remove", id: "i-404" });
  check("remove of a missing id changes nothing", r3s.ok && JSON.stringify(r3s.v.additional) === JSON.stringify(r1.additional) && s1.raw === s2.raw);
  const r4s = await run(api1, { kind: "remove", id: "default" });
  check("remove of default changes nothing", r4s.ok && JSON.stringify(r4s.v.additional) === JSON.stringify(r1.additional));
}

function propertyValidator(bodies) {
  const api = makeApi(bodies, makeStore(null));
  const malformed = [
    "not json", "{}", "[]", "null", '{"version":2,"instances":[]}',
    '{"version":1}', '{"version":1,"instances":{}}',
    '{"version":1,"instances":[null]}',
    '{"version":1,"instances":[{"id":"x","name":"a","addressFile":"/home/u/a.json"}]}',
    '{"version":1,"instances":[{"id":"i-1","name":"","addressFile":"/home/u/a.json"}]}',
    `{"version":1,"instances":[{"id":"i-1","name":"${"x".repeat(25)}","addressFile":"/home/u/a.json"}]}`,
    '{"version":1,"instances":[{"id":"i-1","name":"a","addressFile":"rel/path.json"}]}',
    '{"version":1,"instances":[{"id":"i-1","name":"a","addressFile":"/etc/magpie/gateway.json"}]}',
    '{"version":1,"instances":[{"id":"i-1","name":"a"},{"id":"i-1","name":"b","addressFile":"/home/u/b.json"}]}',
    '{"version":1,"instances":[{"id":"i-1","name":"a","addressFile":"/home/u/a.json"},{"id":"i-2","name":"A","addressFile":"/home/u/b.json"}]}',
    '{"version":1,"instances":[{"id":"default","name":"d","addressFile":"/home/u/a.json"}]}',
    '{"version":1,"instances":[{"id":"i-1","name":"a"}]}',
  ];
  let rejected = 0;
  for (const text of malformed) {
    try {
      api.parseRegistry(text);
      console.log(`  (accepted malformed: ${text.slice(0, 70)})`);
    } catch (e) {
      if (e && e.kind === "bad-registry") rejected++;
      else console.log(`  (wrong rejection for ${text.slice(0, 40)}: ${e?.kind ?? e})`);
    }
  }
  check("validator rejects every malformed shape", rejected === malformed.length, `${rejected}/${malformed.length}`);
  let accepted = 0;
  for (const t of [null, rawOf([]), rawOf([inst(1)])]) {
    try { api.parseRegistry(t); accepted++; } catch { /* counted */ }
  }
  check("validator accepts valid shapes", accepted === 3, `${accepted}/3`);
}

// Negative controls: break one guard in the extracted code, expect failures.
function breakBodies(flag) {
  if (flag === "1") {
    // drop the duplicate-name check in parseRegistry
    return realBodies.replace('if (names.has(folded)) throw bad("bad-registry", `two gateways are named "${trimmed}"`);', "");
  }
  if (flag === "2") {
    // swallow the CAS rejection and return the stale registry object as if
    // the write landed: the change is silently lost.
    return realBodies.replace(
      `      failure = e;
      // Someone else wrote first; re-read and re-apply on the next attempt.`,
      `      return registry;`);
  }
  if (flag === "3") {
    // make add non-idempotent: drop the verbatim-duplicate early return
    return realBodies.replace(
      `  if (registry.additional.some((entry) =>
    entry.id === instance.id && entry.name === instance.name && entry.addressFile === instance.addressFile)) {
    return registry;
  }`,
      "");
  }
  throw new Error(`unknown break flag ${flag}`);
}

const args = process.argv.slice(2);
const breakArg = args.find(a => a.startsWith("--break="));
if (breakArg) {
  const flag = breakArg.slice(8);
  const bodies = breakBodies(flag);
  if (bodies === realBodies) { console.error(`break=${flag} did not match anything in the extracted code`); process.exit(2); }
  console.log(`--- negative control: break=${flag} ---`);
  failures = 0;
  await propertyConvergence(bodies);
  await propertyIdempotence(bodies);
  propertyValidator(bodies);
  if (failures === 0) { console.log(`FAIL negative control ${flag}: no property failed, the check cannot detect this break`); process.exit(1); }
  console.log(`ok: break=${flag} produced ${failures} failing check(s) — the property can fail`);
  process.exit(0);
}

console.log(`checking the real code from ${modPath}\n`);
await propertyConvergence(realBodies);
await propertyIdempotence(realBodies);
propertyValidator(realBodies);
if (failures) { console.log(`\n${failures} FAILING CHECK(S)`); process.exit(1); }
console.log("\nall properties hold on the real code");
