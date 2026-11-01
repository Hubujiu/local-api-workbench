import { isMainThread } from "node:worker_threads";
import { lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// This module may be inherited by application Workers or CLI subprocesses.
// No node:test/projector/runtime import, hook or environment change before this.
export function eligibleObserverEntry({ mainThread, context, entry, repositoryRoot = root }, stat = lstatSync) {
  if (mainThread !== true || context !== "child-v8" || typeof entry !== "string") return false;
  const absolute = path.resolve(entry), tests = path.join(repositoryRoot, "tests");
  const name = path.basename(absolute);
  if (path.relative(tests, path.dirname(absolute)) !== "" || name.startsWith(".") ||
      !name.endsWith(".test.mjs") || /[\\\r\n*?\[\]{}()]/.test(name)) return false;
  try { return stat(absolute).isFile(); } catch { return false; }
}

try {
  const explicitlyPreloaded = process.execArgv.includes(`--import=${import.meta.url}`);
  if (explicitlyPreloaded && eligibleObserverEntry({
    mainThread: isMainThread,
    context: process.env.NODE_TEST_CONTEXT,
    entry: process.argv[1],
  })) {
    const { afterEach } = await import("node:test");
    const { createWorkerObserver } = await import("./core-worker-observations.mjs");
    const observe = createWorkerObserver();
    afterEach((context) => {
      try {
        // Trusted Node TestContext APIs, not worker Error property reads.
        if (context.passed === false) observe(context.error, context.name, (line) => context.diagnostic(line));
      } catch { /* Unsupported/failed observation never changes test status. */ }
    });
  }
} catch { /* Missing setup is unavailable evidence, never a different result. */ }
