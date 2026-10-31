import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("protocol elapsed deadlines preserve transport minima and civil timestamps", async () => {
  const read = (name) =>
    readFile(new URL(`../src/${name}.mjs`, import.meta.url), "utf8");
  const reflection = await read("grpc-reflection"),
    socket = await read("socketio"),
    grpc = await read("grpc");
  for (const source of [reflection, socket]) {
    assert(
      source.includes(
        "const monotonicNow = performance.now.bind(performance);",
      ),
    );
    assert(!source.includes("Date.now()"));
  }
  for (const literal of [
    "const started = monotonicNow(),",
    "end = started + timeout,",
    "const remaining = Math.floor(end - monotonicNow());",
    "if (remaining < 50)",
    "timeoutMs: remaining,",
    "if (monotonicNow() > end)",
    "timeout < 50 || timeout > 30000",
    "if (queries >= 32)",
  ])
    assert(reflection.includes(literal), literal);
  for (const literal of [
    "if (p.deadline <= monotonicNow()) s.pending.delete(id);",
    "deadline: monotonicNow() + 30000,",
    "if (!pending || pending.deadline <= monotonicNow())",
    "if (s.pending.size >= 100)",
    "createdAt: new Date().toISOString(),",
    "at: new Date().toISOString(),",
  ])
    assert(socket.includes(literal), literal);
  assert(
    grpc.includes("deadline: new Date(Date.now() + definition.timeoutMs)"),
  );
  assert(
    grpc.includes(
      '() => finish(grpc.status.DEADLINE_EXCEEDED, "gRPC调用超时")',
    ),
  );
});
