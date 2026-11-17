import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { assertProtocolDraftBlocksReload } from "./helpers/protocol-draft-unload-ui.mjs";

function fixture({
  dialog = true,
  dismissError = null,
  committed = false,
  sameDocument = true,
  value = "draft",
  error = Object.assign(new Error("page.reload: Timeout 10000ms exceeded"), {
    name: "TimeoutError",
  }),
} = {}) {
  const page = new EventEmitter();
  const frame = {};
  let disposed = false;
  page.mainFrame = () => frame;
  page.locator = () => ({
    click: async () => {},
    inputValue: async () => value,
  });
  page.evaluateHandle = async () => ({
    evaluate: async () => sameDocument,
    dispose: async () => {
      disposed = true;
    },
  });
  page.reload = async (options) => {
    assert.equal(options.timeout, 10000);
    if (dialog) {
      page.emit("dialog", {
        type: () => "beforeunload",
        dismiss: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (dismissError) throw dismissError;
        },
      });
    }
    if (committed) page.emit("framenavigated", frame);
    if (error) throw error;
  };
  return {
    page,
    clean: () =>
      disposed &&
      page.listenerCount("dialog") === 0 &&
      page.listenerCount("framenavigated") === 0,
  };
}
for (const [label, options] of [
  ["bounded Chromium timeout with positive cancellation proof", {}],
  [
    "explicit Chromium navigation abort",
    { error: new Error("net::ERR_ABORTED") },
  ],
])
  test(label, async (t) => {
    t.mock.method(console, "log", () => {});
    const f = fixture(options);
    await assertProtocolDraftBlocksReload(f.page, "#draft", "draft");
    assert(f.clean());
  });
for (const [label, options] of [
  ["timeout without a dialog", { dialog: false }],
  ["failed dismissal", { dismissError: new Error("dismiss failed") }],
  ["committed navigation", { committed: true }],
  ["replacement document", { sameDocument: false }],
  ["lost draft", { value: "" }],
  ["unrelated failure", { error: new Error("browser disconnected") }],
  ["successful reload", { error: null }],
])
  test(`rejects ${label}`, async (t) => {
    t.mock.method(console, "log", () => {});
    const f = fixture(options);
    await assert.rejects(
      assertProtocolDraftBlocksReload(f.page, "#draft", "draft"),
    );
    assert(f.clean());
  });
