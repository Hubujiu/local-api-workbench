export const afterSendResponseKey = "after-send-open-response";

export const readAfterSendResponse = (storage) =>
  storage.getItem(afterSendResponseKey) === "on";

export function saveAfterSendResponse(storage, enabled) {
  if (enabled) storage.setItem(afterSendResponseKey, "on");
  else storage.removeItem(afterSendResponseKey);
}

export function afterSendSettingsMarkup() {
  return `<div class="appearance-content after-send-settings" id="after-send-settings-panel" role="tabpanel" aria-labelledby="after-send-settings-tab" hidden>
    <h3>发送后设置</h3>
    <div class="after-send-setting-row">
      <div><label for="after-send-open-response">发送后切换到实时响应</label>
      <p id="after-send-setting-help">仅用于手动 HTTP 调试。等待期间手动切换标签或离开当前请求时，不自动切换。</p></div>
      <input type="checkbox" role="switch" id="after-send-open-response" aria-describedby="after-send-setting-help">
    </div>
  </div>`;
}

export function createManualResponseView() {
  let owner,
    requestId,
    view = 0,
    choice = 0;
  return {
    observe(nextOwner, nextRequestId) {
      if (owner !== nextOwner || requestId !== nextRequestId) view++;
      owner = nextOwner;
      requestId = nextRequestId;
    },
    selected() {
      choice++;
    },
    capture(enabled, expectedOwner, expectedRequestId) {
      if (
        !enabled ||
        !owner ||
        owner !== expectedOwner ||
        requestId !== expectedRequestId
      )
        return null;
      return { view, choice };
    },
    shouldReveal(ticket, enabled, result) {
      return Boolean(
        ticket &&
          enabled &&
          ticket.view === view &&
          ticket.choice === choice &&
          Number.isInteger(result?.status) &&
          result.status >= 100 &&
          result.status <= 599,
      );
    },
  };
}
