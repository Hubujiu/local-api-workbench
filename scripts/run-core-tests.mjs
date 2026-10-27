import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

export function parseOptions(args) {
  const options = {};
  for (const arg of args) {
    const match = /^(--shard|--label)=(.+)$/.exec(arg);
    if (arg === "--list" && !options.list) options.list = true;
    else if (match && !Object.hasOwn(options, match[1].slice(2)))
      options[match[1].slice(2)] = match[2];
    else throw Error(`Unknown or duplicate argument: ${arg}`);
  }
  const shard = /^([1-9]\d*)\/([1-9]\d*)$/.exec(options.shard ?? "");
  if (!shard) throw Error("Expected --shard=INDEX/TOTAL (positive integers)");
  const index = Number(shard[1]),
    total = Number(shard[2]);
  if (!Number.isSafeInteger(total) || index > total)
    throw Error("Shard index must not exceed a safe integer total");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(options.label ?? ""))
    throw Error("Expected --label=OS (letters, digits, underscore or hyphen)");
  return { index, total, label: options.label, list: !!options.list };
}

export async function discoverCoreTests(cwd) {
  // Same non-recursive, non-dotfile scope as npm test's tests/*.test.mjs.
  // Reject non-files rather than allowing Node to silently ignore a bad glob.
  const names = (await readdir(path.join(cwd, "tests")))
    .filter((name) => !name.startsWith(".") && name.endsWith(".test.mjs"))
    .sort(); // Code-unit order, not locale/platform-dependent collation.
  if (!names.length) throw Error("No core test files found");
  for (const name of names) {
    if (!(await lstat(path.join(cwd, "tests", name))).isFile())
      throw Error(`Core test is not a regular file: ${name}`);
    if (/[\\\r\n*?\[\]{}()]/.test(name))
      throw Error(
        `Core test name contains a path, line or glob delimiter: ${name}`,
      );
  }
  return names.map((name) => `tests/${name}`);
}

export async function createPlan(cwd, options) {
  const files = await discoverCoreTests(cwd);
  if (options.total > files.length) throw Error("Every shard must be nonempty");
  const shards = Array.from({ length: options.total }, () => []);
  files.forEach((file, position) =>
    shards[position % options.total].push(file),
  );
  return {
    version: 2,
    fileConcurrency: 1,
    pattern: "tests/*.test.mjs",
    order: "UTF-16 code-unit ascending; forward-slash relative paths",
    filesSha256: createHash("sha256")
      .update(files.join("\n") + "\n")
      .digest("hex"),
    files,
    shards,
    index: options.index,
    total: options.total,
    selected: shards[options.index - 1],
  };
}

export async function runNode(
  args,
  { cwd, executable = process.execPath } = {},
) {
  // No shell, no test-name filter, no retry and no timeout-as-success path.
  const child = spawn(executable, args, { cwd, stdio: "inherit" });
  let interrupted = false;
  const forward = (signal) => {
    interrupted = true;
    child.kill(signal);
  };
  const onInt = () => forward("SIGINT"),
    onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    return await new Promise((resolve) => {
      child.once("error", (error) => {
        console.error(error);
        resolve(1);
      });
      child.once("close", (code, signal) => {
        if (signal) console.error(`Core test child terminated by ${signal}`);
        resolve(interrupted || signal || code === null ? 1 : code);
      });
    });
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

export function runtimeDiagnostics() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    availableParallelism: os.availableParallelism(),
    cpus: os.cpus().length,
    totalmem: os.totalmem(),
    ImageOS: process.env.ImageOS ?? null,
    ImageVersion: process.env.ImageVersion ?? null,
  };
}

export async function main(args, cwd = process.cwd()) {
  console.log("Core runtime " + JSON.stringify(runtimeDiagnostics()));
  const options = parseOptions(args);
  const plan = await createPlan(cwd, options);
  const prefix = `test-results/core-${options.label}-shard-${options.index}-of-${options.total}`;
  await mkdir(path.join(cwd, "test-results"), { recursive: true });
  await writeFile(
    path.join(cwd, `${prefix}.json`),
    JSON.stringify(plan, null, 2) + "\n",
  );
  console.log(
    `Core ${options.label} shard ${options.index}/${options.total}: ${plan.selected.length}/${plan.files.length} files; manifest ${prefix}.json; SHA256 ${plan.filesSha256}`,
  );
  if (options.list) {
    console.log(plan.selected.join("\n"));
    return 0;
  }
  return runNode(
    [
      "--test",
      `--test-concurrency=${plan.fileConcurrency}`,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=tap",
      `--test-reporter-destination=${prefix}.tap`,
      ...plan.selected,
    ],
    { cwd },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
