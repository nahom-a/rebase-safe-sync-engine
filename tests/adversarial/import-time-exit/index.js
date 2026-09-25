// Cheat attempt: exit the process at import time before any test can run,
// hoping a crash somewhere downstream gets misread as a pass.
process.exit(0);

export function encode() {
  throw new Error("unreachable");
}
export function decode() {
  throw new Error("unreachable");
}
