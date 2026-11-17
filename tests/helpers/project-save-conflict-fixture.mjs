import assert from "node:assert/strict";

// Only the newly created fixture project is touched. The second owner is an
// explicit HTTP client, not a route mock or a fabricated conflict response.
export async function commitConcurrentProjectEdit(owner, endpoint, expectedId) {
  const before = await owner(endpoint);
  assert.equal(before.id, expectedId);
  assert.equal(before.requests.length, 1);
  const candidate = structuredClone(before);
  candidate.name = "Concurrent owner project";
  candidate.requests[0].name = "Concurrent owner request";
  const committed = await owner(endpoint, "PUT", candidate);
  assert.equal(committed.id, expectedId);
  assert.equal(committed.configRevision, before.configRevision + 1);
  assert.equal(committed.name, candidate.name);
  assert.equal(committed.requests[0].name, candidate.requests[0].name);
  return { before, committed };
}
export function assertStaleProjectRejection(status, receipt, id) {
  assert.equal(status, 400); // Current owner PUT contract, not a mocked 409.
  assert.equal(receipt.project_id, id);
  assert.equal(receipt.commit_outcome, "not_committed");
  assert.equal(receipt.retry_safe, false);
  assert.equal(typeof receipt.error, "string");
  assert.ok(receipt.error.length);
}
