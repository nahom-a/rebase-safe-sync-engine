// Executes the agent's codec in a process isolated from the grader.
//
// This process's only job is to relay encode()/decode() calls to whatever
// module sits at codecPath and hand back their raw results (or errors) as
// data over IPC. It never computes a pass/fail verdict and never touches
// the report file. That split matters: the parent (runner.mjs) never
// imports agent code, so nothing this process's imported module does -
// monkeypatching globals, hooking process.on('exit'), calling
// process.exit() itself, or spamming extra process.send() calls - can
// alter a verdict, because this process never produces one. It can only
// supply (or fail to supply) raw values that the parent independently
// checks against expected results it computes itself.
import path from "node:path";
import { pathToFileURL } from "node:url";

const send = typeof process.send === "function" ? process.send.bind(process) : null;
if (!send) {
  // Not running under IPC (e.g. invoked by hand) - nothing sane to do.
  process.exit(1);
}

let codec;

// Registered before the agent module is imported, so this is first in
// Node's 'message' listener order for this process: listeners run in
// registration order, and this handler replies synchronously (no await
// between receiving a call and sending its result), so a same-tick reply
// from a listener the agent module registers later can never reach the
// parent before this one does for the same request id.
process.on("message", (msg) => {
  if (!msg || typeof msg.id !== "string") return;
  const { id, fn, args } = msg;
  try {
    if (fn === "__exports__") {
      send({ id, ok: true, result: { encodeOk: typeof codec.encode === "function", decodeOk: typeof codec.decode === "function" } });
      return;
    }
    if (fn === "encode") {
      const [baseline, mutations, version] = args;
      const bytes = codec.encode(baseline, mutations, version);
      send({ id, ok: true, result: { bytesB64: Buffer.from(bytes).toString("base64") } });
      return;
    }
    if (fn === "decode") {
      const [baseline, bytesB64, version] = args;
      const bytes = Buffer.from(bytesB64, "base64");
      const result = codec.decode(baseline, bytes, version);
      send({ id, ok: true, result });
      return;
    }
    send({ id, ok: false, error: `unknown rpc fn: ${fn}` });
  } catch (e) {
    send({ id, ok: false, error: e && e.message ? e.message : String(e) });
  }
});

const codecPath = process.argv[2];
const readyToken = process.argv[3];
try {
  codec = await import(pathToFileURL(path.resolve(codecPath)).href);
  send({ ready: readyToken, ok: true });
} catch (e) {
  send({ ready: readyToken, ok: false, error: `import failed: ${e.message}` });
  process.exit(1);
}
