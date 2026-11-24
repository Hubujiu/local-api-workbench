import { highlightJSON } from "./code-format.js";

const MAX_VISIBLE_SOURCE = 65536;
const MAX_VISIBLE_LINES = 2048;

export function modelRawDecoration(source) {
  if (source.length > MAX_VISIBLE_SOURCE) return null;
  const lines = source.split("\n");
  if (lines.length > MAX_VISIBLE_LINES) return null;
  return {
    gutter: lines.map((_, index) => index + 1).join("\n"),
    ink: highlightJSON(source) + "\n",
  };
}

export function modelRawEditorMarkup() {
  return `<div class="model-workspace-raw">
    <div class="model-raw-gutter" aria-hidden="true"><pre data-model-raw-lines></pre></div>
    <div class="model-raw-code">
      <pre class="model-raw-ink" data-model-raw-ink aria-hidden="true"></pre>
      <textarea id="model-workspace-json" aria-label="模型 Schema JSON" spellcheck="false" wrap="off" autofocus></textarea>
    </div>
  </div>`;
}

export function bindModelRawEditor(shell, source) {
  const input = shell.querySelector("#model-workspace-json");
  const gutter = shell.querySelector("[data-model-raw-lines]");
  const ink = shell.querySelector("[data-model-raw-ink]");
  let composing = false;
  let queued = false;
  const highContrast = matchMedia("(forced-colors: active)");
  const syncScroll = () => {
    shell.style.setProperty("--model-raw-offset-x", `${-input.scrollLeft}px`);
    shell.style.setProperty("--model-raw-offset-y", `${-input.scrollTop}px`);
  };
  const repaint = () => {
    const overlay = highContrast.matches
      ? null
      : modelRawDecoration(input.value);
    shell.classList.toggle("model-raw-with-gutter", Boolean(overlay));
    shell.classList.toggle(
      "model-raw-with-ink",
      Boolean(overlay) && !composing,
    );
    gutter.textContent = overlay?.gutter || "";
    ink.innerHTML = overlay?.ink || "";
    syncScroll();
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (shell.isConnected) repaint();
    });
  };

  input.value = source;
  input.setSelectionRange(0, 0);
  input.addEventListener("scroll", syncScroll);
  input.addEventListener("input", schedule);
  input.addEventListener("compositionstart", () => {
    composing = true;
    shell.classList.remove("model-raw-with-ink");
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    schedule();
  });
  // Track the preference only for this invocation of the reusable dialog.
  const dialog = shell.closest("dialog");
  const lifecycle = new AbortController();
  const signal = lifecycle.signal;
  highContrast.addEventListener("change", schedule, { signal });
  dialog.addEventListener(
    "close",
    () => {
      if (!dialog.open || !shell.isConnected) lifecycle.abort();
    },
    { signal },
  );
  repaint();
}
