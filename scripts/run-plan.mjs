import {
  hasLiveReferences,
  materializeLivePlan,
} from "../src/live-plan-materialize.mjs";
import { activePlanLeaves, hasIfSteps } from "../src/plan-repeat.mjs";
import { validatePlanStepTypes } from "../src/plan-step-types.mjs";
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
  createServiceRequestResolver,
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
      initialProject = await store.get(option("--project"));
    let project = initialProject,
      definition = project.plans.find((p) => p.id === option("--plan"));
    if (!definition) throw Error("Plan not found");
    validatePlanStepTypes(definition.steps);
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
    if (hasLiveReferences(definition)) {
      project = await store.get(option("--project"));
      controller.signal.throwIfAborted();
      definition = project.plans.find((p) => p.id === option("--plan"));
      if (!definition) throw Error("Plan not found");
    }
    const { plan, bindings } = materializeLivePlan(project, definition);
    controller.signal.throwIfAborted();
    // Canonical IF has a conservative declaration-level grant contract: an
    // enabled potential DB leaf needs an explicit invocation grant even if its
    // condition later evaluates false. Dynamic script calls retain runtime checks.
    // Do not inspect unrelated DB catalogues for ordinary HTTP-only IF plans.
    const conditionalDatabase =
      hasIfSteps(plan.steps) &&
      activePlanLeaves(plan.steps).some(({ request }) =>
        ["before", "after"].some(
          (phase) =>
            (request?.[phase] || []).some(
              (operation) =>
                operation.type === "database" && operation.enabled !== false,
            ) ||
            (request?.nativeTasks?.[phase] || []).some(
              (task) => task.type === "database" && task.enabled === 1,
            ),
        ),
      );
    if (databaseEnabled || conditionalDatabase)
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
        prepareRequest: createServiceRequestResolver(project, environmentId),
        onStep: (step) =>
          process.stderr.write(`${step.status.toUpperCase()} ${step.name}\n`),
      },
    );
    run.environmentId = environmentId;
    if (bindings.length) run.liveBindings = bindings;
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
