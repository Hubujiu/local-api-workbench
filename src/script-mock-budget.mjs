export const scriptMockLimits = Object.freeze({
  mockCallLimit: 1000,
  mockNodeLimit: 10000,
  mockByteLimit: 1024 * 1024,
});

export function createScriptMockBudget(limits) {
  let calls = 0,
    nodes = 0,
    bytes = 0,
    exhausted = false;
  const fail = () => {
    // A caught exhaustion cannot refill on the next scope: publish saturated
    // trusted counters, not a guest-controlled reset flag.
    calls = limits.mockCallLimit;
    nodes = limits.mockNodeLimit;
    bytes = limits.mockByteLimit;
    exhausted = true;
    throw Error("Mock模板额度已用尽");
  };
  return {
    reserve(kind, nextNodes, nextBytes) {
      if (exhausted) fail();
      if (kind === 2 && nextNodes === 0 && nextBytes === 0) return;
      if (kind === 0 && nextNodes === 0 && nextBytes === 0) {
        if (calls >= limits.mockCallLimit) fail();
        calls++;
        return;
      }
      if (
        kind !== 1 ||
        !Number.isInteger(nextNodes) ||
        nextNodes < 1 ||
        nextNodes > 1000 ||
        !Number.isInteger(nextBytes) ||
        nextBytes < 1 ||
        nextBytes > 65536
      )
        throw Error("Mock模板内部计费无效");
      if (
        nextNodes > limits.mockNodeLimit - nodes ||
        nextBytes > limits.mockByteLimit - bytes
      )
        fail();
      nodes += nextNodes;
      bytes += nextBytes;
    },
    usage() {
      return { mockCalls: calls, mockNodes: nodes, mockBytes: bytes };
    },
  };
}

export function validateScriptMockUsage(usage, limits) {
  for (const [key, limit] of [
    ["mockCalls", limits.mockCallLimit],
    ["mockNodes", limits.mockNodeLimit],
    ["mockBytes", limits.mockByteLimit],
  ])
    if (!Number.isInteger(usage?.[key]) || usage[key] < 0 || usage[key] > limit)
      throw Error("Mock模板计费结果无效");
}
