// Drives the target codec through the visible and held-out corpora
// and prints a single JSON report line to stdout.
//
// Usage: node runner.mjs [codec-path] [seed]
//
// Process Isolation:
// Every single encode()/decode() call runs in its own freshly forked,
// one-shot child process (agent-worker.mjs), killed and discarded the
// moment it answers. This guarantees isolated JS heaps and isolated
// temporary files to verify true stateless wire delta behavior.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { runScenarios, runOne } from "./run_scenarios.js";
import { generateHeldOut } from "./generator.mjs";
import { measureBound } from "./measure.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaultCodec = path.join(__dirname, "../src/index.js");
const codecPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultCodec;
const seed = Number(process.argv[3] || 20260912);

const CALL_TIMEOUT_MS = 10000;

// The literal, well-known "/tmp" path - distinct from os.tmpdir(), which
// each call's TMPDIR/TMP/TEMP env override below redirects.
const REAL_TMP = "/tmp";

// The directory the codec file itself lives in.
const CODEC_DIR = path.dirname(path.resolve(codecPath));

function emitReport(report) {
  process.stdout.write(JSON.stringify(report) + "\n");
}

function emptyGenesis() {
  return { tree: { id: "root", type: "root", fields: {}, children: [] }, residue: null };
}

function snapshotDir(dir) {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
}

function purgeNewInDir(dir, before) {
  let after;
  try {
    after = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of after) {
    if (before.has(name)) continue;
    try {
      rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {}
  }
}

function killWorker(worker) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    worker.once("exit", finish);
    try {
      worker.disconnect();
    } catch {}
    try {
      worker.kill("SIGKILL");
    } catch {}
    setTimeout(finish, 2000);
  });
}

