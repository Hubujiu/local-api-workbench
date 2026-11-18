import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { listenForWorkbench } from "../src/workbench-listener.mjs";

test("dynamic listen rebinds restricted OS ports before exposing the application", async () => {
  const raw = new EventEmitter();
  const ports = [6667, 10080, 51001];
  let cycles = 0;
  raw.listen = (port, host, callback) => {
    assert.equal(port, 0);
    assert.equal(host, "127.0.0.1");
    callback();
  };
  raw.address = () => ({ port: ports[cycles] });
  raw.close = (callback) => {
    cycles++;
    callback();
  };
  await listenForWorkbench(raw, 0);
  assert.equal(raw.address().port, 51001);
  assert.equal(cycles, 2);
  assert.equal(raw.listenerCount("error"), 0);
});
