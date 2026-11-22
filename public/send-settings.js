export const newHTTPTimeoutKey = "new-http-request-timeout-ms";
export const defaultNewHTTPTimeout = 15000;

export function validateNewHTTPTimeout(input) {
  const value = String(input ?? "").trim();
  if (!/^\d{1,5}$/.test(value)) return null;
  const number = Number(value);
  return number >= 100 && number <= 60000 ? number : null;
}

export const readNewHTTPTimeout = (storage) =>
  validateNewHTTPTimeout(storage.getItem(newHTTPTimeoutKey)) ??
  defaultNewHTTPTimeout;

export function saveNewHTTPTimeout(storage, input) {
  const timeout = validateNewHTTPTimeout(input);
  if (timeout === null) return false;
  if (timeout === defaultNewHTTPTimeout) storage.removeItem(newHTTPTimeoutKey);
  else storage.setItem(newHTTPTimeoutKey, String(timeout));
  return true;
}

export function sendSettingsMarkup() {
  return `<div class="appearance-content send-settings" id="send-settings-panel" role="tabpanel" aria-labelledby="send-settings-tab" hidden>
    <h3>发送设置</h3>
    <div class="send-settings-row">
      <div><label for="new-http-request-timeout">新建 HTTP 接口的默认超时</label><p id="send-timeout-help">只用于手动新建的空白接口，不修改现有或导入的接口。</p></div>
      <div class="send-timeout-control"><input type="number" id="new-http-request-timeout" min="100" max="60000" step="1" inputmode="numeric" aria-describedby="send-timeout-help send-timeout-error"><span>ms</span></div>
      <p id="send-timeout-error" role="status"></p>
    </div>
  </div>`;
}

export function bindSendSettings(dialog, storage, options) {
  const input = dialog.querySelector("#new-http-request-timeout");
  const error = dialog.querySelector("#send-timeout-error");
  const reset = dialog.querySelector("#send-timeout-reset");
  const clear = () => {
    input.removeAttribute("aria-invalid");
    error.textContent = "";
  };
  const sync = () => {
    input.value = String(readNewHTTPTimeout(storage));
    // Reset can also clear an unapplied invalid edit.
    reset.disabled = readNewHTTPTimeout(storage) === defaultNewHTTPTimeout;
    clear();
  };
  const commit = () => {
    if (!dialog.open) return;
    if (!saveNewHTTPTimeout(storage, input.value)) {
      input.setAttribute("aria-invalid", "true");
      error.textContent = "请输入 100–60000 之间的整数（毫秒）。";
      reset.disabled = false;
      return;
    }
    sync();
  };
  input.addEventListener("input", clear, options);
  input.addEventListener("change", commit, options);
  input.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      commit();
    },
    options,
  );
  reset.addEventListener(
    "click",
    () => {
      if (!dialog.open || reset.disabled) return;
      saveNewHTTPTimeout(storage, defaultNewHTTPTimeout);
      sync();
      input.focus();
    },
    options,
  );
  sync();
}
