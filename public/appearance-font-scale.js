export const baseFontScale = 100;
export const minFontScale = 80;
export const maxFontScale = 120;
export const fontScaleStep = 10;
export const fontScaleKey = "appearance-font-scale";

export function validatedFontScale(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const candidate = Number(raw);
  return candidate >= minFontScale &&
    candidate <= maxFontScale &&
    candidate % fontScaleStep === 0
    ? candidate
    : null;
}

export function readFontScale(storage) {
  return validatedFontScale(storage.getItem(fontScaleKey)) ?? baseFontScale;
}

export function applyFontScale(root, scale) {
  const next = validatedFontScale(scale) ?? baseFontScale;
  if (next === baseFontScale) delete root.dataset.appFontScale;
  else root.dataset.appFontScale = String(next);
}

export function appearanceFontScaleHTML() {
  return `<div class="appearance-font-scale-row"><label for="appearance-font-scale">字体缩放</label><div class="appearance-font-scale-control"><div class="appearance-font-scale-value"><input id="appearance-font-scale" type="number" min="${minFontScale}" max="${maxFontScale}" step="${fontScaleStep}" inputmode="numeric" aria-describedby="appearance-font-scale-error" required><span aria-hidden="true">%</span></div><div class="appearance-font-scale-arrows"><button type="button" data-font-scale-step="1" aria-label="增大字体"><span aria-hidden="true">⌃</span></button><button type="button" data-font-scale-step="-1" aria-label="减小字体"><span aria-hidden="true">⌄</span></button></div></div><p id="appearance-font-scale-error" role="status"></p></div>`;
}

export function bindAppearanceFontScale(dialog, { read, apply, options }) {
  const input = dialog.querySelector("#appearance-font-scale");
  const error = dialog.querySelector("#appearance-font-scale-error");
  const up = dialog.querySelector('[data-font-scale-step="1"]');
  const down = dialog.querySelector('[data-font-scale-step="-1"]');
  const clear = () => {
    input.removeAttribute("aria-invalid");
    error.textContent = "";
  };
  const sync = () => {
    const current = read();
    input.value = String(current);
    up.disabled = current >= maxFontScale;
    down.disabled = current <= minFontScale;
    clear();
  };
  const set = (next) => {
    if (next !== read()) apply(next);
    sync();
  };
  const commit = () => {
    const next = validatedFontScale(input.value);
    if (next === null) {
      input.setAttribute("aria-invalid", "true");
      error.textContent = "请输入 80–120 之间以 10 为步长的数值。";
      return;
    }
    set(next);
  };
  const step = (direction) => {
    const current = validatedFontScale(input.value) ?? read();
    set(
      Math.min(
        maxFontScale,
        Math.max(minFontScale, current + direction * fontScaleStep),
      ),
    );
  };
  input.addEventListener("input", clear, options);
  input.addEventListener("change", commit, options);
  input.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key === "Enter" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown"
      ) {
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        if (event.key === "Enter") commit();
        else step(event.key === "ArrowUp" ? 1 : -1);
      }
    },
    options,
  );
  up.addEventListener("click", () => step(1), options);
  down.addEventListener("click", () => step(-1), options);
  return sync;
}
