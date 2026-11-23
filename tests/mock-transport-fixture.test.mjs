import assert from "node:assert/strict";
import test from "node:test";
import { isMockTransportRoute } from "./helpers/mock-transport-route.mjs";

test("no-dispatch browser fixture blocks both real Mock routes but permits client modules", () => {
  for (const path of [
    "/mock",
    "/mock/",
    "/mock/project/request",
    "/mock//project/request",
    "/app/mock/project",
    "/app/mock/project/fixture",
  ])
    assert.equal(isMockTransportRoute(path), true, path);

  for (const path of [
    "/mock-target.js",
    "/mock-field-data.js",
    "/http-debug-examples.js",
    "/app/mock/projects-not-an-alias",
    "/api/projects/fixture",
  ])
    assert.equal(isMockTransportRoute(path), false, path);
});
