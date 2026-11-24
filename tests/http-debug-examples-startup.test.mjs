import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { bindExampleStartupTrace } from "./helpers/http-debug-examples-startup.mjs";

test("startup event handlers record only allowlisted and redacted fields", () => {
  const page = new EventEmitter();
  const origin = "http://127.0.0.1:38982";
  const ownerPath = "/api/projects/fixture-key";
  const trace = bindExampleStartupTrace(page, origin, ownerPath);
  const respond = (url, status) =>
    page.emit("response", { url: () => url, status: () => status });

  respond(origin + "/#token=never-report", 200);
  respond(origin + "/mock-target.js", 200);
  respond(origin + ownerPath + "?private=never-report", 200);
  respond(origin + "/api/projects/not-the-fixture", 410);
  respond("http://127.0.0.1:38983/app.js", 500);
  page.emit("requestfailed", { url: () => origin + "/app.js?q=never-report" });
  page.emit("pageerror", new ReferenceError("never-report"));
  page.emit("pageerror", new ReferenceError("repeated"));
  page.emit("pageerror", { name: "never-report" });

  assert.equal(trace.status("/mock-target.js"), 200);
  assert.deepEqual(trace.snapshot(), {
    responses: {
      "/": 200,
      "/mock-target.js": 200,
      "/api/projects/{fixture}": 200,
      "/app.js": "blocked or failed",
    },
    pageErrors: ["ReferenceError", "OtherError"],
  });
});
