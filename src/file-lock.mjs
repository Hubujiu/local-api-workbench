import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Recover locks only when their recorded owner process is demonstrably gone. */
export async function acquireFileLock(directory) {
  const ownerFile = path.join(directory, "owner.json"),
    nonce = randomUUID();
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(directory);
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, nonce }), {
        mode: 0o600,
      });
      return async () => {
        try {
          const owner = JSON.parse(await readFile(ownerFile, "utf8"));
          if (owner.nonce === nonce)
            await rm(directory, { recursive: true, force: true });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(ownerFile, "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
          } catch (checkError) {
            if (checkError.code === "ESRCH") {
              const current = JSON.parse(await readFile(ownerFile, "utf8"));
              if (current.nonce === owner.nonce)
                await rm(directory, { recursive: true, force: true });
            }
          }
        }
      } catch {
        /* Incomplete or unrecognized locks are not deleted automatically. */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw Error("项目正在由其他进程写入，请稍后重试");
}
