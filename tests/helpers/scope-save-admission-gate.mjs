// Test-only handoff before the original Store.save begins. No project lock is
// held here: owner policy validation must be able to read the real project.
import { readFile, writeFile, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
export function installScopeSaveAdmissionGate(target, directory) {
  const original = target.save,
    used = new Set();
  target.save = async function (project, options) {
    let spec;
    try {
      spec = JSON.parse(await readFile(directory + "/armed.json", "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      !spec ||
      used.has(spec.label) ||
      project.id !== spec.projectId ||
      options?.activity ||
      !project.environments.some((e) => e.variables?.scopeGate === spec.label)
    )
      return original.call(this, project, options);
    used.add(spec.label);
    const marker = directory + "/" + spec.label;
    await writeFile(
      marker + ".ready.tmp",
      JSON.stringify({
        saveStarted: false,
        signalForwarded: options?.signal instanceof AbortSignal,
        signalAborted: options?.signal?.aborted === true,
      }),
    );
    await rename(marker + ".ready.tmp", marker + ".ready");
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        await readFile(marker + ".release");
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (Date.now() > deadline)
        throw Error("scope admission gate release timed out");
      await delay(5);
    }
    await writeFile(
      marker + ".attempted",
      JSON.stringify({ signalAborted: options?.signal?.aborted === true }),
    );
    return original.call(this, project, options);
  };
  return () => {
    target.save = original;
  };
}
