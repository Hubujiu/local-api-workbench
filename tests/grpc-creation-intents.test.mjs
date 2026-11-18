import test from "node:test";
import assert from "node:assert/strict";
import { GrpcCreationIntents } from "../src/grpc-creation-intents.mjs";
function setup() {
  let starts = 0,
    time = 0;
  const sessions = {
    start(p, d, o, { onSubmitted }) {
      starts++;
      onSubmitted({ sessionId: "s" });
      return { id: "s" };
    },
    snapshot(p, id) {
      return { id };
    },
  };
  const journal = new GrpcCreationIntents(sessions, { now: () => time });
  const definition = { id: "d", target: "local" };
  return {
    journal,
    sessions,
    definition,
    starts: () => starts,
    advance: () => (time += 300001),
  };
}
test("correlation guards instance/project/definition and never repeats consumed intent", () => {
  const { journal, definition, starts } = setup();
  const r = journal.acquire("p", definition);
  assert.throws(() => journal.start("foreign", definition, {}, r));
  assert.throws(() =>
    journal.start("p", definition, {}, { ...r, instanceId: "other" }),
  );
  assert.throws(() =>
    journal.start("p", { ...definition, target: "changed" }, {}, r),
  );
  assert.equal(starts(), 0);
  journal.start("p", definition, { metadata: [{ secret: "not retained" }] }, r);
  assert.throws(() =>
    journal.start("p", definition, { message: "different" }, r),
  );
  assert.equal(starts(), 1);
  assert.equal(journal.read("p", r.intentId, r.instanceId).phase, "created");
  assert.equal(
    JSON.stringify([...journal.entries.values()]).includes("secret"),
    false,
  );
});
test("bounded journal permits 1000 creations but evicted IDs fail closed", () => {
  const { journal, definition, starts } = setup();
  const first = journal.acquire("p", definition);
  journal.start("p", definition, {}, first);
  for (let i = 1; i < 1000; i++) {
    const r = journal.acquire("p", definition);
    journal.start("p", definition, {}, r);
  }
  assert.equal(starts(), 1000);
  assert.equal(journal.entries.size, 256);
  assert.throws(() => journal.start("p", definition, {}, first));
  assert.equal(starts(), 1000);
});
test("reserved capacity expires without accepting delayed expired submissions", () => {
  const { journal, definition, advance, starts } = setup();
  const first = journal.acquire("p", definition);
  for (let i = 1; i < 256; i++) journal.acquire("p", definition);
  assert.throws(() => journal.acquire("p", definition));
  advance();
  assert.equal(
    journal.read("p", first.intentId, first.instanceId).phase,
    "expired",
  );
  assert.throws(() => journal.start("p", definition, {}, first));
  journal.acquire("p", definition);
  assert.throws(() => journal.start("p", definition, {}, first));
  assert.equal(starts(), 0);
});
test("failure consumes correlation and does not leak secrets or invite retry", () => {
  const { journal, definition, sessions } = setup();
  const r = journal.acquire("p", definition);
  sessions.start = () => {
    throw Error("secret");
  };
  assert.throws(() => journal.start("p", definition, {}, r));
  assert.equal(
    journal.read("p", r.intentId, r.instanceId).phase,
    "failed-before-submit",
  );
  assert.throws(() => journal.start("p", definition, {}, r));
  assert.equal(
    JSON.stringify(journal.read("p", r.intentId, r.instanceId)).includes(
      "secret",
    ),
    false,
  );
});
test("reading a reserved intent never consumes or executes a delayed start", () => {
  const { journal, definition, starts } = setup();
  const r = journal.acquire("p", definition);
  assert.equal(journal.read("p", r.intentId, r.instanceId).phase, "reserved");
  assert.equal(starts(), 0);
  journal.start("p", definition, {}, r);
  assert.equal(journal.read("p", r.intentId, r.instanceId).phase, "created");
  assert.equal(starts(), 1);
});
