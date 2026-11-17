import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import {
  observeDesktopProcess,
  observeDesktopElectron,
} from "./fixtures/desktop-lifecycle-observer.mjs";

test("process observation is bounded and never records event payloads", () => {
  const child = new EventEmitter(),
    entries = [];
  const record = observeDesktopProcess(child, (entry) => entries.push(entry));
  record("private");
  record("cleanup-signal", true);
  record("cleanup-signal", false);
  record("electron-observer-unavailable", "private");
  for (let i = 0; i < 10; i++) {
    child.emit("exit", "private", "private");
    child.emit("close", "private", "private");
  }
  assert.deepEqual(entries, [
    { event: "cleanup-signal", sent: true },
    { event: "electron-observer-unavailable" },
    { event: "exit" },
    { event: "close" },
  ]);
  const other = [];
  observeDesktopProcess(new EventEmitter(), (e) => other.push(e))(
    "cleanup-signal",
    "private",
  );
  assert.deepEqual(other, [{ event: "cleanup-signal", sent: false }]);
});

test("Electron observation survives serialization, observes without cancelling, and stays bounded across windows", () => {
  const app = new EventEmitter(),
    windows = [0, 1].map(() => ({ webContents: new EventEmitter() })),
    entries = [];
  const install = runInNewContext(`(${observeDesktopElectron.toString()})`, {
    console: {
      error: (marker, json) => entries.push([marker, JSON.parse(json)]),
    },
  });
  install({ app, BrowserWindow: { getAllWindows: () => windows } });
  const event = {
    preventDefault() {
      throw Error("must not cancel");
    },
  };
  for (let i = 0; i < 10; i++) {
    for (const label of ["before-quit", "will-quit", "quit"])
      app.emit(label, event);
    for (const win of windows)
      win.webContents.emit("will-prevent-unload", event);
  }
  assert.deepEqual(
    entries,
    ["before-quit", "will-quit", "quit", "will-prevent-unload"].map((event) => [
      "DESKTOP_ELECTRON_LIFECYCLE",
      { event },
    ]),
  );
});

test("reporting failures do not interrupt existing lifecycle handlers", () => {
  const child = new EventEmitter();
  const record = observeDesktopProcess(child, () => {
    throw Error("private");
  });
  let exits = 0;
  child.on("exit", () => exits++);
  assert.doesNotThrow(() => {
    record("cleanup-signal", true);
    child.emit("exit");
    child.emit("close");
  });
  assert.equal(exits, 1);
  const app = new EventEmitter();
  runInNewContext(`(${observeDesktopElectron.toString()})`, {
    console: {
      error() {
        throw Error("private");
      },
    },
  })({ app, BrowserWindow: { getAllWindows: () => [] } });
  assert.doesNotThrow(() => {
    for (const event of ["before-quit", "will-quit", "quit"]) app.emit(event);
  });
});

test("unload marker precedes a blocking existing native-dialog handler", () => {
  const contents = new EventEmitter(),
    entries = [];
  contents.on("will-prevent-unload", () => {
    entries.push("native-dialog");
    throw Error("simulated-block");
  });
  runInNewContext(`(${observeDesktopElectron.toString()})`, {
    console: { error: (_marker, json) => entries.push(JSON.parse(json).event) },
  })({
    app: new EventEmitter(),
    BrowserWindow: { getAllWindows: () => [{ webContents: contents }] },
  });
  assert.throws(() => contents.emit("will-prevent-unload"), /simulated-block/);
  assert.deepEqual(entries, ["will-prevent-unload", "native-dialog"]);
});
