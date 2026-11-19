import { escapeCode, highlightJSON } from "./code-format.js";

export function responseBodyModel(body) {
  const raw =
    typeof body === "string" ? body : JSON.stringify(body ?? "", null, 2);
  try {
    return {
      raw,
      pretty: JSON.stringify(JSON.parse(raw), null, 4),
      json: true,
    };
  } catch {
    return { raw, pretty: raw, json: false };
  }
}

function bodyCode(model, raw = false) {
  const text = raw ? model.raw : model.pretty;
  return `<div class="http-response-code" tabindex="0" role="region" aria-label="响应正文"><div class="http-response-gutter" aria-hidden="true">${text
    .split("\n")
    .map((_, index) => index + 1)
    .join(
      "\n",
    )}</div><pre id="http-response-text">${model.json && !raw ? highlightJSON(text) : escapeCode(text)}</pre></div>`;
}

export function responseBodyView(body) {
  const model = responseBodyModel(body);
  return `<section class="http-response-view"><div class="http-response-toolbar" role="group" aria-label="响应显示格式"><button type="button" data-response-format="pretty" aria-pressed="true">美化</button><button type="button" data-response-format="raw" aria-pressed="false">原生</button><span class="http-response-format">${model.json ? "JSON" : "Text"}</span><span class="subtle">只读 · 网络响应</span></div>${bodyCode(model)}</section>`;
}

export function bindResponseBody(root, body) {
  const model = responseBodyModel(body);
  if (!model.json) {
    const text = root.querySelector("#http-response-text");
    if (text) text.textContent = model.pretty;
  }
  for (const button of root.querySelectorAll("[data-response-format]")) {
    button.onclick = () => {
      const view = button.closest(".http-response-view");
      view.querySelector(".http-response-code").outerHTML = bodyCode(
        model,
        button.dataset.responseFormat === "raw",
      );
      if (button.dataset.responseFormat === "raw" || !model.json)
        view.querySelector("#http-response-text").textContent = model.raw;
      for (const option of view.querySelectorAll("[data-response-format]"))
        option.setAttribute("aria-pressed", String(option === button));
    };
  }
}
