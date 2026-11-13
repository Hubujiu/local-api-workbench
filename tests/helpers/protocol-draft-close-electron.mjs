import assert from "node:assert/strict";

// Runs in Electron's main process. Only the native dialog response is replaced;
// BrowserWindow.close and the renderer's beforeunload gate are real. This is NOT
// an OS dialog interaction test. Never use this adapter in production code.
export async function cancelProtocolWindowClose({ BrowserWindow, dialog }) {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length !== 1) throw Error("expected exactly one desktop window");
  const win = windows[0];
  const original = dialog.showMessageBoxSync;
  const calls = [];
  let blocked = 0,
    closed = 0;
  const onBlocked = () => blocked++;
  const onClosed = () => closed++;
  win.webContents.on("will-prevent-unload", onBlocked);
  win.on("closed", onClosed);
  dialog.showMessageBoxSync = (parent, options) => {
    calls.push({ sameParent: parent === win, ...options });
    return 0;
  };
  let timer, settled;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error("close did not reach unload gate")),
        10000,
      );
      settled = () => {
        clearTimeout(timer);
        setImmediate(resolve);
      };
      win.webContents.once("will-prevent-unload", settled);
      win.close();
    });
    return {
      calls,
      blocked,
      closed,
      alive: !win.isDestroyed(),
      sameWindow: BrowserWindow.getAllWindows()[0] === win,
    };
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed() && settled)
      win.webContents.removeListener("will-prevent-unload", settled);
    dialog.showMessageBoxSync = original;
    if (!win.isDestroyed())
      win.webContents.removeListener("will-prevent-unload", onBlocked);
    win.removeListener("closed", onClosed);
  }
}

export function assertProtocolCloseReceipt(receipt) {
  assert.deepEqual(receipt, {
    calls: [
      {
        sameParent: true,
        type: "question",
        title: "未保存的修改",
        message: "当前有未保存的修改，是否放弃并退出？",
        buttons: ["留在应用", "放弃并退出"],
        defaultId: 0,
        cancelId: 0,
      },
    ],
    blocked: 1,
    closed: 0,
    alive: true,
    sameWindow: true,
  });
}

export async function exerciseProtocolDraftClose(application, page) {
  for (const protocol of ["grpc", "socketio"]) {
    await page.locator(`.rail [data-page="${protocol}"]`).click();
    const input = page.locator(`#${protocol}-name`);
    const original = await input.inputValue();
    const value = `Unsaved desktop ${protocol}`;
    await input.fill(value);
    const document = await page.evaluateHandle(() => window.document);
    let navigations = 0;
    const mutations = [];
    const observeRequest = (request) => {
      if (!["GET", "HEAD"].includes(request.method()))
        mutations.push(request.method());
    };
    page.on("request", observeRequest);
    const observe = (frame) => {
      if (frame === page.mainFrame()) navigations++;
    };
    page.on("framenavigated", observe);
    try {
      assertProtocolCloseReceipt(
        await application.evaluate(cancelProtocolWindowClose),
      );
      assert.equal(
        await document.evaluate((previous) => previous === window.document),
        true,
      );
      assert.equal(await input.inputValue(), value);
      assert.deepEqual(
        mutations,
        [],
        "cancel close must not submit or replay operations",
      );
      assert.equal(page.isClosed(), false);
      assert.equal(navigations, 0);
      console.log(
        "PROTOCOL_DRAFT_ELECTRON_CLOSE_CANCEL_PASS",
        protocol,
        "dialog-response-adapter",
      );
    } finally {
      page.off("framenavigated", observe);
      page.off("request", observeRequest);
      await document.dispose();
    }
    // Restore via the real edit callback, not by changing application state.
    await input.fill(original);
  }
}
