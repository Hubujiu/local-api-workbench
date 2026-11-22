const targetReadTimeoutMs = 15_000;

export function confirmDirtyProjectSwitch(dialog, { run, restoreFocus }) {
  if (dialog.open) return;
  dialog.innerHTML = `<div class="project-switch-warning" aria-hidden="true">!</div>
    <div class="project-switch-message">
      <h2 id="project-switch-confirm-title">切换项目</h2>
      <p id="project-switch-confirm-detail">当前修改尚未保存。要保存后再切换项目吗？</p>
      <p id="project-switch-confirm-progress" role="status"></p>
    </div>
    <div class="project-switch-confirm-actions">
      <button type="button" data-project-switch-choice="cancel" autofocus>取消</button>
      <button type="button" data-project-switch-choice="discard">不保存</button>
      <button type="button" class="primary" data-project-switch-choice="save">保存并继续</button>
    </div>`;
  const cancel = dialog.querySelector('[data-project-switch-choice="cancel"]');
  const actions = [...dialog.querySelectorAll("[data-project-switch-choice]")];
  const progress = dialog.querySelector("#project-switch-confirm-progress");
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let pending = false,
    target;
  const close = (switched) => {
    controller.abort();
    target?.abort();
    dialog.close();
    restoreFocus(switched);
  };
  const canCancel = () => !pending || Boolean(target);
  const readTarget = async (read, saved) => {
    const attempt = new AbortController();
    target = attempt;
    cancel.disabled = false;
    cancel.focus({ preventScroll: true });
    progress.textContent = saved
      ? "原项目已保存，正在打开目标项目…"
      : "正在打开目标项目…";
    const timeout = Error("读取目标项目超时，未切换项目。");
    const interrupted = new Promise((_, reject) => {
      attempt.signal.addEventListener(
        "abort",
        () => reject(attempt.signal.reason),
        {
          once: true,
        },
      );
    });
    const timer = setTimeout(() => attempt.abort(timeout), targetReadTimeoutMs);
    try {
      return await Promise.race([read(attempt.signal), interrupted]);
    } finally {
      clearTimeout(timer);
      target = undefined;
    }
  };
  dialog.addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      if (canCancel()) close(false);
    },
    options,
  );
  dialog.addEventListener(
    "click",
    async (event) => {
      const decision = event.target.closest("[data-project-switch-choice]")
        ?.dataset.projectSwitchChoice;
      if (decision === "cancel") {
        if (canCancel()) close(false);
        return;
      }
      if (!decision || pending) return;
      pending = true;
      for (const action of actions) action.disabled = true;
      progress.textContent =
        decision === "save" ? "正在保存并核对原项目…" : "正在核对当前草稿…";
      try {
        const switched = await run(decision, (read) =>
          readTarget(read, decision === "save"),
        );
        if (controller.signal.aborted) return;
        if (!switched) throw Error("未切换项目，请回到工作区核对");
        close(true);
      } catch (error) {
        if (controller.signal.aborted) return;
        progress.textContent = error.message;
        // After an uncertain/stale transition, never reuse the same decision.
        cancel.disabled = false;
        cancel.focus({ preventScroll: true });
      } finally {
        pending = false;
      }
    },
    options,
  );
  dialog.showModal();
  cancel.focus({ preventScroll: true });
}
