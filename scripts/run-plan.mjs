import { prepareCLIDatabaseGrants } from "../src/cli-database-grants.mjs";
import { readRuntimeCredentials } from "../src/cli-runtime-credentials.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { executeSocketIOFlow } from "../src/socketio-plan.mjs";
import { executeGrpc } from "../src/grpc.mjs";
import { recordPlanRun } from "../src/plan-evidence.mjs";
import { projectCookieSession } from "../src/cookie-jar.mjs";
import { scopedExecution } from "../src/variable-scopes.mjs";
import {
  environmentVariables,
  selectedEnvironment,
  resolveServiceRequest,
} from "../src/environments.mjs";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { Store, executeRequest } from "../src/runtime.mjs";
import { runPlan } from "../src/core.mjs";
const args = process.argv.slice(2),
  option = (key) => args[args.indexOf(key) + 1];
if (!args.includes("--project") || !args.includes("--plan")) {
  console.error(
    "Usage: node scripts/run-plan.mjs --project ID --plan ID [--environment ID] [--output evidence.json] [--credentials-stdin] [--database-stdin]",
  );
  process.exitCode = 2;
} else {
  let databaseGrants;
  try {
    const store = new Store(
        path.resolve(process.env.LOCAL_API_DATA || ".local-api"),
      ),
      project = await store.get(option("--project")),
      plan = project.plans.find((p) => p.id === option("--plan"));
    if (!plan) throw Error("Plan not found");
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const databaseEnabled = args.includes("--database-stdin");
    const credentials =
      args.includes("--credentials-stdin") || databaseEnabled
        ? await readRuntimeCredentials(process.stdin, {
            signal: controller.signal,
            allowDatabase: databaseEnabled,
          })
        : {};
    if (databaseEnabled)
      databaseGrants = prepareCLIDatabaseGrants(
        project.id,
        plan,
        credentials.databaseConnections || {},
        project.settings?.apipostDatabases || [],
      );
    delete credentials.databaseConnections;
    const environmentId = selectedEnvironment(
      project,
      args.includes("--environment")
        ? option("--environment")
        : plan.environmentId,
    ).id;
    let run = await runPlan(
      plan,
      environmentVariables(project, environmentId),
      executeRequest,
      {
        ...scopedExecution(store, project, environmentId),
        ...credentials,
        databaseQuery: databaseGrants
          ? (operation, signal) => databaseGrants.query(operation, signal)
          : undefined,
        executeGrpc,
        executeProtocol: executeWireFlow,
        executeSocketIO: (input, signal) =>
          executeSocketIOFlow(input, signal, { projectId: project.id }),
        cookieSession: projectCookieSession(store, project, environmentId),
        signal: controller.signal,
        prepareRequest: (request) =>
          resolveServiceRequest(project, request, environmentId),
        onStep: (step) =>
          process.stderr.write(`${step.status.toUpperCase()} ${step.name}\n`),
      },
    );
    run.environmentId = environmentId;
    run = await recordPlanRun(store, project.id, run, "cli");
    const json = JSON.stringify(run, null, 2) + "\n";
    if (args.includes("--output"))
      await writeFile(option("--output"), json, { mode: 0o600 });
    process.stdout.write(json);
    process.exitCode = !run.recordSaved ? 2 : run.status === "passed" ? 0 : 1;
  } catch (e) {
    process.stderr.write(e.message + "\n");
    process.exitCode = 2;
  } finally {
    databaseGrants?.close();
  }
}
