import { icon } from "./icons.js";

const markup = `<header class="curl-preview-header">
  <button type="button" class="ghost curl-preview-close" aria-label="关闭">×</button>
  <h2 id="curl-preview-title">生成代码</h2>
  <button type="button" class="curl-preview-copy" disabled>${icon("copy-request")}<span>复制代码</span></button>
</header>
<div class="curl-preview-body">
  <aside class="curl-preview-rail" aria-label="代码生成器"><div aria-current="true">shell(curl)</div></aside>
  <section class="curl-preview-main" aria-label="代码预览">
    <div class="curl-preview-state" role="status">
      <span class="curl-preview-spinner" aria-hidden="true"></span>
      <span class="curl-preview-message">生成中...</span>
    </div>
    <div class="curl-preview-editor" hidden>
      <pre class="curl-preview-gutter" aria-hidden="true"></pre>
      <textarea id="curl-output" aria-label="生成的 cURL 代码" aria-describedby="curl-preview-notice" readonly spellcheck="false" wrap="off"></textarea>
    </div>
  </section>
</div>
<div class="curl-preview-notice">
  <p id="curl-preview-notice">按当前环境生成，不执行前后置脚本。可能包含认证凭据，请勿公开分享。HTTP/2 命令需要支持 HTTP/2 的 cURL；HTTPS 严格 HTTP/2 需 cURL 8.10 或更新版。</p>
  <p class="curl-preview-copy-error" role="alert" hidden></p>
</div>`;

export function createCurlPreview() {
  let active;
  const dismiss = (restoreFocus = false) => {
    if (!active) return;
    const entry = active;
    active = undefined;
    entry.listeners.abort();
    if (entry.dialog.open) entry.dialog.close();
    entry.dialog.replaceChildren();
    if (restoreFocus && entry.opener.isConnected)
      entry.opener.focus({ preventScroll: true });
  };

  function open(dialog, opener, owns, copy) {
    if (!dialog || active || dialog.open || !owns()) return;
    const entry = { dialog, opener, listeners: new AbortController() };
    active = entry;
    const options = { signal: entry.listeners.signal };
    const select = (selector) => dialog.querySelector(selector);
    dialog.innerHTML = markup;
    const close = select(".curl-preview-close"),
      copyButton = select(".curl-preview-copy"),
      state = select(".curl-preview-state"),
      message = select(".curl-preview-message"),
      spinner = select(".curl-preview-spinner"),
      editor = select(".curl-preview-editor"),
      gutter = select(".curl-preview-gutter"),
      output = select("#curl-output"),
      copyError = select(".curl-preview-copy-error");
    const ready = () => {
      if (active !== entry || !dialog.open) return false;
      if (owns()) return true;
      dismiss(false);
      return false;
    };
    close.addEventListener("click", () => dismiss(true), options);
    dialog.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        dismiss(true);
      },
      options,
    );
    dialog.addEventListener(
      "close",
      () => {
        if (active === entry && !dialog.open) dismiss(false);
      },
      options,
    );
    dialog.showModal();
    close.focus();
    let value, lineCount;
    const paintGutter = () => {
      if (lineCount === undefined) return;
      const style = getComputedStyle(output);
      const height = parseFloat(style.lineHeight);
      if (!Number.isFinite(height) || height <= 0) return;
      const first = Math.floor(output.scrollTop / height);
      const count = Math.min(
        lineCount - first,
        Math.ceil(output.clientHeight / height) + 2,
      );
      gutter.textContent = Array.from(
        { length: Math.max(0, count) },
        (_, i) => first + i + 1,
      ).join("\n");
      gutter.scrollTop = output.scrollTop % height;
    };
    output.addEventListener("scroll", paintGutter, options);
    window.addEventListener("resize", paintGutter, options);
    copyButton.addEventListener(
      "click",
      async () => {
        if (!ready() || typeof value !== "string" || copyButton.disabled)
          return;
        copyButton.disabled = true;
        copyError.hidden = true;
        try {
          await copy(value);
          if (ready()) dismiss(true);
        } catch (error) {
          if (ready()) {
            copyError.textContent = error.message;
            copyError.hidden = false;
          }
        } finally {
          if (ready()) copyButton.disabled = false;
        }
      },
      options,
    );
    return {
      deliver(command) {
        if (!ready()) return;
        if (typeof command !== "string") {
          this.fail(Error("未收到生成的 cURL 代码"));
          return;
        }
        value = command;
        output.value = command;
        lineCount = 1;
        for (
          let offset = command.indexOf("\n");
          offset >= 0;
          offset = command.indexOf("\n", offset + 1)
        )
          lineCount++;
        state.hidden = true;
        editor.hidden = false;
        copyButton.disabled = false;
        paintGutter();
      },
      fail(error) {
        if (!ready()) return;
        spinner.hidden = true;
        message.textContent = error.message;
        state.setAttribute("role", "alert");
      },
    };
  }

  return { open, dismiss };
}
