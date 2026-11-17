import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOwnerProjectPutOutcome } from "../src/owner-project-put-outcome.mjs";
import {
  ProjectCommitUncertain,
  ProjectRecoveryRequired,
} from "../src/project-commit-outcome.mjs";
import { saveProjectArchive } from "../src/project-archive-grants.mjs";
import { createApp } from "../src/server.mjs";

for (const asynchronous of [false, true]) {
  for (const uncertain of [false, true]) {
    test(`Store ${asynchronous ? "async" : "sync"} ${uncertain ? "uncertain" : "definite"} rejection is not replayed`, async () => {
      const outcome = createOwnerProjectPutOutcome("project-1");
      outcome.validatedRead();
      const error = uncertain
        ? new ProjectCommitUncertain("project-1", Error("disk"))
        : Error("invalid");
      let calls = 0;
      const fail = () => {
        calls++;
        throw error;
      };
      await assert.rejects(
        outcome.save(asynchronous ? async () => fail() : fail),
        (e) => e === error,
      );
      assert.equal(calls, 1);
      assert.deepEqual(outcome.public(error), {
        project_id: "project-1",
        commit_outcome: uncertain ? "unknown" : "not_committed",
        retry_safe: false,
      });
    });
  }
  test(`Store ${asynchronous ? "async" : "sync"} success then archive revoke failure remains unknown`, async () => {
    const outcome = createOwnerProjectPutOutcome("project-1");
    outcome.validatedRead();
    let saves = 0,
      revokes = 0;
    const save = () => {
      saves++;
      return { id: "project-1", archived: true };
    };
    const error = Error("revoke");
    await assert.rejects(
      saveProjectArchive(
        { id: "project-1", archived: true },
        () => outcome.save(asynchronous ? async () => save() : save),
        () => {
          revokes++;
          throw error;
        },
      ),
      (e) => e === error,
    );
    assert.equal(saves, 1);
    assert.equal(revokes, 1);
    assert.equal(outcome.public(error).commit_outcome, "unknown");
    assert.equal(outcome.public(error).retry_safe, false);
  });
}

test("read and post-commit boundaries never infer commit outcome from HTTP-style error codes", async () => {
  const outcome = createOwnerProjectPutOutcome("project-1");
  assert.equal(outcome.public(Error("read")).commit_outcome, "unknown");
  outcome.validatedRead();
  assert.equal(
    outcome.public(Error("validation")).commit_outcome,
    "not_committed",
  );
  assert.equal(
    outcome.public(new ProjectRecoveryRequired(["project-1"])).commit_outcome,
    "unknown",
  );
  await outcome.save(() => ({}));
  for (const code of ["ENOENT", "EACCES", undefined]) {
    const result = outcome.public(Object.assign(Error("post-save"), { code }));
    assert.equal(result.commit_outcome, "unknown");
    assert.equal(result.retry_safe, false);
  }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owner-put-outcome-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const owner = async (url, method = "GET", data, status = 200) => {
    const response = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const project = await owner(
    "/api/projects",
    "POST",
    { name: "Outcome fixture" },
    201,
  );
  return { app, owner, project, url: `/api/projects/${project.id}` };
}
function rejected(result, id, outcome) {
  assert.equal(result.project_id, id);
  assert.equal(result.commit_outcome, outcome);
  assert.equal(result.retry_safe, false);
}
test("real owner PUT validation and stale revision are definite rejection with no disk mutation", async (t) => {
  const { app, owner, project, url } = await fixture(t);
  const before = structuredClone(await app.store.get(project.id));
  rejected(
    await owner(url, "PUT", { ...project, requests: {} }, 400),
    project.id,
    "not_committed",
  );
  assert.deepEqual(await app.store.get(project.id), before);
  await owner(url, "PUT", { ...project, name: "Accepted once" });
  const acceptedDisk = structuredClone(await app.store.get(project.id));
  rejected(
    await owner(url, "PUT", { ...project, name: "Stale draft" }, 400),
    project.id,
    "not_committed",
  );
  assert.deepEqual(await app.store.get(project.id), acceptedDisk);
});
test("real journal publication failure is unknown and recovers once without replay", async (t) => {
  const { app, owner, project, url } = await fixture(t);
  const plans = path.join(app.store.directory(project.id), "plans");
  await rm(plans, { recursive: true });
  await writeFile(plans, "test-owned obstruction");
  const result = await owner(
    url,
    "PUT",
    { ...project, name: "Journal candidate" },
    400,
  );
  rejected(result, project.id, "unknown");
  assert.equal(result.code, "PROJECT_COMMIT_UNCERTAIN");
  await rm(plans);
  const recovered = await owner(url);
  assert.equal(recovered.name, "Journal candidate");
  assert.equal(recovered.revision, project.revision + 1);
  assert.deepEqual(await owner(url), recovered);
});
