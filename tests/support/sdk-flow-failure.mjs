import { scriptFailureDetails } from "../../src/script-diagnostics.mjs";

const status = (value) =>
  ["passed", "failed", "cancelled", "skipped"].includes(value)
    ? value
    : "unknown";

// Input is the already JSON-decoded SDK response. Never print the response,
// arbitrary error text, scope names, requests, credentials or variable values.
export function sdkFlowFailureContext(outcome) {
  const step = outcome?.results?.[0] || {};
  const details = scriptFailureDetails(step);
  const assertions = Array.isArray(step.assertions) ? step.assertions : [];
  const context = {
    label: "sdk-environment-override",
    status: status(outcome?.status),
    stepStatus: status(step.status),
    hasError: typeof step.error === "string" && step.error.length > 0,
    failedAssertionCount: assertions
      .slice(0, 1000)
      .filter((entry) => entry?.passed === false).length,
    assertionCountCapped: assertions.length > 1000,
  };
  const httpStatus = step.response?.status;
  if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)
    context.httpStatus = httpStatus;
  // scriptScope is deliberately NOT copied: it permits arbitrary short text.
  for (const key of ["scriptStage", "scriptDiagnostics", "sequenceActivity"])
    if (Object.hasOwn(details, key)) context[key] = details[key];
  return context;
}
