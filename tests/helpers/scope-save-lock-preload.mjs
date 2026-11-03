// Only the CI fixture passes this preload. Production stdio entrypoint/SDK,
// dispatch, cancellation registry, Store and transaction code remain unchanged.
import { isMainThread } from "node:worker_threads";
// Node inherits --import in script workers. Never import Store/runtime or install
// the fixture there; the real script worker dependency graph stays untouched.
if (isMainThread) {
  if (!process.env.LOCAL_API_SCOPE_GATE)
    throw Error("missing fixture gate directory");
  const { Store } = await import("../../src/runtime.mjs");
  const { installScopeSaveLockGate } = await import(
    "./scope-save-lock-gate.mjs"
  );
  installScopeSaveLockGate(Store.prototype, process.env.LOCAL_API_SCOPE_GATE);
}
