import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
const networkFailure =
  /(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|network timeout|network error)/i;
export async function auditDependencies(
  run,
  {
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
  } = {},
) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await run();
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      /* Invalid output never counts as a passing audit. */
    }
    const counts = report?.metadata?.vulnerabilities;
    if (counts) {
      const valid =
        Number.isInteger(counts.high) &&
        counts.high >= 0 &&
        Number.isInteger(counts.critical) &&
        counts.critical >= 0;
      return result.code === 0 &&
        valid &&
        counts.high === 0 &&
        counts.critical === 0 &&
        !report.error
        ? 0
        : 1;
    }
    const transient =
      result.code !== 0 &&
      networkFailure.test(result.stdout + "\n" + result.stderr);
    if (!transient || attempt === 2) return 1;
    log(
      "npm audit network request failed; retrying once. Security findings and invalid reports are not accepted.",
    );
    await sleep(2000);
  }
  return 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const extra = process.argv.slice(2);
  const npm = process.env.npm_execpath;
  if (
    !npm ||
    (extra.length &&
      (extra.length !== 2 || extra[0] !== "--prefix" || extra[1] !== "desktop"))
  ) {
    console.error(
      "Use npm run audit:ci, optionally followed by -- --prefix desktop.",
    );
    process.exitCode = 1;
  } else {
    process.exitCode = await auditDependencies(
      () =>
        new Promise((resolve) => {
          execFile(
            process.execPath,
            [
              npm,
              "audit",
              "--json",
              "--audit-level=high",
              "--fetch-timeout=30000",
              "--fetch-retries=1",
              "--fetch-retry-mintimeout=2000",
              "--fetch-retry-maxtimeout=5000",
              ...extra,
            ],
            { timeout: 90000, maxBuffer: 4 * 1024 * 1024, env: process.env },
            (error, stdout, stderr) => {
              process.stdout.write(stdout || "");
              process.stderr.write(stderr || "");
              resolve({
                code: error
                  ? typeof error.code === "number"
                    ? error.code
                    : 1
                  : 0,
                stdout: stdout || "",
                stderr: stderr || "",
              });
            },
          );
        }),
      { log: (message) => console.error(message) },
    );
  }
}
