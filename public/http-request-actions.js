const curlAction =
  '<button id="curl" type="button" title="生成 cURL" aria-label="生成 cURL">⌘</button>';

export function requestCurlAction(debug) {
  return debug ? curlAction : "";
}

export function httpRequestActions({ debug, busy, cancel, dirty }) {
  const send = `<button id="send" type="button" class="primary" ${busy ? "disabled" : ""}>${busy ? "请求中…" : "发 送"}</button><details class="button-menu"><summary aria-label="发送更多操作">▾</summary><div><button id="send-menu-curl" type="button">生成 cURL</button><button id="send-menu-plan" type="button">创建执行计划</button></div></details>`;
  const save = `<button id="save" type="button" class="${dirty ? "primary" : ""}">保存</button><details class="button-menu"><summary aria-label="保存更多操作">▾</summary><div><button id="save-menu-copy" type="button">创建接口副本</button><button id="save-menu-project" type="button">保存整个项目</button></div></details>`;
  const cancelButton = cancel
    ? '<button id="cancel" type="button">取消</button>'
    : "";
  return debug
    ? `<div class="http-action-split" role="group" aria-label="发送请求">${send}</div>${cancelButton}<div class="http-action-split" role="group" aria-label="保存请求">${save}</div>`
    : send + cancelButton + save + curlAction;
}
