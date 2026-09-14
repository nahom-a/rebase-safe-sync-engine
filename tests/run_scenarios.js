// Runs the visible scenario corpus against a codec implementation and
// reports per-scenario pass/fail with diffs. Also usable as a library by
// anything that wants to run the same corpus against a different codec
// module (used during development to check wrong designs against it).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { measureBound } from "./measure.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findNode(node, id) {
  if (node.id === id) return node;
  for (const c of node.children) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

function resolveBaseline(store, ref, genesisTree) {
  if (ref === "genesis") return { tree: genesisTree, residue: null };
  return store[ref];
}

function fieldsEqual(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

function treesEqual(a, b) {
  if (a.id !== b.id || a.type !== b.type) return false;
  if (!fieldsEqual(a.fields, b.fields)) return false;
  if (a.children.length !== b.children.length) return false;
  return a.children.every((c, i) => treesEqual(c, b.children[i]));
}

async function evalCheck(store, bytesStore, check, codec, genesisTree) {
  const state = store[check.state];
  switch (check.kind) {
    // Residue's internal shape is the codec's own design and must never be
    // inspected directly. To check that content survived a downlevel decode
    // without a codec-specific shape assumption, re-encode the held state
    // (no new mutations) at the version that produced it and decode the
    // result at a version that understands the content - fully behavioral.
    case "roundTripNodePresent": {
      const bytes = await codec.encode(state, [], check.reencodeVersion);
      const decoded = await codec.decode({ tree: genesisTree, residue: null }, bytes, check.decodeVersion);
      return { ok: !!findNode(decoded.tree, check.nodeId), reason: `expected ${check.nodeId} recoverable by re-encoding at v${check.reencodeVersion} and decoding at v${check.decodeVersion}` };
    }
    case "roundTripFieldEquals": {
      const bytes = await codec.encode(state, [], check.reencodeVersion);
      const decoded = await codec.decode({ tree: genesisTree, residue: null }, bytes, check.decodeVersion);
      const n = findNode(decoded.tree, check.nodeId);
      const ok = !!n && n.fields[check.field] === check.value;
      return { ok, reason: `expected ${check.nodeId}.${check.field} === ${JSON.stringify(check.value)} after re-encode/decode, got ${n ? JSON.stringify(n.fields[check.field]) : "node missing"}` };
    }
    case "nodePresent":
      return { ok: !!findNode(state.tree, check.nodeId), reason: `expected node ${check.nodeId} present in typed tree` };
    case "nodeAbsent":
      return { ok: !findNode(state.tree, check.nodeId), reason: `expected node ${check.nodeId} absent from typed tree` };
    case "fieldEquals": {
      const n = findNode(state.tree, check.nodeId);
      const ok = !!n && n.fields[check.field] === check.value;
      return {
        ok,
        reason: `expected ${check.nodeId}.${check.field} === ${JSON.stringify(check.value)}, got ${n ? JSON.stringify(n.fields[check.field]) : "node missing"}`,
      };
    }
    case "childOrder": {
      const n = findNode(state.tree, check.parentId);
      const got = n ? n.children.map((c) => c.id) : null;
      const ok = JSON.stringify(got) === JSON.stringify(check.ids);
      return { ok, reason: `expected children of ${check.parentId} = ${JSON.stringify(check.ids)}, got ${JSON.stringify(got)}` };
    }
    case "immediatelyBefore": {
      const n = findNode(state.tree, check.parentId);
      const ids = n ? n.children.map((c) => c.id) : [];
      const targetIdx = ids.indexOf(check.targetId);
      const beforeIdx = ids.indexOf(check.beforeId);
      const ok = targetIdx >= 0 && beforeIdx >= 0 && targetIdx === beforeIdx - 1;
      return { ok, reason: `expected ${check.targetId} immediately before ${check.beforeId} in ${check.parentId}'s children, got order ${JSON.stringify(ids)}` };
    }
    case "residueEmpty": {
      // Residue's internal shape is the codec's own design and must never
      // be inspected directly - not even to ask "is it empty" by checking
      // for particular key names, since PROTOCOL.md guarantees nothing
      // about what those keys are called or whether the shape is even
      // key-based. Instead, this is fully behavioral: re-encode the state
      // with no new mutations at v3 (the schema superset - nothing in
      // this model exists beyond v3, so a v3 peer understands everything
      // any version could have authored), producing a delta containing
      // only whatever residue-carry ops the codec re-embeds. Decode that
      // delta back onto the state ITSELF (not a fresh baseline - state's
      // typed tree already reflects whatever this chain has established
      // so far, and that must not change) at v3. If residue held
      // anything, a fully-understanding peer applying those carry ops
      // must materialize it into the typed tree, so the result would gain
      // content beyond state's own tree; if residue was truly empty, the
      // carry ops are empty and decoding them changes nothing.
      const bytes = await codec.encode(state, [], 3);
      const decoded = await codec.decode(state, bytes, 3);
      const ok = treesEqual(decoded.tree, state.tree);
      return { ok, reason: "expected empty residue (re-embedding at v3 and decoding back onto the same state should change nothing), got additional content" };
    }
    case "sizeBound": {
      const entry = bytesStore[check.bytes];
      const bound = measureBound(entry.mutations);
      const ok = entry.bytes.length <= bound;
      return { ok, reason: `bytes=${entry.bytes.length} exceeds bound=${bound}` };
    }
    default:
      return { ok: false, reason: `unknown check kind: ${check.kind}` };
  }
}

export async function runOne(codec, scenario, onEncode) {
  const store = {};
  const bytesStore = {};
  try {
    for (const step of scenario.steps) {
      if (step.op === "encode") {
        const baseline = resolveBaseline(store, step.baseline, scenario.genesis);
        const bytes = await codec.encode(baseline, step.mutations, step.version);
        bytesStore[step.id] = { bytes, mutations: step.mutations };
        // Optional hook so a caller driving many scenarios (the held-out
        // corpus) can piggyback extra per-encode measurements - such as
        // the size bound - onto this same traversal instead of paying for
        // a second full pass over every scenario's steps.
        if (onEncode) onEncode(step, baseline, bytes);
      } else if (step.op === "decode") {
        const baseline = resolveBaseline(store, step.baseline, scenario.genesis);
        const { bytes } = bytesStore[step.bytes];
        store[step.id] = await codec.decode(baseline, bytes, step.version);
      } else {
        throw new Error(`unknown step op: ${step.op}`);
      }
    }
    const failures = [];
    for (const check of scenario.checks) {
      const outcome = await evalCheck(store, bytesStore, check, codec, scenario.genesis);
      if (!outcome.ok) failures.push(outcome.reason);
    }
    return { ok: failures.length === 0, failures };
  } catch (e) {
    return { ok: false, failures: [`threw: ${e.message}`] };
  }
}

export async function runScenarios(codec, scenariosDir) {
  const files = readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const results = [];
  for (const file of files) {
    const scenario = JSON.parse(readFileSync(path.join(scenariosDir, file), "utf8"));
    const outcome = await runOne(codec, scenario);
    results.push({ name: scenario.name, file, ...outcome });
  }
  return results;
}

async function main() {
  const defaultCodec = path.join(__dirname, "../src/index.js");
  const defaultScenarios = path.join(__dirname, "scenarios");
  const codecPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultCodec;
  const scenariosDir = process.argv[3] ? path.resolve(process.argv[3]) : defaultScenarios;
  const codec = await import(pathToFileURL(codecPath).href);
  const results = await runScenarios(codec, scenariosDir);
  let passed = 0;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    if (!r.ok) for (const f of r.failures) console.log(`      ${f}`);
    if (r.ok) passed++;
  }
  console.log(`\n${passed}/${results.length} scenarios passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main();
}
