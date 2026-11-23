import { insertTextareaText } from "./textarea-edit-history.js";

const shared = [
  [
    "local-set",
    "设置当前请求变量",
    'pm.variables.set("exampleKey", "exampleValue");',
  ],
  [
    "local-get",
    "读取可用变量（优先当前请求）",
    '{ const exampleValue = pm.variables.get("exampleKey"); /* 在此使用值 */ }',
  ],
  [
    "environment-get",
    "读取环境变量",
    '{ const exampleValue = pm.environment.get("exampleKey"); /* 在此使用值 */ }',
  ],
];
const afterOnly = [
  [
    "status-ok",
    "断言响应状态码为 200",
    'pm.test("状态码为 200", () => pm.expect(pm.response.code).to.equal(200));',
  ],
];

export function httpScriptSnippets(stage) {
  if (stage !== "before" && stage !== "after") return [];
  return (stage === "after" ? shared.concat(afterOnly) : shared).map(
    ([id, label, code]) => ({ id, label, code }),
  );
}

export function scriptSnippetInsertion(source, selectionEnd, code) {
  const nextBreak = /\r?\n/u.exec(source.slice(selectionEnd));
  const lineEnd = nextBreak ? selectionEnd + nextBreak.index : source.length;
  const newline = nextBreak?.[0] ?? /\r?\n/u.exec(source)?.[0] ?? "\n";
  return {
    start: lineEnd,
    end: lineEnd,
    replacement: source.length ? newline + code : code,
  };
}

const snippetsLabel = "常用脚本";

export function httpScriptSnippetWorkspaceHTML(editor, stage, folded) {
  return `<div class="http-script-workspace" data-http-script-stage="${stage}" data-snippets-folded="${folded}">
    ${editor}
    <aside class="http-script-snippets" aria-label="常用脚本">
      <button type="button" class="ghost http-script-snippets-toggle" aria-label="${snippetsLabel}" aria-expanded="${!folded}" aria-controls="http-script-snippet-options">
        <span class="http-script-snippets-label" aria-hidden="true">${snippetsLabel}</span>
        <span class="http-script-snippets-stacked-label" aria-hidden="true">${[...snippetsLabel].map((character) => `<span>${character}</span>`).join("")}</span>
        <span class="http-script-snippets-chevron" aria-hidden="true">›</span>
      </button>
      <div id="http-script-snippet-options" ${folded ? "hidden" : ""}>
        ${httpScriptSnippets(stage)
          .map(
            ({ id, label }) =>
              `<button type="button" class="ghost" data-http-script-snippet="${id}">${label}</button>`,
          )
          .join("")}
        <p>在当前行后插入，不运行或保存。</p>
      </div>
    </aside>
  </div>`;
}

export function bindHTTPScriptSnippets(panel, { owns, toggle, onError }) {
  const input = panel.querySelector("#script-code");
  const switcher = panel.querySelector(".http-script-snippets-toggle");
  const options = panel.querySelector("#http-script-snippet-options");
  const recipes = new Map(
    httpScriptSnippets(panel.dataset.httpScriptStage).map(({ id, code }) => [
      id,
      code,
    ]),
  );
  switcher.addEventListener("click", () => {
    if (!owns()) return;
    const folded = !options.hidden;
    options.hidden = folded;
    panel.dataset.snippetsFolded = String(folded);
    switcher.setAttribute("aria-expanded", String(!folded));
    toggle(folded);
  });
  for (const button of options.querySelectorAll("[data-http-script-snippet]"))
    button.addEventListener("click", () => {
      if (!owns() || options.hidden || !input.isConnected) return;
      const code = recipes.get(button.dataset.httpScriptSnippet);
      if (
        code &&
        !insertTextareaText(
          input,
          scriptSnippetInsertion(input.value, input.selectionEnd, code),
        )
      )
        onError("此编辑器无法自动插入脚本，请保留草稿后重试");
    });
}
