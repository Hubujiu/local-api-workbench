import { mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  throwIfInactive,
  waitForControl,
  delayForControl,
  interruptionKind,
} from "./request-control.mjs";

const localQueues = new Map();

/** Serialize same-process contenders before touching the cross-process lock. */
export async function acquireFileLock(directory, controls = {}) {
  throwIfInactive(controls);
  directory = path.resolve(directory);
  directory = path.join(
    await realpath(path.dirname(directory) + path.sep),
    path.basename(directory),
  );
  throwIfInactive(controls);
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

// This persistent sibling is an OS-lock identity, not disposable lock state.
// Never unlink/rename it. Stop all older instances before upgrading: old binaries
// do not participate in this guard. Use a local filesystem with SQLite locking.
async function acquireDiskLock(directory, controls) {
  const budget = {
    hardDeadline: performance.now() + 10000,
    idleDeadline: performance.now() + 2000,
    lastOwner: undefined,
  };
  throwIfInactive(controls);
  const database = new DatabaseSync(directory + ".guard.sqlite", {
    timeout: 0,
    allowExtension: false,
  });
  let held = false;
  const close = () => {
    try {
      if (held) database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  };
  try {
    while (
      performance.now() < Math.min(budget.hardDeadline, budget.idleDeadline)
    ) {
      throwIfInactive(controls);
      try {
        database.exec("BEGIN IMMEDIATE");
        held = true;
        break;
      } catch (error) {
        // Retry BUSY only, never corruption, permissions or arbitrary SQL errors.
        if (
          error.code !== "ERR_SQLITE_ERROR" ||
          !Number.isInteger(error.errcode) ||
          (error.errcode & 0xff) !== 5
        )
          throw error;
      }
      try {
        const owner = JSON.parse(
          await readFile(path.join(directory, "owner.json"), "utf8"),
        );
        observeOwner(owner, budget);
      } catch {
        /* Observation cannot authorize recovery outside the guard. */
      }
      await delayForControl(20, controls);
    }
    throwIfInactive(controls);
    if (!held) throw Error("项目正在由其他进程写入，请稍后重试");
    const release = await acquireLegacyDiskLock(directory, controls, budget);
    return async () => {
      try {
        await release();
      } finally {
        close();
      }
    };
  } catch (error) {
    close();
    throw error;
  }
}

function recognizedOwner(owner) {
  return (
    owner &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.nonce === "string" &&
    owner.nonce.length > 0 &&
    owner.nonce.length <= 256
  );
}

function observeOwner(owner, budget) {
  if (!recognizedOwner(owner)) return;
  process.kill(owner.pid, 0);
  const identity = owner.pid + ":" + owner.nonce;
  if (budget.lastOwner !== undefined && identity !== budget.lastOwner)
    budget.idleDeadline = performance.now() + 2000;
  budget.lastOwner = identity;
}

/** Recover locks only when their recorded owner process is demonstrably gone. */
async function acquireLegacyDiskLock(directory, controls, budget) {
  const ownerFile = path.join(directory, "owner.json"),
    nonce = randomUUID();
  let lastTransient;
  while (
    performance.now() < Math.min(budget.hardDeadline, budget.idleDeadline)
  ) {
    throwIfInactive(controls);
    try {
      await mkdir(directory);
      // Once mkdir succeeds, finish our ownership receipt before checking the
      // controls so the caller can safely release this exact nonce on abort.
      try {
        await writeFile(
          ownerFile,
          JSON.stringify({ pid: process.pid, nonce }),
          {
            mode: 0o600,
          },
        );
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
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
        await delayForControl(20, controls);
        continue;
      }
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(ownerFile, "utf8"));
        throwIfInactive(controls);
        if (recognizedOwner(owner)) {
          try {
            observeOwner(owner, budget);
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
      await delayForControl(20, controls);
    }
  }
  throwIfInactive(controls);
  if (lastTransient) throw lastTransient;
  throw Error("项目正在由其他进程写入，请稍后重试");
}
