import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const localQueues = new Map();

/** Serialize same-process contenders before touching the cross-process lock. */
export async function acquireFileLock(directory) {
  directory = path.resolve(directory);
  const key =
    process.platform === "win32" ? directory.toLowerCase() : directory;
  const previous = localQueues.get(key) || Promise.resolve();
  let unlock;
  const held = new Promise((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => held);
  localQueues.set(key, tail);
  const finish = () => {
    unlock();
    if (localQueues.get(key) === tail) localQueues.delete(key);
  };
  await previous;
  try {
    const release = await acquireDiskLock(directory);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await release();
      } finally {
        finish();
      }
    };
  } catch (error) {
    finish();
    throw error;
  }
}

export function isTransientWindowsLockMkdir(
  error,
  platform = process.platform,
) {
  return (
    platform === "win32" && error.code === "EPERM" && error.syscall === "mkdir"
  );
}

/** Recover locks only when their recorded owner process is demonstrably gone. */
async function acquireDiskLock(directory) {
  const ownerFile = path.join(directory, "owner.json"),
    nonce = randomUUID();
  const hardDeadline = performance.now() + 10000;
  let idleDeadline = performance.now() + 2000,
    lastOwner,
    lastTransient;
  while (performance.now() < Math.min(hardDeadline, idleDeadline)) {
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
      if (isTransientWindowsLockMkdir(error)) {
        // Windows can keep a deleted directory pending while another handle closes.
        // Retry only this same mkdir; never chmod, remove or override another owner.
        lastTransient = error;
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(ownerFile, "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
            if (
              typeof owner.nonce === "string" &&
              owner.nonce.length > 0 &&
              owner.nonce.length <= 256
            ) {
              const identity = owner.pid + ":" + owner.nonce;
              if (lastOwner !== undefined && identity !== lastOwner)
                idleDeadline = performance.now() + 2000;
              lastOwner = identity;
            }
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
  if (lastTransient) throw lastTransient;
  throw Error("项目正在由其他进程写入，请稍后重试");
}
