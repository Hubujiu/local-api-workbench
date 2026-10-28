import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  throwIfInactive,
  waitForControl,
  interruptionKind,
} from "./request-control.mjs";

const localQueues = new Map();

/** Serialize same-process contenders before touching the cross-process lock. */
export async function acquireFileLock(directory, controls = {}) {
  throwIfInactive(controls);
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
  // A cancelled slot can finish promptly, but its tail must still wait for its
  // predecessor. Deleting it early would let a new contender bypass that owner.
  tail.then(() => {
    if (localQueues.get(key) === tail) localQueues.delete(key);
  });
  const finish = () => unlock();
  try {
    await waitForControl(previous, controls);
    throwIfInactive(controls);
    const release = await acquireDiskLock(directory, controls);
    try {
      throwIfInactive(controls);
    } catch (error) {
      await release();
      throw error;
    }
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
async function acquireDiskLock(directory, controls) {
  const ownerFile = path.join(directory, "owner.json"),
    nonce = randomUUID();
  const hardDeadline = performance.now() + 10000;
  let idleDeadline = performance.now() + 2000,
    lastOwner,
    lastTransient;
  while (performance.now() < Math.min(hardDeadline, idleDeadline)) {
    throwIfInactive(controls);
    try {
      await mkdir(directory);
      // Once mkdir succeeds, finish our ownership receipt before checking the
      // controls so the caller can safely release this exact nonce on abort.
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
        await waitForControl(
          new Promise((resolve) => setTimeout(resolve, 20)),
          controls,
        );
        continue;
      }
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(ownerFile, "utf8"));
        throwIfInactive(controls);
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
              throwIfInactive(controls);
              if (current.nonce === owner.nonce)
                await rm(directory, { recursive: true, force: true });
            }
          }
        }
      } catch (error) {
        if (interruptionKind(error)) throw error;
        /* Incomplete or unrecognized locks are not deleted automatically. */
      }
      throwIfInactive(controls);
      await waitForControl(
        new Promise((resolve) => setTimeout(resolve, 20)),
        controls,
      );
    }
  }
  throwIfInactive(controls);
  if (lastTransient) throw lastTransient;
  throw Error("项目正在由其他进程写入，请稍后重试");
}
