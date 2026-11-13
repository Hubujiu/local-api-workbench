import assert from "node:assert/strict";

// A genuine navigation exercises the browser's beforeunload gate. Do not fake
// the event: browsers require user activation and may suppress synthetic ones.
export async function assertProtocolDraftBlocksReload(page, selector, value) {
  await page.locator(selector).click();
  const dialogs = [];
  const dismiss = async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.dismiss();
  };
  page.on("dialog", dismiss);
  try {
    let failure;
    try {
      await page.reload({ timeout: 10000 });
    } catch (error) {
      failure = error;
    }
    assert.deepEqual(
      dialogs,
      ["beforeunload"],
      "dirty definition must block actual reload",
    );
    assert(failure, "dismissed navigation must abort, not reload");
    assert.match(
      failure.message,
      /ERR_ABORTED|Navigation.*cancel|net::ERR_FAILED/i,
    );
    assert.equal(await page.locator(selector).inputValue(), value);
    console.log("PROTOCOL_DRAFT_UNLOAD_BROWSER_PASS", selector);
  } finally {
    page.off("dialog", dismiss);
  }
}
