import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  cancelProtocolWindowClose,
  assertProtocolCloseReceipt,
} from "./helpers/protocol-draft-close-electron.mjs";
function fixture({
  choiceOptions = {},
  extraCalls = false,
  closes = false,
  throws = false,
} = {}) {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.isDestroyed = () => closes;
  const original = () => {
    throw Error("must intercept native dialog only");
  };
  const dialog = { showMessageBoxSync: original };
  win.webContents.on("will-prevent-unload", () => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      title: "未保存的修改",
      message: "当前有未保存的修改，是否放弃并退出？",
      buttons: ["留在应用", "放弃并退出"],
      defaultId: 0,
      cancelId: 0,
      ...choiceOptions,
    });
    assert.equal(choice, 0);
    if (extraCalls) dialog.showMessageBoxSync(win, {});
  });
  win.close = () => {
    if (throws) throw Error("close failed");
    win.webContents.emit("will-prevent-unload");
    if (closes) win.emit("closed");
  };
  return {
    win,
    dialog,
    original,
    BrowserWindow: { getAllWindows: () => [win] },
  };
}
test("actual close adapter demands one unload receipt and restores dialog boundary", async () => {
  const f = fixture();
  assertProtocolCloseReceipt(await cancelProtocolWindowClose(f));
  assert.equal(f.dialog.showMessageBoxSync, f.original);
  assert.equal(f.win.webContents.listenerCount("will-prevent-unload"), 1);
});
for (const [name, options] of [
  ["unsafe default", { choiceOptions: { defaultId: 1 } }],
  ["unsafe cancel", { choiceOptions: { cancelId: 1 } }],
  ["duplicate dialog", { extraCalls: true }],
  ["closed window", { closes: true }],
])
  test(`receipt rejects ${name}`, async () => {
    const f = fixture(options);
    const receipt = await cancelProtocolWindowClose(f);
    assert.throws(() => assertProtocolCloseReceipt(receipt));
    assert.equal(f.dialog.showMessageBoxSync, f.original);
  });
test("close exception restores adapter and listeners", async () => {
  const f = fixture({ throws: true });
  await assert.rejects(cancelProtocolWindowClose(f), /close failed/);
  assert.equal(f.dialog.showMessageBoxSync, f.original);
  assert.equal(f.win.webContents.listenerCount("will-prevent-unload"), 1);
});
test("multiple windows fail closed before installing dialog adapter", async () => {
  const f = fixture();
  f.BrowserWindow.getAllWindows = () => [f.win, f.win];
  await assert.rejects(cancelProtocolWindowClose(f), /exactly one/);
  assert.equal(f.dialog.showMessageBoxSync, f.original);
});

// The coordinator must not accept a dialog receipt alone: renderer continuity
// and preserved draft input are independently required.
import { exerciseProtocolDraftClose } from "./helpers/protocol-draft-close-electron.mjs";
for (const failure of [
  null,
  "document",
  "navigation",
  "input",
  "mutation",
  "closed",
]) {
  test(`renderer continuity ${failure || "success"}`, async (t) => {
    t.mock.method(console, "log", () => {});
    const page = new EventEmitter();
    const frame = {};
    let value = "",
      disposed = 0;
    page.mainFrame = () => frame;
    page.isClosed = () => failure === "closed";
    page.locator = () => ({
      click: async () => {},
      inputValue: async () => value,
      fill: async (v) => {
        value = v;
      },
    });
    page.evaluateHandle = async () => ({
      evaluate: async () => failure !== "document",
      dispose: async () => disposed++,
    });
    const app = {
      evaluate: async (fn) => {
        assert.equal(fn, cancelProtocolWindowClose);
        if (failure === "navigation") page.emit("framenavigated", frame);
        if (failure === "input") value = "lost";
        if (failure === "mutation")
          page.emit("request", { method: () => "POST" });
        return cancelProtocolWindowClose(fixture());
      },
    };
    if (failure) await assert.rejects(exerciseProtocolDraftClose(app, page));
    else {
      await exerciseProtocolDraftClose(app, page);
      assert.equal(value, "");
    }
    assert.equal(disposed, failure ? 1 : 2);
    assert.equal(page.listenerCount("request"), 0);
    assert.equal(page.listenerCount("framenavigated"), 0);
  });
}
