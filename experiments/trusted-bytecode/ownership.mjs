import { LIMITS } from "./catalog.mjs";

// Establish ownership *inside* the charged callback. A late-success budget
// exception is raised after that callback returns, so assignment of its return
// value outside budget.run would lose the newly created context.
export function createOwnedRuntime(raw, budget) {
  let runtime,
    context,
    disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      context?.dispose();
    } finally {
      runtime?.dispose();
    }
  };
  try {
    budget.run("create-runtime-context", () => {
      runtime = raw.engine.newRuntime();
      runtime.setMemoryLimit(LIMITS.memory);
      runtime.setMaxStackSize(LIMITS.stack);
      runtime.setInterruptHandler(() => budget.expired());
      context = runtime.newContext();
    });
    return { runtime, context, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
