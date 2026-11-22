export const projectCreateCheckpoint = "project-create-needs-review";

export function createProjectCreationFlow(storage) {
  let operation =
    storage.getItem(projectCreateCheckpoint) === "1"
      ? { phase: "review" }
      : null;
  let update;
  const publish = () => update?.();
  return {
    get current() {
      return operation;
    },
    watch(fn) {
      update = fn;
      publish();
    },
    begin() {
      if (operation) return null;
      storage.setItem(projectCreateCheckpoint, "1");
      operation = { phase: "posting" };
      publish();
      return operation;
    },
    phase(attempt, phase) {
      if (operation !== attempt) return;
      attempt.phase = phase;
      publish();
    },
    release(attempt) {
      if (operation !== attempt) return false;
      storage.removeItem(projectCreateCheckpoint);
      operation = null;
      publish();
      return true;
    },
  };
}

const isProjectId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9-]{1,200}$/.test(id);

export function validateCreatedProject(value, input, oldIds) {
  if (
    !value ||
    !isProjectId(value.id) ||
    oldIds.has(value.id) ||
    value.name !== (input.name || "新项目").slice(0, 100) ||
    !Array.isArray(value.requests) ||
    value.requests.length !== 0 ||
    !Array.isArray(value.environments) ||
    value.environments.length === 0 ||
    value.archived ||
    (value.description || "") !== (input.description || "") ||
    !Number.isSafeInteger(value.configRevision) ||
    value.configRevision < 1 ||
    typeof value._diskFingerprint !== "string" ||
    !value._diskFingerprint
  )
    throw Error("无法确认新项目回执");
  return { id: value.id, name: value.name };
}

export function validateProjectRegistry(value, created) {
  const ids = new Set();
  if (
    !Array.isArray(value) ||
    value.some((item) => {
      if (
        !item ||
        !isProjectId(item.id) ||
        ids.has(item.id) ||
        typeof item.name !== "string"
      )
        return true;
      ids.add(item.id);
      return false;
    }) ||
    (created &&
      !value.some(
        (item) =>
          item.id === created.id &&
          item.name === created.name &&
          !item.archived &&
          !item.error,
      ))
  )
    throw Error("无法确认项目列表");
  return value;
}

export function bindProjectCreationForm(
  dialog,
  {
    flow,
    currentForm,
    currentOwner,
    create,
    readRegistry,
    adopt,
    publishRegistry,
    oldIds,
  },
) {
  const form = dialog.querySelector(".project-create-form");
  const name = form.querySelector("#new-name");
  const directory = form.querySelector("#new-directory");
  const description = form.querySelector("#new-description");
  const picker = form.querySelector("#pick-directory");
  const submit = dialog.querySelector("#dialog-save");
  const cancel = dialog.querySelector("footer button[value=cancel]");
  const review = form.querySelector("#project-create-review");
  const reset = form.querySelector("#project-create-reset");
  const status = form.querySelector("#project-create-status");
  let reviewed = false,
    reading = false,
    error = "";
  const draw = () => {
    if (!currentForm()) return;
    const active = flow.current;
    for (const control of [name, directory, description, picker, submit])
      control.disabled = Boolean(active);
    cancel.textContent = active ? "返回工作区" : "取消";
    review.hidden = active?.phase !== "review" || reviewed;
    review.disabled = reading;
    reset.hidden = !active || !reviewed;
    status.hidden = !active && !error;
    status.textContent =
      error ||
      (active?.phase === "posting"
        ? "正在创建项目。返回工作区不会撤回本次创建。"
        : active?.phase === "checking"
          ? "项目已创建，正在核对项目列表。返回不会撤回创建。"
          : reviewed
            ? "已重新读取项目列表。请返回工作区后手动选择；未显示不代表创建失败。"
            : active?.created
              ? "项目已创建，但未打开。请先重新读取项目列表。"
              : active
                ? "创建结果尚未确认，未自动重试。请先重新读取项目列表。"
                : "");
  };
  const fields = () => ({
    name: name.value,
    directory: directory.value || undefined,
    description: description.value || undefined,
  });
  flow.watch(draw);
  submit.onclick = async () => {
    if (!currentForm() || !currentOwner() || flow.current) return;
    error = "";
    const input = fields();
    if (input.description?.length > 2000) {
      error = "项目描述最多 2000 个字符";
      return draw();
    }
    const before = oldIds();
    const attempt = flow.begin();
    if (!attempt) return;
    status.focus({ preventScroll: true });
    attempt.form = form;
    const ownsForm = () =>
      flow.current === attempt &&
      currentForm() &&
      JSON.stringify(fields()) === JSON.stringify(input);
    const owns = () => ownsForm() && currentOwner();
    try {
      attempt.created = validateCreatedProject(
        await create(input),
        input,
        before,
      );
      if (!owns()) return;
      flow.phase(attempt, "checking");
      const registry = validateProjectRegistry(
        await readRegistry(),
        attempt.created,
      );
      if (!owns()) return;
      if (!(await adopt(attempt.created.id, registry, ownsForm))) return;
      flow.release(attempt);
      if (currentForm()) cancel.click();
    } catch {
      // Without a verified adoption, a transport/receipt error never licenses
      // another creation. Only the owner can explicitly re-read the registry.
    } finally {
      flow.phase(attempt, "review");
      if (currentForm() && flow.current === attempt)
        status.focus({ preventScroll: true });
    }
  };

  review.onclick = async () => {
    const active = flow.current;
    if (
      !currentForm() ||
      !currentOwner() ||
      active?.phase !== "review" ||
      reading ||
      reviewed
    )
      return;
    reading = true;
    error = "";
    draw();
    try {
      const listing = validateProjectRegistry(await readRegistry());
      if (!currentForm() || !currentOwner() || flow.current !== active) return;
      publishRegistry(listing);
      reviewed = true;
    } catch {
      if (currentForm()) error = "未能读取项目列表；不会再次创建项目。";
    } finally {
      reading = false;
      draw();
      if (currentForm() && reviewed) status.focus({ preventScroll: true });
    }
  };
  reset.onclick = () => {
    const active = flow.current;
    if (!currentForm() || !currentOwner() || !active || !reviewed) return;
    reviewed = false;
    error = "";
    for (const control of [name, directory, description]) control.value = "";
    if (flow.release(active)) name.focus({ preventScroll: true });
  };
  return () => {
    const active = flow.current;
    if (active?.form === form && active.phase === "checking")
      flow.phase(active, "review");
  };
}
