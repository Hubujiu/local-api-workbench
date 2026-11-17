import { runScript, runScriptSequence } from "../../src/scripts.mjs";
import { scriptFailureDetails } from "../../src/script-diagnostics.mjs";

const mode = process.env.LOCAL_API_ACCOUNTING_PROBE;
try {
  let result;
  if (mode === "compatibility") {
    const code =
      "for(let i=0;i<60;i++)await new Promise(resolve=>setTimeout(resolve,0));";
    result = await runScriptSequence(
      [
        { name: "a", code },
        { name: "b", code },
      ],
      { variables: {} },
    );
  } else if (mode === "evidence-parse") {
    result = await runScript(
      "__nativeAssertionTask(0);",
      { request: {}, variables: { x: 7 } },
      {
        responseAssertions: [
          {
            name: "direct",
            data: {
              type: "envVars",
              expression: { path: "x", compareType: "eq", compareValue: "7" },
            },
          },
        ],
      },
    );
  } else {
    result = await runScript(
      mode === "guest-loop"
        ? "while(true){}"
        : 'pm.variables.set("payload", "x".repeat(900000));',
      { variables: { retained: "original" } },
    );
  }
  console.log(
    JSON.stringify({
      success: true,
      payloadLength: result.localVariables.payload?.length,
      retained: result.variables.retained,
      activityMs: result.activityMs,
      activityMetrics: result.activityMetrics,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      success: false,
      message: error.message,
      ...scriptFailureDetails(error),
    }),
  );
}
