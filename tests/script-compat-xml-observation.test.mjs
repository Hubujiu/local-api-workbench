import test from "node:test";
import assert from "node:assert/strict";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { workerFailureMetadata } from "./helpers/worker-rejection-diagnostics.mjs";

test("XML semantic rejection retains bounded startup timing observation", async (t) => {
  const tasks = [
    {
      type: "pickVars",
      enabled: 1,
      data: {
        source: "responseXml",
        variables: [
          {
            name: "token",
            expression: "string(/login/token)",
            type: "envVars",
          },
        ],
      },
    },
  ];
  let captured;
  try {
    await runNativeTaskPhase(tasks, {
      request: {},
      response: {
        status: 200,
        body: '<login bad="&#xD800;"><token>ok</token></login>',
      },
      variables: {},
    });
  } catch (error) {
    captured = error;
  }
  assert(captured, "invalid XML must reject");
  const observation = workerFailureMetadata(captured);
  t.diagnostic("XML_COMPAT_TIMING " + JSON.stringify(observation));
  assert.match(captured.message, /XML.*字符/);
  assert.equal(observation.compatibilityDiagnostics?.version, 1);
  assert(
    Number.isSafeInteger(observation.compatibilityDiagnostics?.evaluationMs),
  );
});
