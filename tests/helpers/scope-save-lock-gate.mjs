// Test-only interleaving: a real project lock holds the original Store.save
// before transaction admission. No persistence result or execution is mocked.
import { readFile, writeFile, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { acquireFileLock } from "../../src/file-lock.mjs";
export function installScopeSaveLockGate(target, directory) {
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
    const release = await acquireFileLock(this.lockFile(project.id));
    let settled = false;
    const pending = original.call(this, project, options).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const marker = directory + "/" + spec.label + ".ready";
      await writeFile(
        marker + ".tmp",
        JSON.stringify({
          settled,
          signalForwarded: options?.signal instanceof AbortSignal,
        }),
      );
      await rename(marker + ".tmp", marker);
      const deadline = Date.now() + 10000;
      for (;;) {
        try {
          await readFile(directory + "/" + spec.label + ".release");
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (Date.now() > deadline)
          throw Error("scope lock gate release timed out");
        await delay(5);
      }
    } finally {
      await release();
    }
    const outcome = await pending;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  };
  return () => {
    target.save = original;
  };
}
