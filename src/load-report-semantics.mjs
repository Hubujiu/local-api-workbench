// Report-only vocabulary. Never infer classification from remote error strings,
// and never change the executor's pass/fail decisions.
const reasons = Object.freeze([
  "http-status-policy",
  "assertion",
  "execution",
  "cancelled",
  "redirect",
]);
export function loadFailureCounts() {
  return Object.fromEntries(reasons.map((reason) => [reason, 0]));
}
export function countLoadFailures(counts, values) {
  for (const reason of reasons) if (values.includes(reason)) counts[reason]++;
}
export function loadFailureReasons(
  record,
  {
    policy = "plan",
    expectedStatus,
    strict200 = false,
    cancelled = false,
  } = {},
) {
  const result = new Set();
  const redirect = record?.redirectFailure;
  if (cancelled || redirect?.reason === "cancelled") result.add("cancelled");
  if (redirect) result.add("redirect");
  const assertions = record?.assertions || [];
  if (assertions.some((assertion) => !assertion.passed))
    result.add("assertion");
  const status = record?.response?.status;
  if (!redirect && Number.isInteger(status)) {
    const accepted =
      policy === "2xx-and-assertions"
        ? status >= 200 && status < 300
        : strict200
          ? status === 200
          : expectedStatus !== undefined
            ? status === expectedStatus
            : assertions.some((assertion) => assertion.target === "status") ||
              (status >= 200 && status < 300);
    if (!accepted) result.add("http-status-policy");
  }
  if (
    !redirect &&
    !result.has("cancelled") &&
    (record?.error || record?.failure)
  )
    result.add("execution");
  if (record?.status !== "passed" && !result.size) result.add("execution");
  return reasons.filter((reason) => result.has(reason));
}
