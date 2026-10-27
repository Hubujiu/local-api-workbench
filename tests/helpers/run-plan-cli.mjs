import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export function runPlanCLI(root, projectId, planId, environmentId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        projectId,
        "--plan",
        planId,
        ...(environmentId === undefined
          ? []
          : ["--environment", environmentId]),
      ],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => {
      failure = Error("Plan CLI fixture timed out");
      child.kill();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        failure = Error("CLI output exceeds bound");
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      failure ? reject(failure) : resolve({ code, signal, stdout, stderr });
    });
  });
}
