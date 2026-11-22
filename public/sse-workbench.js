import { sseCaptureView } from "./sse-capture-owner.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export function selectedSSEWorkbench(
  item,
  { busy, session, status, events, capture },
) {
  if (item?.type !== "sse") return "";
  const captureView = sseCaptureView(capture);
  return `<section class="selected-sse-workbench" aria-label="SSE 调试">
    <header class="sse-workbench-tab"><strong>SSE</strong><span>${esc(item.name)}</span></header>
    <section class="sse-workbench-setup" aria-label="连接配置">
      <div class="sse-workbench-name"><h1>实时协议调试</h1><input id="protocol-name" aria-label="连接名称" placeholder="连接名称" value="${esc(item.name)}"></div>
      <div class="sse-workbench-frame">
        <div class="sse-workbench-target">
          <select id="protocol-type" aria-label="协议"><option value="sse" selected>SSE</option><option value="websocket">WebSocket</option><option value="tcp">TCP</option></select>
          <input id="protocol-url" aria-label="连接地址" placeholder="http://localhost:8080/events" value="${esc(item.url)}">
        </div>
        <button id="protocol-run" class="primary" ${busy || captureView.blocksStart ? "disabled" : ""}>连接并采集</button>
        <button id="save-protocol">保存连接定义</button>
      </div>
      <div class="sse-workbench-options">
        <label class="sse-workbench-duration">采集时长（毫秒）<input id="protocol-duration" type="number" value="3000" min="100" max="30000"></label>
        <label class="sse-workbench-tcp">TCP 端口<input id="protocol-port" type="number" value="${item.port || 8080}"></label>
        <button id="cancel" ${captureView.canCancel ? "" : "disabled"}>断开采集</button>
        <button id="delete-protocol" class="danger">删除连接定义</button>
      </div>
      <p class="muted sse-workbench-limit"><span class="sse-workbench-get-note">手动 SSE 连接使用 GET，不发送正文。</span>短时采集和交互会话是独立操作。交互会话最长 15 分钟、8 MiB，保留最近 200 条消息。</p>
    </section>
    <section class="sse-workbench-evidence" aria-label="连接与事件证据">
      <div class="sse-workbench-evidence-heading"><h2>当前全局会话</h2><span id="session-status">${esc(status)}</span></div>
      <div class="sse-workbench-session-actions">
        <button id="session-connect" class="primary" ${session.canConnect ? "" : "disabled"}>建立交互会话</button>
        <button id="session-stop" ${session.canStop ? "" : "disabled"}>断开会话</button>
        <button id="session-refresh">核对会话</button>
        <button id="session-export">导出消息</button>
      </div>
      <section class="sse-workbench-result" aria-label="单次采集结果"><h3>单次采集结果</h3><p id="sse-capture-status" role="status">${esc(captureView.notice)}</p><button id="sse-capture-check" ${captureView.needsCheck ? "" : "hidden"} ${captureView.canCheck ? "" : "disabled"}>只读核对采集记录</button> <button id="sse-capture-abandon" ${captureView.needsCheck ? "" : "hidden"} ${captureView.canCheck ? "" : "disabled"}>结束本次核对</button><pre id="protocol-result">${esc(captureView.result)}</pre></section>
      <section class="sse-workbench-events" aria-label="会话事件"><pre id="session-events">${esc(events)}</pre><p class="sse-workbench-empty muted">尚无会话事件</p></section>
      <div class="sse-workbench-message">
        <label>发送消息（仅适用可发送的会话）<textarea id="protocol-message"></textarea></label>
        <button id="session-send" ${session.canSend ? "" : "disabled"}>发送消息</button>
      </div>
    </section>
  </section>`;
}