async function callFresh(fn, args) {
  const isoDir = mkdtempSync(path.join(tmpdir(), "rsc-iso-"));
  const beforeRealTmp = snapshotDir(REAL_TMP);
  const beforeCodecDir = snapshotDir(CODEC_DIR);
  const readyToken = randomUUID();
  const callId = randomUUID();

  const worker = fork(path.join(__dirname, "agent-worker.mjs"), [codecPath, readyToken], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
    env: { ...process.env, TMPDIR: isoDir, TMP: isoDir, TEMP: isoDir },
  });

  try {
    const ready = await new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg && msg.ready === readyToken) {
          worker.off("message", onMsg);
          resolve(msg);
        }
      };
      worker.on("message", onMsg);
      worker.on("exit", () => resolve({ ok: false, error: "worker exited before import completed" }));
    });
    if (!ready.ok) throw new Error(ready.error || "import failed");

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.off("message", onMsg);
        reject(new Error(`worker did not respond to ${fn}() within ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      const onMsg = (msg) => {
        if (!msg || msg.id !== callId) return;
        clearTimeout(timer);
        worker.off("message", onMsg);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error || "rpc call failed"));
      };
      worker.on("message", onMsg);
      worker.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("worker process exited before responding"));
      });
      worker.send({ id: callId, fn, args });
    });
    return result;
  } finally {
    await killWorker(worker);
    try {
      rmSync(isoDir, { recursive: true, force: true });
    } catch {}
    purgeNewInDir(REAL_TMP, beforeRealTmp);
    purgeNewInDir(CODEC_DIR, beforeCodecDir);
  }
}

function makeCodec() {
  return {
    encode: async (baseline, mutations, version) => {
      const { bytesB64 } = await callFresh("encode", [baseline, mutations, version]);
      return Buffer.from(bytesB64, "base64");
    },
    decode: async (baseline, bytes, version) => {
      const bytesB64 = Buffer.from(bytes).toString("base64");
      return await callFresh("decode", [baseline, bytesB64, version]);
    },
  };
}

async function main() {
  const report = {
    exportsOk: false,
    visible: [],
    heldOut: [],
    determinism: null,
    malformed: null,
    cycleRejection: null,
    malformedDecode: null,
    sizeBoundEmptyResidue: null,
    error: null,
  };
  const codec = makeCodec();

  try {
    const exp = await callFresh("__exports__", []);
    report.exportsOk = !!(exp.encodeOk && exp.decodeOk);
  } catch (e) {
    report.error = `exports check failed: ${e.message}`;
  }

  if (report.exportsOk) {
    try {
      report.visible = await runScenarios(codec, path.join(__dirname, "scenarios"));
    } catch (e) {
      report.error = `visible corpus run failed: ${e.message}`;
    }

    try {
      const { scenarios } = generateHeldOut(seed);
      let checked = 0;
      const violations = [];
      for (const s of scenarios) {
        const onEncode = (step, baseline, bytes) => {
          if (step.baseline !== "genesis") return;
          checked++;
          const bound = measureBound(step.mutations);
          if (bytes.length > bound) {
            violations.push({ scenario: s.name, step: step.id, bytesLen: bytes.length, bound });
          }
        };
        const r = await runOne(codec, s, onEncode);
        report.heldOut.push({ name: s.name, ok: r.ok, failures: r.failures });
      }
      report.sizeBoundEmptyResidue = { checked, violations: violations.length, examples: violations.slice(0, 5) };
    } catch (e) {
      report.error = report.error || `held-out corpus run failed: ${e.message}`;
      report.sizeBoundEmptyResidue = report.sizeBoundEmptyResidue || { checked: 0, violations: -1, error: e.message };
    }

    try {
      const { scenarios } = generateHeldOut(seed);
      const sample = scenarios.slice(0, 8);
      let deterministic = true;
      for (const s of sample) {
        const baseline = { tree: s.genesis, residue: null };
        const b1 = await codec.encode(baseline, s.steps[0].mutations, s.steps[0].version);
        const b2 = await codec.encode(baseline, s.steps[0].mutations, s.steps[0].version);
        if (Buffer.compare(Buffer.from(b1), Buffer.from(b2)) !== 0) deterministic = false;
      }
      report.determinism = deterministic;
    } catch (e) {
      report.determinism = false;
      report.error = report.error || `determinism check failed: ${e.message}`;
    }

    // Check invalid mutations: nonexistent node, duplicate ID, invalid parent
    try {
      let threwNonexistent = false;
      try {
        await codec.encode(emptyGenesis(), [{ op: "setField", nodeId: "does-not-exist", field: "x", value: 1 }], 1);
      } catch {
        threwNonexistent = true;
      }

      let threwDuplicateId = false;
      try {
        const treeWithN1 = {
          tree: {
            id: "root",
            type: "root",
            fields: {},
            children: [{ id: "n1", type: "item", fields: { label: "a", priority: "low" }, children: [] }],
          },
          residue: null,
        };
        await codec.encode(treeWithN1, [{ op: "insert", parentId: "root", index: 0, node: { id: "n1", type: "item", fields: { label: "dup", priority: "low" }, children: [] } }], 1);
      } catch {
        threwDuplicateId = true;
      }

      let threwInvalidParent = false;
      try {
        await codec.encode(emptyGenesis(), [{ op: "insert", parentId: "nonexistent_parent", index: 0, node: { id: "new_1", type: "item", fields: { label: "a", priority: "low" }, children: [] } }], 1);
      } catch {
        threwInvalidParent = true;
      }

      report.malformed = threwNonexistent && threwDuplicateId && threwInvalidParent;
    } catch (e) {
      report.malformed = false;
    }

    // Check cycle and root modification rejection
    try {
      let cycleDirectThrew = false;
      let cycleDeepThrew = false;
      let rootDeleteThrew = false;
      let rootMoveThrew = false;

      const deepTree = {
        tree: {
          id: "root",
          type: "root",
          fields: {},
          children: [
            {
              id: "sec1",
              type: "section",
              fields: { title: "s", status: "open" },
              children: [
                {
                  id: "item1",
                  type: "item",
                  fields: { label: "i", priority: "low" },
                  children: [
                    { id: "note1", type: "note", fields: { text: "t" }, children: [] },
                  ],
                },
              ],
            },
          ],
        },
        residue: null,
      };

      try {
        await codec.encode(deepTree, [{ op: "move", nodeId: "sec1", newParentId: "note1", newIndex: 0 }], 1);
      } catch {
        cycleDeepThrew = true;
      }

      try {
        await codec.encode(deepTree, [{ op: "move", nodeId: "sec1", newParentId: "sec1", newIndex: 0 }], 1);
      } catch {
        cycleDirectThrew = true;
      }

      try {
        await codec.encode(deepTree, [{ op: "delete", nodeId: "root" }], 1);
      } catch {
        rootDeleteThrew = true;
      }

      try {
        await codec.encode(deepTree, [{ op: "move", nodeId: "root", newParentId: "sec1", newIndex: 0 }], 1);
      } catch {
        rootMoveThrew = true;
      }

      report.cycleRejection = cycleDirectThrew && cycleDeepThrew && rootDeleteThrew && rootMoveThrew;
    } catch (e) {
      report.cycleRejection = false;
    }

    // Check malformed wire bytes handling
    try {
      let threwJunk = false;
      let threwBadVersion = false;
      try {
        const junk = Buffer.from("not a conforming wire payload {{{", "utf8");
        await codec.decode(emptyGenesis(), junk, 1);
      } catch {
        threwJunk = true;
      }

      try {
        const badVersion = Buffer.from(JSON.stringify([999, []]), "utf8");
        await codec.decode(emptyGenesis(), badVersion, 1);
      } catch {
        threwBadVersion = true;
      }

      report.malformedDecode = threwJunk && threwBadVersion;
    } catch (e) {
      report.malformedDecode = false;
    }
  }

  emitReport(report);
}

main().catch((e) => {
  emitReport({
    exportsOk: false,
    visible: [],
    heldOut: [],
    determinism: null,
    malformed: null,
    cycleRejection: null,
    malformedDecode: null,
    sizeBoundEmptyResidue: null,
    error: e.message,
  });
  process.exit(1);
});
