import { highlightJSON } from "./code-format.js";

const parseLimit = 256 * 1024;
const renderLimit = 512 * 1024;
const tokenLimit = 16000;
const lineLimit = 4096;
const encoder = new TextEncoder();
const presentation = new WeakMap();

export function isPopulatedHTTPResponse(response) {
  return Boolean(
    response &&
      Number.isInteger(response.status) &&
      response.status >= 200 &&
      response.status < 300 &&
      !response.error &&
      response.codecError === undefined &&
      response.rawBodyBase64 === undefined &&
      typeof response.body === "string" &&
      response.body.length,
  );
}

// JSON.parse only admits syntax; the representation is built from original
// tokens, never from parsed values (duplicates, precision and escapes survive).
export function prettyResponseJSON(raw) {
  if (
    typeof raw !== "string" ||
    raw.length > parseLimit ||
    encoder.encode(raw).byteLength > parseLimit
  )
    return null;
  try {
    JSON.parse(raw);
  } catch {
    return null;
  }
  const tokens = [];
  const scalar =
    /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;
  for (let at = 0; at < raw.length; ) {
    const ch = raw[at];
    if (" \t\r\n".includes(ch)) {
      at++;
      continue;
    }
    const start = at;
    if ("{}[]:,".includes(ch)) at++;
    else if (ch === '"') {
      at++;
      while (at < raw.length) {
        const next = raw[at++];
        if (next === "\\") at++;
        else if (next === '"') break;
      }
    } else {
      scalar.lastIndex = at;
      if (!scalar.test(raw)) return null;
      at = scalar.lastIndex;
    }
    tokens.push(raw.slice(start, at));
    if (tokens.length > tokenLimit) return null;
  }
  let depth = 0,
    size = 0,
    lines = 1;
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i],
      prev = tokens[i - 1],
      next = tokens[i + 1];
    let chunk = t,
      newline = false;
    if (t === "{" || t === "[") {
      if (++depth > 64) return null;
      if (next !== "}" && next !== "]") {
        chunk += "\n" + " ".repeat(depth * 4);
        newline = true;
      }
    } else if (t === "}" || t === "]") {
      depth--;
      if (prev !== "{" && prev !== "[") {
        chunk = "\n" + " ".repeat(depth * 4) + t;
        newline = true;
      }
    } else if (t === ",") {
      chunk += "\n" + " ".repeat(depth * 4);
      newline = true;
    } else if (t === ":") chunk += " ";
    size += chunk.length;
    if (newline) lines++;
    if (size > renderLimit || lines > lineLimit) return null;
    parts.push(chunk);
  }
  return parts.join("");
}

export function httpSuccessResponseHTML() {
  return `<section class="http-success-response" aria-label="实时响应正文">
  <div class="http-success-response-toolbar" role="group" aria-label="响应显示格式">
    <button type="button" data-http-success-format="pretty" aria-pressed="false">美化</button>
    <button type="button" data-http-success-format="raw" aria-pressed="false">原生</button>
    <span class="http-success-response-format" data-http-success-format-label></span><span class="subtle">只读 · 网络响应</span>
  </div>
  <div class="http-success-response-code" tabindex="0" role="region" aria-label="响应正文"><div class="http-success-response-gutter" aria-hidden="true"></div><pre id="http-response-text"></pre></div></section>`;
}

function lineNumbers(source) {
  let count = 1;
  const breaks = /\r\n?|\n/g;
  while (breaks.test(source)) {
    if (++count > lineLimit) return null;
  }
  return Array.from({ length: count }, (_, i) => i + 1).join("\n");
}

export function bindHTTPSuccessResponse(root, response, owns) {
  if (!root || !isPopulatedHTTPResponse(response)) return;
  let state = presentation.get(response);
  if (!state || state.raw !== response.body) {
    const pretty = prettyResponseJSON(response.body);
    state = {
      raw: response.body,
      pretty,
      view: pretty === null ? "raw" : "pretty",
    };
    presentation.set(response, state);
  }
  const controls = [...root.querySelectorAll("[data-http-success-format]")];
  const label = root.querySelector("[data-http-success-format-label]");
  const gutter = root.querySelector(".http-success-response-gutter");
  const code = root.querySelector("#http-response-text");
  const draw = () => {
    const raw = state.view === "raw",
      contents = raw ? state.raw : state.pretty;
    controls.forEach((control) => {
      control.disabled =
        control.dataset.httpSuccessFormat === "pretty" && state.pretty === null;
      control.setAttribute(
        "aria-pressed",
        String(control.dataset.httpSuccessFormat === state.view),
      );
    });
    label.textContent = state.pretty === null ? "原始文本" : "JSON";
    // Use a text node for Raw to avoid HTML parsing and CR/LF/NUL normalization.
    if (raw) code.textContent = contents;
    else code.innerHTML = highlightJSON(contents);
    const numbers = lineNumbers(contents);
    gutter.hidden = numbers === null;
    gutter.textContent = numbers ?? "";
  };
  draw();
  for (const control of controls)
    control.addEventListener("click", () => {
      if (!root.isConnected || !owns() || control.disabled) return;
      state.view = control.dataset.httpSuccessFormat;
      draw();
    });
}
