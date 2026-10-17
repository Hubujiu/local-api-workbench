import path from "node:path";
import { writeFile } from "node:fs/promises";
import { Store, executeRequest } from "../src/runtime.mjs";
import { runPlan } from "../src/core.mjs";
const args = process.argv.slice(2),
  option = (key) => args[args.indexOf(key) + 1];
if (!args.includes("--project") || !args.includes("--plan")) {
  console.error(
    "Usage: node scripts/run-plan.mjs --project ID --plan ID [--environment ID] [--output evidence.json]",
  );
  process.exitCode = 2;
} else {
  try {
    const store = new Store(
        path.resolve(process.env.LOCAL_API_DATA || ".local-api"),
      ),
      project = await store.get(option("--project")),
      plan = project.plans.find((p) => p.id === option("--plan"));
    if (!plan) throw Error("Plan not found");
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const environmentId = args.includes("--environment")
      ? option("--environment")
      : plan.environmentId;
    const run = await runPlan(
      plan,
      project.environments.find((e) => e.id === environmentId)?.variables || {},
      executeRequest,
      {
        signal: controller.signal,
        onStep: (step) =>
          process.stderr.write(`${step.status.toUpperCase()} ${step.name}\n`),
      },
    );
    await store.append(project.id, "runs", run);
    const json = JSON.stringify(run, null, 2) + "\n";
    if (args.includes("--output"))
      await writeFile(option("--output"), json, { mode: 0o600 });
    process.stdout.write(json);
    process.exitCode = run.status === "passed" ? 0 : 1;
  } catch (e) {
    process.stderr.write(e.message + "\n");
    process.exitCode = 2;
  }
}
