import { createHash } from "node:crypto";
import { variableRows } from "../public/variable-definitions.js";
import { isDeepStrictEqual } from "node:util";
import { semanticRequest } from "./apipost-sample-export.mjs";
import { apipostResourceFactory } from "./apipost-modern.mjs";
const fail = () => {
  throw Error(
    "原生继承图目录flow不能无损保留独立HTTP冻结定义；请使用完整项目备份",
  );
};
const nonempty = (v) =>
  v != null && v !== "" && (typeof v !== "object" || Object.keys(v).length > 0);
export function validateInheritancePlans(plans) {
  if (!Array.isArray(plans) || plans.length > 50) fail();
  let count = 0;
  for (const plan of plans) {
    if (
      plan.statusPolicy !== "strict200" ||
      plan.functions?.length ||
      plan.importedNativeFlowSource !== undefined ||
      !["manual", "ai"].includes(plan.source) ||
      !Array.isArray(plan.steps) ||
      !plan.steps.length ||
      (count += plan.steps.length) > 200
    )
      fail();
    if (plan.provenance && Object.values(plan.provenance).some(nonempty))
      fail();
    for (const step of plan.steps) {
      if (
        step.type !== undefined ||
        !step.enabled ||
        step.nativeMCP !== undefined ||
        (step.expectedStatus !== undefined && step.expectedStatus !== 200)
      )
        fail();
      const r = step.request;
      if (
        !r ||
        r.nativeInheritance !== undefined ||
        [
          "before",
          "after",
          "beforeScript",
          "afterScript",
          "sharedBeforeScripts",
          "sharedAfterScripts",
          "assertions",
          "extract",
          "functions",
          "responses",
          "examples",
        ].some((k) => nonempty(r[k])) ||
        ["nativeTasks", "importedScriptTasks", "importedNativeTaskSource"].some(
          (k) => r[k] !== undefined,
        )
      )
        fail();
      if (
        ![
          "serviceSnapshot",
          "parametersSnapshot",
          "authSnapshot",
          "sharedScriptsSnapshot",
        ].every((k) => r[k] === true)
      )
        fail();
    }
  }
}
export function verifyInheritancePlans(project, check, flows) {
  validateInheritancePlans(project.plans || []);
  validateInheritancePlans(check.plans || []);
  if (check.plans.length !== project.plans.length) fail();
  const resource = apipostResourceFactory(flows[0]?.project_id || "empty");
  for (const [i, original] of project.plans.entries()) {
    const actual = check.plans[i],
      emitted = flows[i];
    if (
      !emitted ||
      actual.id !== resource("flow", emitted.flow_id) ||
      actual.environmentId !== resource("env", emitted.environment_id) ||
      actual.steps.length !== original.steps.length
    )
      fail();
    for (const key of [
      "name",
      "description",
      "source",
      "statusPolicy",
      "createdAt",
      "updatedAt",
    ])
      if (actual[key] !== original[key]) fail();
    const envIndex = project.environments.findIndex(
      (e) => e.id === original.environmentId,
    );
    if (
      envIndex < 0 ||
      check.environments[envIndex]?.id !== actual.environmentId
    )
      fail();
    const environment = (p, env) => ({
      name: env.name,
      variables: variableRows(
        env.variables || {},
        env.variableDefinitions || {},
      ),
      globals: variableRows(
        p.globalVariables || {},
        p.globalVariableDefinitions || {},
      ),
      servers: (p.servers || []).map((server) => ({
        name: server.name,
        url: env.serverUrls?.[server.id] || "",
      })),
    });
    if (
      !isDeepStrictEqual(
        environment(project, project.environments[envIndex]),
        environment(check, check.environments[envIndex]),
      )
    )
      fail();
    for (const [j, step] of original.steps.entries()) {
      const found = actual.steps[j];
      if (
        found.id !==
          resource(
            "flow-step",
            createHash("sha256")
              .update(emitted.flow_id + "\0" + emitted.steps[j].step_id)
              .digest("hex"),
          ) ||
        found.name !== step.name ||
        found.enabled !== step.enabled ||
        found.request.sourceOperationId !==
          "apipost:" + emitted.steps[j].target_id ||
        !isDeepStrictEqual(
          semanticRequest(step.request, project),
          semanticRequest(found.request, check),
        )
      )
        fail();
    }
  }
}
