import { icon } from "./icons.js";

export function checkedProductVersion(value) {
  return typeof value === "string" &&
    /^(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})$/.test(value)
    ? value
    : "";
}

export function productBuild(runtime, installed) {
  const desktop = checkedProductVersion(installed);
  return {
    version: desktop || checkedProductVersion(runtime),
    label: desktop ? "桌面应用版本" : "本地服务版本",
  };
}

export function productVersionMarkup() {
  return `<div class="appearance-content appearance-version-content" id="appearance-version-panel" role="tabpanel" aria-labelledby="appearance-version-tab" hidden>
    <h3>版本信息</h3>
    <section class="appearance-version-identity" aria-label="Local API 版本">
      <span class="appearance-version-badge" aria-hidden="true">${icon("↗")}</span>
      <p class="appearance-version-name">Local API 单机版</p>
      <p id="appearance-version-text"></p>
    </section>
  </div>`;
}

export function updateProductVersion(root, build) {
  const footer = root?.querySelector("#product-version-footer");
  if (footer)
    footer.textContent = build.version
      ? "Local API " + build.version
      : "Local API";
  const label = root?.querySelector("#appearance-version-text");
  if (label)
    label.textContent = build.label + "：" + (build.version || "未获取");
}
