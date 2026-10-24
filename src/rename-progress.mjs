import { rename } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

// Windows readers can briefly deny replacement of an existing journal.
// Keep the old file intact; never unlink it or relax its permissions.
export async function renameProgress(source, target, options = {}) {
  const move = options.rename ?? rename;
  const sleep = options.sleep ?? setTimeout;
  const platform = options.platform ?? process.platform;
  for (let attempt = 0; ; attempt++) {
    try {
      return await move(source, target);
    } catch (error) {
      if (
        platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
        attempt >= 4
      )
        throw error;
      await sleep(10 * 2 ** attempt);
    }
  }
}
