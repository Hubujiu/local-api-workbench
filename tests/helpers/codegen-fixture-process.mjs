import { spawn, spawnSync } from "node:child_process";
import { runWindowsFixtureProcess } from "./codegen-windows-process.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanupBudget = 3000;

function liveGroup(pid) {
  // Zombies cannot execute or send a late request. Do not mistake them for
  // live descendants while the host's init process is still reaping them.
  const result = spawnSync("ps", ["-eo", "pgid=,stat="], {
    encoding: "utf8",
    timeout: 1000,
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  return result.stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pid && state && !state.startsWith("Z");
  });
}

async function terminate(child, closed) {
  if (!child.pid) return true;

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") return false;
  }
  const deadline = Date.now() + cleanupBudget;
  do {
    const live = liveGroup(child.pid);
    if (live === false) return true;
    if (live === undefined) return false;
    await pause(20);
  } while (Date.now() < deadline);
  return false;
}

// Test-only launcher. Never include source, argv, environment or stderr in errors.
export async function runFixtureProcess(
  binary,
  args,
  { phase, fixture, timeoutMs = 60000, signal, env = process.env, cwd } = {},
) {
  if (
    !["build", "execute"].includes(phase) ||
    !/^[a-z0-9-]{1,64}$/.test(fixture || "")
  )
    throw Error("Invalid fixture diagnostic labels");
  let timedOut = false,
    aborted = signal?.aborted === true,
    spawnFailed = false;
  let exitCode = null,
    exitSignal = null,
    childClosed = false;
  let cleanupConfirmed = true;
  const receipt = () => ({
    phase,
    fixture,
    exitCode,
    signal: exitSignal,
    timedOut,
    aborted,
    spawnFailed,
    childClosed,
    cleanupConfirmed,
  });
  if (aborted)
    throw Object.assign(Error(JSON.stringify(receipt())), {
      receipt: receipt(),
    });
  if (process.platform === "win32")
    return runWindowsFixtureProcess(binary, args, {
      phase,
      fixture,
      timeoutMs,
      signal,
      env,
      cwd,
    });
  const child = spawn(binary, args, {
    env,
    cwd,
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  const closed = new Promise((resolve) => {
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (code, receivedSignal) => {
      exitCode = code;
      exitSignal = receivedSignal;
      childClosed = true;
      resolve();
    });
  });
  let timer, abort;
  const stopped = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
    abort = () => {
      aborted = true;
      resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  await Promise.race([closed, stopped]);
  clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  cleanupConfirmed = await terminate(child, () => childClosed);
  if (!childClosed) {
    let closeTimer;
    await Promise.race([
      closed,
      new Promise((resolve) => {
        closeTimer = setTimeout(resolve, cleanupBudget);
      }),
    ]);
    clearTimeout(closeTimer);
  }
  cleanupConfirmed &&= childClosed;
  const result = receipt();
  if (exitCode !== 0 || timedOut || aborted || spawnFailed || !cleanupConfirmed)
    throw Object.assign(Error(JSON.stringify(result)), { receipt: result });
  return result;
}

export function createWireObservations() {
  const seen = new Map();
  let count = 0;
  return {
    get count() {
      return count;
    },
    record(path, value) {
      count++;
      const arrivals = seen.get(path) || [];
      seen.set(path, arrivals);
      arrivals.push(value);
    },
    assertUnseen(path) {
      if (seen.has(path)) throw Error("Fixture received a premature request");
    },
    takeOnly(path) {
      const arrivals = seen.get(path);
      if (arrivals?.length !== 1)
        throw Error("Fixture requires exactly one matching request");
      return arrivals[0];
    },
    assertSingleArrivals() {
      for (const arrivals of seen.values())
        if (arrivals.length !== 1)
          throw Error("Fixture received a late duplicate request");
    },
  };
}

export async function buildGoFixtures(
  dir,
  sources,
  { signal, run = runFixtureProcess } = {},
) {
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const output = join(dir, "bin");
  await mkdir(output);
  const binaries = [];
  for (let index = 0; index < sources.length; index++) {
    const folder = join(dir, `fixture-${index}`);
    await mkdir(folder);
    const source = join(folder, "main.go");
    await writeFile(source, sources[index]);
    if ((await readFile(source, "utf8")) !== sources[index])
      throw Error("Generated Go source changed before build");
    binaries.push(
      join(
        output,
        `fixture-${index}${process.platform === "win32" ? ".exe" : ""}`,
      ),
    );
  }
  // A single invocation builds each independent, unmodified main package.
  await run(
    "go",
    ["build", "-o", output, ...sources.map((_, index) => `./fixture-${index}`)],
    {
      cwd: dir,
      env: goFixtureEnvironment(),
      phase: "build",
      fixture: "all-fixtures",
      timeoutMs: 60000,
      signal,
    },
  );
  return binaries;
}

export function fixtureToolAvailable(
  binary,
  args,
  { fixture, pattern, timeoutMs = 5000, env = process.env } = {},
) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 8192,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error?.code === "ENOENT") return false;
  if (result.error || result.signal) {
    const receipt = {
      phase: "probe",
      fixture,
      exitCode: result.status,
      signal: result.signal,
      timedOut: result.error?.code === "ETIMEDOUT",
    };
    throw Object.assign(Error(JSON.stringify(receipt)), { receipt });
  }
  return result.status === 0 && (!pattern || pattern.test(result.stdout));
}

export function goFixtureEnvironment() {
  return {
    ...process.env,
    GO111MODULE: "off",
    GOPROXY: "off",
    GOTOOLCHAIN: "local",
    GOWORK: "off",
  };
}
