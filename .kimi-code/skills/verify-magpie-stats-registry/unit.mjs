// Unit layer for the registry logic in mods/magpie-stats/main.js.
// The pure functions are copied out of the mod file verbatim by locating
// each function (with its JSDoc) and brace-counting to its end, then run in
// a sandbox with a stubbed home(). Nothing is re-implemented here; if the
// mod's functions are wrong, these assertions fail.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../mods/magpie-stats/main.js");
const source = readFileSync(modPath, "utf8");

const NAMES = [
  "expandTilde", "defaultInstance", "newInstanceId", "parseRegistry",
  "parseInstanceDraft", "applyRegistryChange", "isAbsolutePath", "isUnderHome",
  "readRegistry", "updateRegistry", "asRegistryProblem", "bad",
];
const EXTRACT = ["bad", "isAbsolutePath", "isUnderHome", "expandTilde", "newInstanceId", "parseRegistry", "parseInstanceDraft", "applyRegistryChange"];
const RUNTIME = ["defaultInstance", "readRegistry", "updateRegistry", "asRegistryProblem"];

for (const name of [...NAMES]) {
  const count = source.split(`function ${name}(`).length - 1;
  if (count !== 1) throw new Error(`expected exactly one declaration of ${name}, found ${count}`);
}

function extractFunction(name) {
  const fnIdx = source.indexOf(`function ${name}(`);
  // Include the JSDoc when it sits immediately above the declaration.
  const docClose = source.lastIndexOf("*/", fnIdx);
  const between = source.slice(docClose + 2, fnIdx);
  const start = /^\s*$/.test(between) ? source.lastIndexOf("/**", docClose) : fnIdx;
  const openIdx = source.indexOf("{", fnIdx);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// home() is a live host call in the mod; the sandbox stubs it.
const sandboxSource = `
  function home() { return "/home/tester"; }
  ${EXTRACT.map(extractFunction).join("\n\n")}
  return { ${EXTRACT.join(", ")} };
`;
const mod = new Function(sandboxSource)();

for (const name of EXTRACT) {
  if (typeof mod[name] !== "function") throw new Error(`extraction produced no ${name}`);
}
// Negative control: the sandbox must not be able to see host file APIs.
if (typeof readTextFile !== "undefined") throw new Error("sandbox leak: readTextFile visible");

let passed = 0;
const failures = [];
function check(label, condition) {
  if (condition) { passed++; console.log(`PASS ${label}`); }
  else { failures.push(label); console.log(`FAIL ${label}`); }
}
function throwsKind(label, kind, fn) {
  try {
    fn();
    check(label, false);
  } catch (e) {
    check(`${label} (kind=${e?.kind})`, typeof e === "object" && e !== null && e.kind === kind);
  }
}

const HOME = "/home/tester";
const inst = (id, name, file) => ({ id, name, addressFile: file });
const file = (n) => `${HOME}/.config/magpie/gateway-${n}.json`;

// (a) null text -> empty registry
{
  const r = mod.parseRegistry(null);
  check("(a) parseRegistry(null).additional is []", Array.isArray(r.additional) && r.additional.length === 0);
}

// (b) valid add flow
{
  const empty = { additional: [] };
  const a = inst("i-aaa", "magpie-2", file(2));
  const r1 = mod.applyRegistryChange(empty, { kind: "add", instance: a });
  check("(b) add appends one entry", r1.additional.length === 1 && r1.additional[0].id === "i-aaa" && r1.additional[0].name === "magpie-2" && r1.additional[0].addressFile === file(2));
  const parsed = mod.parseRegistry(JSON.stringify({ version: 1, instances: [a] }));
  check("(b) written shape parses back", parsed.additional.length === 1 && parsed.additional[0].addressFile === file(2));
}

// (c) duplicate id rejected
{
  const base = { additional: [inst("i-dup", "one", file(1))] };
  throwsKind("(c) add with used id throws invalid-instance", "invalid-instance",
    () => mod.applyRegistryChange(base, { kind: "add", instance: inst("i-dup", "two", file(2)) }));
}

// (d) duplicate name, case-insensitive
{
  const base = { additional: [inst("i-one", "magpie-2", file(1))] };
  throwsKind("(d) case-folded duplicate name throws invalid-instance", "invalid-instance",
    () => mod.applyRegistryChange(base, { kind: "add", instance: inst("i-two", "Magpie-2", file(2)) }));
}

// (e) the default id is rejected inside the file
{
  throwsKind("(e) id 'default' in the file throws bad-registry", "bad-registry",
    () => mod.parseRegistry(JSON.stringify({ version: 1, instances: [inst("default", "X", file(1))] })));
  throwsKind("(e) an id without the i- prefix throws bad-registry", "bad-registry",
    () => mod.parseRegistry(JSON.stringify({ version: 1, instances: [inst("x1", "X", file(1))] })));
}

// (f) remove of a missing id (and of the default) returns the same object
{
  const base = { additional: [inst("i-one", "one", file(1))] };
  check("(f) remove of a missing id returns ===", mod.applyRegistryChange(base, { kind: "remove", id: "i-nope" }) === base);
  check("(f) remove of 'default' returns ===", mod.applyRegistryChange(base, { kind: "remove", id: "default" }) === base);
  const removed = mod.applyRegistryChange(base, { kind: "remove", id: "i-one" });
  check("(f) remove of a listed id drops it and keeps others", removed !== base && removed.additional.length === 0);
}

// (g) add of the same complete record is idempotent
{
  const a = inst("i-same", "same", file(1));
  const base = mod.applyRegistryChange({ additional: [] }, { kind: "add", instance: a });
  check("(g) re-add of the same record returns ===", mod.applyRegistryChange(base, { kind: "add", instance: { ...a } }) === base);
  throwsKind("(g) re-add with a different addressFile throws invalid-instance", "invalid-instance",
    () => mod.applyRegistryChange(base, { kind: "add", instance: inst("i-same", "same", file(2)) }));
}

// (h) junk JSON throws bad-registry
{
  throwsKind("(h) non-JSON text throws bad-registry", "bad-registry", () => mod.parseRegistry("{nope"));
  throwsKind("(h) wrong version throws bad-registry", "bad-registry",
    () => mod.parseRegistry(JSON.stringify({ version: 2, instances: [] })));
  throwsKind("(h) missing instances array throws bad-registry", "bad-registry",
    () => mod.parseRegistry(JSON.stringify({ version: 1 })));
  throwsKind("(h) junk entry (name not a string) throws bad-registry", "bad-registry",
    () => mod.parseRegistry(JSON.stringify({ version: 1, instances: [{ id: "i-x", name: 7, addressFile: file(1) }] })));
  throwsKind("(h) name over 24 chars throws bad-registry", "bad-registry",
    () => mod.parseRegistry(JSON.stringify({ version: 1, instances: [inst("i-x", "x".repeat(25), file(1))] })));
}

// (i) ~ expansion
{
  check("(i) '~/' expands under the stubbed home", mod.expandTilde("~/.config/magpie/gateway-2.json") === file(2));
  check("(i) bare '~' is home", mod.expandTilde("~") === HOME);
  check("(i) an absolute path passes through", mod.expandTilde(file(2)) === file(2));
  const draft = mod.parseInstanceDraft("  magpie-2  ", "~/.config/magpie/gateway-2.json");
  check("(i) parseInstanceDraft trims and expands", draft.name === "magpie-2" && draft.addressFile === file(2) && draft.id.startsWith("i-"));
}

// (j) paths outside home() are rejected
{
  throwsKind("(j) draft with a path outside home throws invalid-instance", "invalid-instance",
    () => mod.parseInstanceDraft("n", "/etc/magpie.json"));
  throwsKind("(j) draft with a relative path throws invalid-instance", "invalid-instance",
    () => mod.parseInstanceDraft("n", "magpie/gateway.json"));
  throwsKind("(j) draft with an empty name throws invalid-instance", "invalid-instance",
    () => mod.parseInstanceDraft("   ", file(2)));
  throwsKind("(j) file entry outside home throws bad-registry", "bad-registry",
    () => mod.parseRegistry(JSON.stringify({ version: 1, instances: [inst("i-x", "X", "/etc/magpie.json")] })));
}

// newInstanceId shape (used by parseInstanceDraft)
{
  const a = mod.newInstanceId();
  check("newInstanceId matches the design's pattern", /^i-[0-9a-z]+-[0-9a-z]{4}$/.test(a) && mod.newInstanceId() !== a);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("FAILED:", failures.join("; "));
  process.exit(1);
}
