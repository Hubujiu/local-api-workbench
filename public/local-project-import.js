import { icon } from "./icons.js";

const modes = [
  {
    value: "interfaces",
    title: "本地定义文件",
    hint: "自动识别",
    glyph: "☷",
    target: "导入当前项目",
    fileLabel: "选择本地文件",
    help: "支持 Swagger / OpenAPI JSON 或 YAML、Postman Collection、cURL、本地项目 JSON 及部分 Apipost JSON。现代 Apipost JSON 还会导入支持的环境、服务及全局变量；未知资源会拒绝。",
  },
  {
    value: "restore",
    title: "Workbench 备份",
    hint: "项目 JSON",
    glyph: "▧",
    target: "恢复为新的项目副本",
    fileLabel: "选择备份 JSON",
    help: "仅接受 Workbench 完整项目备份；不会覆盖当前项目。备份可能包含环境、历史与凭据，请仅在本机使用。",
  },
  {
    value: "apipost-directory",
    title: "Apipost 原版目录",
    hint: "实验性 JSON 子集",
    glyph: "⑂",
    target: "导入当前项目（原版目录子集）",
    help: "仅选择含 project.json 的已知目录；未知文件会拒绝。不代表完整迁移。",
  },
];

const label = (glyph) =>
  `<span class="local-import-icon" aria-hidden="true">${icon(glyph)}</span>`;
const upload =
  '<span class="local-import-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4m-4 4 4-4 4 4M5 15v5h14v-5"/></svg></span>';

export function localProjectImportMarkup() {
  const first = modes[0];
  return `<section class="local-project-import">
    <fieldset class="local-import-source">
      <legend>数据来源</legend>
      <div class="local-import-cards">
        ${modes.map((mode) => `<label class="local-import-mode-card">${label(mode.glyph)}<span><strong>${mode.title}</strong><small>${mode.hint}</small></span><input name="local-import-source" type="radio" value="${mode.value}" ${mode === first ? "checked" : ""}></label>`).join("")}
      </div>
      <select id="import-mode" aria-hidden="true" tabindex="-1">${modes.map((mode) => `<option value="${mode.value}">${mode.title}</option>`).join("")}</select>
    </fieldset>
    <div class="local-import-target"><span>导入位置</span><strong id="local-import-destination" role="status">${first.target}</strong></div>
    <p id="local-import-mode-help" class="muted">${first.help}</p>
    <div data-local-import-panel="file">
      <label class="local-import-chooser" for="import-file">${upload}<strong id="local-import-file-label">${first.fileLabel}</strong><small id="local-import-file-name">未选择文件</small><input id="import-file" type="file" accept=".json,.yaml,.yml,.txt" aria-labelledby="local-import-file-label" aria-describedby="local-import-file-name local-import-mode-help"></label>
      <div class="local-import-review-tools" hidden><button id="local-import-preview-file" type="button">预览 Swagger / OpenAPI</button><p id="local-import-preview-status" role="status"></p></div>
      <div class="local-import-paste"><label for="import-text" id="local-import-paste-label">或粘贴 JSON、YAML 或 cURL</label><textarea id="import-text" placeholder="粘贴 JSON、YAML 或 cURL" spellcheck="false"></textarea><small class="muted">同时选择文件和粘贴时，使用所选文件。</small></div>
    </div>
    <div data-local-import-panel="directory" hidden>
      <label class="local-import-chooser" for="import-directory">${label("▧")}<strong id="local-import-directory-label">选择本地项目目录</strong><small id="local-import-directory-name">未选择目录</small><input id="import-directory" type="file" webkitdirectory multiple aria-labelledby="local-import-directory-label" aria-describedby="local-import-directory-name local-import-mode-help"></label>
    </div>
    <small class="local-import-safety muted">仅从本机选择或粘贴内容，不发送其中的请求。</small>
  </section>`;
}

export function bindLocalProjectImport(root) {
  const pick = (selector) => root.querySelector(selector);
  const mode = pick("#import-mode");
  const radios = root.querySelectorAll('[name="local-import-source"]');
  const file = pick("#import-file");
  const directory = pick("#import-directory");
  const paste = pick("#import-text");
  const review = pick(".local-import-review-tools");
  const status = pick("#local-import-preview-status");
  const syncReview = () => {
    review.hidden = mode.value !== "interfaces" || !file.files.length;
    status.textContent = "";
  };
  const sync = () => {
    const config = modes.find((item) => item.value === mode.value);
    if (!config) return;
    const useDirectory = mode.value === "apipost-directory";
    const restore = mode.value === "restore";
    for (const radio of radios) radio.checked = radio.value === mode.value;
    pick('[data-local-import-panel="file"]').hidden = useDirectory;
    pick('[data-local-import-panel="directory"]').hidden = !useDirectory;
    pick("#local-import-destination").textContent = config.target;
    pick("#local-import-mode-help").textContent = config.help;
    const fileLabel = config.fileLabel || modes[0].fileLabel;
    pick("#local-import-file-label").textContent = fileLabel;
    file.accept = restore ? ".json" : ".json,.yaml,.yml,.txt";
    paste.placeholder = restore ? "粘贴备份 JSON" : "粘贴 JSON、YAML 或 cURL";
    pick("#local-import-paste-label").textContent = "或" + paste.placeholder;
    syncReview();
  };
  for (const radio of radios)
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      mode.value = radio.value;
      sync();
    });
  mode.addEventListener("change", sync);
  file.addEventListener("change", () => {
    pick("#local-import-file-name").textContent =
      file.files[0]?.name || "未选择文件";
    syncReview();
  });
  directory.addEventListener("change", () => {
    pick("#local-import-directory-name").textContent = directory.files.length
      ? "已选择 " + directory.files.length + " 个文件"
      : "未选择目录";
  });
  sync();
}
