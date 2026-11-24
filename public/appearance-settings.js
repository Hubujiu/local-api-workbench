import { bindSendSettings, sendSettingsMarkup } from "./send-settings.js";
import {
  afterSendSettingsMarkup,
  readAfterSendResponse,
  saveAfterSendResponse,
} from "./after-send-settings.js";
import {
  productBuild,
  productVersionMarkup,
  updateProductVersion,
} from "./product-version.js";
import {
  appearanceFontScaleHTML,
  baseFontScale,
  bindAppearanceFontScale,
} from "./appearance-font-scale.js";
import { icon } from "./icons.js";

export const appearanceTheme = (value) => (value === "dark" ? "dark" : "light");
export const activeAppearanceTheme = (body) =>
  body.classList.contains("dark") ? "dark" : "light";

export function applyAppearanceTheme(body, storage, theme) {
  const next = appearanceTheme(theme);
  storage.setItem("theme", next);
  body.classList.toggle("dark", next === "dark");
}

export function openAppearanceSettings(
  dialog,
  {
    opener,
    findOpener,
    read,
    apply,
    readScale,
    applyScale,
    readBuild,
    storage,
  },
) {
  if (dialog.open) return;
  dialog.innerHTML = `
    <div class="appearance-layout">
      <aside class="appearance-sidebar">
        <h2 id="appearance-settings-heading">应用设置</h2>
        <div role="tablist" aria-label="应用设置栏目" aria-orientation="vertical">
          <button type="button" class="appearance-tab" id="appearance-main-tab" role="tab" aria-controls="appearance-main-panel" aria-selected="true">${icon("appearance")}外观</button>
          <button type="button" class="appearance-tab" id="send-settings-tab" role="tab" aria-controls="send-settings-panel" aria-selected="false" tabindex="-1">${icon("↗")}发送设置</button>
          <button type="button" class="appearance-tab" id="after-send-settings-tab" role="tab" aria-controls="after-send-settings-panel" aria-selected="false" tabindex="-1">${icon("⇄")}发送后设置</button>
          <button type="button" class="appearance-tab" id="appearance-version-tab" role="tab" aria-controls="appearance-version-panel" aria-selected="false" tabindex="-1">${icon("☷")}版本信息</button>
        </div>
        <button id="send-timeout-reset" type="button" class="ghost" hidden>恢复默认超时</button>
        <button id="after-send-reset" type="button" class="ghost" hidden>恢复默认发送后设置</button>
        <button id="appearance-reset" type="button" class="ghost">恢复默认外观</button>
      </aside>
      <div class="appearance-content" id="appearance-main-panel" role="tabpanel" aria-labelledby="appearance-main-tab">
        <h3>外观</h3>
        <fieldset class="appearance-theme-field">
          <legend>背景</legend>
          <div class="appearance-options">
            ${[
              ["light", "浅色"],
              ["dark", "深色"],
            ]
              .map(
                ([theme, label]) =>
                  `<label class="appearance-option"><input type="radio" name="appearance-theme" value="${theme}" aria-label="${label}"><span class="appearance-preview appearance-preview--${theme}" aria-hidden="true"><span class="appearance-preview-ui"></span><span class="appearance-preview-check">✓</span></span></label>`,
              )
              .join("")}
          </div>
        </fieldset>
        ${appearanceFontScaleHTML()}
      </div>
      ${sendSettingsMarkup()}
      ${afterSendSettingsMarkup()}
      ${productVersionMarkup()}
      <button id="appearance-close" type="button" class="ghost" aria-label="关闭外观设置" autofocus>×</button>
    </div>`;

  const reset = dialog.querySelector("#appearance-reset");
  const resetAfterSend = dialog.querySelector("#after-send-reset");
  const openResponse = dialog.querySelector("#after-send-open-response");
  const syncAfterSend = () => {
    openResponse.checked = readAfterSendResponse(storage);
    resetAfterSend.disabled = !openResponse.checked;
  };
  const choices = [
    ...dialog.querySelectorAll('input[name="appearance-theme"]'),
  ];
  const sync = () => {
    const current = read();
    for (const choice of choices) choice.checked = choice.value === current;
    reset.disabled = current === "light" && readScale() === baseFontScale;
  };
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const tabs = [...dialog.querySelectorAll("[role=tab]")];
  const show = (selected) => {
    tabs.forEach((tab, index) => {
      const active = index === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      dialog.querySelector("#" + tab.getAttribute("aria-controls")).hidden =
        !active;
    });
    reset.hidden = selected !== 0;
    dialog.querySelector("#send-timeout-reset").hidden =
      tabs[selected].id !== "send-settings-tab";
    resetAfterSend.hidden = tabs[selected].id !== "after-send-settings-tab";
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => show(index), options);
    tab.addEventListener(
      "keydown",
      (event) => {
        if (
          ![
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
          ].includes(event.key)
        )
          return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (index +
                  tabs.length +
                  (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1)) %
                tabs.length;
        show(next);
        tabs[next].focus();
      },
      options,
    );
  });
  updateProductVersion(dialog, readBuild?.() || productBuild());
  bindSendSettings(dialog, storage, options);
  openResponse.addEventListener(
    "change",
    () => {
      if (!dialog.open) return;
      saveAfterSendResponse(storage, openResponse.checked);
      syncAfterSend();
    },
    options,
  );
  resetAfterSend.addEventListener(
    "click",
    () => {
      if (!dialog.open || resetAfterSend.disabled) return;
      saveAfterSendResponse(storage, false);
      syncAfterSend();
      openResponse.focus();
    },
    options,
  );
  syncAfterSend();

  const syncScale = bindAppearanceFontScale(dialog, {
    read: readScale,
    apply(scale) {
      applyScale(scale);
      sync();
    },
    options,
  });
  const close = (event) => {
    event.preventDefault();
    if (!dialog.open) return;
    listeners.abort();
    dialog.close();
    const target = opener.isConnected ? opener : findOpener();
    target?.focus({ preventScroll: true });
  };
  for (const choice of choices)
    choice.addEventListener(
      "change",
      () => {
        if (!dialog.open || !choice.checked) return;
        apply(choice.value);
        sync();
      },
      options,
    );
  reset.addEventListener(
    "click",
    () => {
      if (!dialog.open || reset.disabled) return;
      apply("light");
      if (readScale() !== baseFontScale) applyScale(baseFontScale);
      syncScale();
      sync();
      choices[0].focus({ preventScroll: true });
    },
    options,
  );
  dialog.addEventListener("cancel", close, options);
  dialog
    .querySelector("#appearance-close")
    .addEventListener("click", close, options);
  syncScale();
  sync();
  dialog.showModal();
}
