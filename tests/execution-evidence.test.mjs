import test from "node:test";
import assert from "node:assert/strict";
import {
  appendExecutionRecord,
  recordSaveFailure,
  recordSaveSuccess,
} from "../src/execution-evidence.mjs";
import {
  ProjectCommitUncertain,
  ProjectRecoveryRequired,
} from "../src/project-commit-outcome.mjs";

test("execution receipts distinguish confirmed, unknown and generic save outcomes without error detail leakage", async () => {
  const secret = "/private/fixture?password=do-not-return";
  assert.deepEqual(recordSaveSuccess("record"), {
    recordSaved: true,
    recordId: "record",
    attemptedRecordId: "record",
  });
  const generic = recordSaveFailure("project", "record", new Error(secret));
  assert.deepEqual(generic.persistenceOutcome, {
    code: "RECORD_SAVE_FAILED",
    retry_safe: false,
  });
  const uncertain = recordSaveFailure(
    "project",
    "record",
    new ProjectCommitUncertain("project", new Error(secret)),
  );
  assert.deepEqual(uncertain.persistenceOutcome, {
    code: "PROJECT_COMMIT_UNCERTAIN",
    project_id: "project",
    commit_outcome: "unknown",
    retry_safe: false,
  });
  const recovery = recordSaveFailure(
    "project",
    "record",
    new ProjectRecoveryRequired(["project", "other-private-project"]),
  );
  assert.deepEqual(recovery.persistenceOutcome, {
    code: "PROJECT_RECOVERY_REQUIRED",
    project_ids: ["project"],
    retry_safe: false,
  });
  const forged = recordSaveFailure("project", "record", {
    code: "PROJECT_COMMIT_UNCERTAIN",
    message: secret,
    projectId: secret,
    cause: new Error(secret),
  });
  assert.equal(forged.persistenceOutcome.code, "RECORD_SAVE_FAILED");
  const outsideScope = recordSaveFailure(
    "project",
    "record",
    new ProjectCommitUncertain(secret, new Error(secret)),
  );
  assert.equal(outsideScope.persistenceOutcome.project_id, undefined);
  for (const receipt of [generic, uncertain, recovery, forged, outsideScope]) {
    assert.equal(receipt.recordSaved, false);
    assert.equal(receipt.recordId, null);
    assert.equal(receipt.attemptedRecordId, "record");
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 1024);
    assert.equal(receipt.error, undefined);
    assert.equal(receipt.cause, undefined);
  }
  let attempts = 0;
  const receipt = await appendExecutionRecord(
    {
      append: async () => {
        attempts++;
        throw new Error(secret);
      },
    },
    "project",
    "history",
    { id: "record" },
  );
  assert.equal(attempts, 1);
  assert.deepEqual(receipt, generic);
});
