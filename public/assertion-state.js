export function assertionState(assertion) {
  if (assertion.passed !== true) return "failed";
  return assertion.skipped === true ? "skipped" : "passed";
}
export function assertionCounts(assertions = []) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const assertion of assertions) counts[assertionState(assertion)]++;
  return counts;
}
