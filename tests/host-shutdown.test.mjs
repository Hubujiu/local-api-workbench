import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createHostShutdown,
  installNodeShutdown,
  installDesktopShutdown,
} from "../src/host-shutdown.mjs";
const tick = () => new Promise((r) => setImmediate(r));

test("signals during startup and repeated signals join one persistence drain", async () => {
  const host = new EventEmitter(),
    logs = [];
  let ready,
    saved,
    calls = 0;
  const service = new Promise((r) => {
    ready = r;
  });
  const close = installNodeShutdown(service, host, (line) => logs.push(line));
  host.emit("SIGTERM");
  host.emit("SIGINT");
  await tick();
  assert.equal(host.exitCode, undefined);
  ready({
    close: () => {
      calls++;
      return new Promise((r) => {
        saved = r;
      });
    },
  });
  await tick();
  host.emit("SIGTERM");
  assert.equal(calls, 1);
  assert.equal(host.exitCode, undefined);
  saved({ allRecordsSaved: true });
  assert.equal(await close(), 0);
  await tick();
  assert.equal(host.exitCode, 0);
  assert.deepEqual(logs, ["LOCAL_API_SHUTDOWN_SAVED"]);
});

test("unsaved, unknown, startup rejection and close rejection are fixed redacted failures", async () => {
  for (const service of [
    {
      close: async () => ({
        allRecordsSaved: false,
        protocolSessions: [
          { password: "secret", persistenceOutcome: { outcome: "unknown" } },
        ],
      }),
    },
    {
      close: async () => {
        throw Error("/private/path secret");
      },
    },
    Promise.reject(Error("startup secret")),
    { close: async () => undefined },
  ]) {
    const logs = [],
      close = createHostShutdown(service, (line) => logs.push(line));
    const result = close();
    assert.equal(close(), result);
    assert.equal(await result, 2);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /UNCONFIRMED/);
    assert.doesNotMatch(logs[0], /secret|private|rollback/);
  }
});

test("desktop cancellation does not close service; approved will-quit waits and exits once", async () => {
  for (const success of [true, false]) {
    const app = new EventEmitter(),
      exits = [],
      logs = [];
    app.exit = (code) => exits.push(code);
    let saved,
      calls = 0,
      prevented = 0;
    installDesktopShutdown(
      app,
      {
        close: () => {
          calls++;
          return new Promise((r) => {
            saved = r;
          });
        },
      },
      (line) => logs.push(line),
    );
    app.emit("before-quit", { preventDefault() {} });
    // A renderer refusing window close never reaches will-quit.
    await tick();
    assert.equal(calls, 0);
    assert.deepEqual(exits, []);
    const event = {
      preventDefault() {
        prevented++;
      },
    };
    app.emit("will-quit", event);
    app.emit("will-quit", event);
    await tick();
    assert.equal(calls, 1);
    assert.equal(prevented, 2);
    assert.deepEqual(exits, []);
    saved({ allRecordsSaved: success });
    await tick();
    assert.deepEqual(exits, [success ? 0 : 2]);
    assert.equal(logs.length, 1);
  }
});
