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
  { opener, findOpener, read, apply },
) {
  if (dialog.open) return;
  dialog.innerHTML = `
    <div class="appearance-layout">
      <aside class="appearance-sidebar">
        <h2 id="appearance-settings-heading">应用设置</h2>
        <p class="appearance-active">${icon("appearance")}外观</p>
        <button id="appearance-reset" type="button" class="ghost">恢复默认外观</button>
      </aside>
      <div class="appearance-content">
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
      </div>
      <button id="appearance-close" type="button" class="ghost" aria-label="关闭外观设置" autofocus>×</button>
    </div>`;

  const reset = dialog.querySelector("#appearance-reset");
  const choices = [
    ...dialog.querySelectorAll('input[name="appearance-theme"]'),
  ];
  const sync = () => {
    const current = read();
    for (const choice of choices) choice.checked = choice.value === current;
    reset.disabled = current === "light";
  };
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
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
      sync();
      choices[0].focus({ preventScroll: true });
    },
    options,
  );
  dialog.addEventListener("cancel", close, options);
  dialog
    .querySelector("#appearance-close")
    .addEventListener("click", close, options);
  sync();
  dialog.showModal();
}
