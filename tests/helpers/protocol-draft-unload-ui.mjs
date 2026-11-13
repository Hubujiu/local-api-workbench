import assert from "node:assert/strict";

// A genuine navigation exercises the browser's beforeunload gate. Do not fake
// the event: browsers require user activation and may suppress synthetic ones.
export async function assertProtocolDraftBlocksReload(page, selector, value) {
  await page.locator(selector).click();
  const originalDocument = await page.evaluateHandle(() => document);
  let committedNavigations = 0;
  const navigated = (frame) => {
    if (frame === page.mainFrame()) committedNavigations++;
  };
  page.on("framenavigated", navigated);
  const dialogs = [];
  let dismissed = false;
  let dismissal;
  let dismissalError;
  const dismiss = (dialog) => {
    dialogs.push(dialog.type());
    dismissal = dialog.dismiss().then(
      () => {
        dismissed = true;
      },
      (error) => {
        dismissalError = error;
      },
    );
  };
  page.on("dialog", dismiss);
  try {
    let failure;
    try {
      await page.reload({ timeout: 10000 });
    } catch (error) {
      failure = error;
    }
    await dismissal;
    assert.equal(dismissalError, undefined, "dialog dismissal must succeed");
    assert.deepEqual(
      dialogs,
      ["beforeunload"],
      "dirty definition must block actual reload",
    );
    assert(dismissed, "beforeunload dialog must be dismissed successfully");
    assert(failure, "dismissed navigation must abort, not reload");
    // Chromium may leave reload waiting for its load event after dismissing
    // beforeunload. A timeout alone is NOT cancellation evidence: require the
    // actual dialog, the original live Document, no navigation commit and the
    // unchanged editor value below.
    assert(
      /ERR_ABORTED|Navigation.*cancel|net::ERR_FAILED/i.test(failure.message) ||
        failure.name === "TimeoutError",
      `unexpected reload failure: ${failure.message}`,
    );
    assert.equal(committedNavigations, 0, "dismissed reload must not commit");
    assert.equal(
      await originalDocument.evaluate((original) => original === document),
      true,
      "dismissed reload must retain the original document",
    );
    assert.equal(await page.locator(selector).inputValue(), value);
    console.log("PROTOCOL_DRAFT_UNLOAD_BROWSER_PASS", selector);
  } finally {
    page.off("dialog", dismiss);
    page.off("framenavigated", navigated);
    await originalDocument.dispose();
  }
}
