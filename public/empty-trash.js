import { icon } from "./icons.js";

// Match the existing populated UI: archived projects and this project's
// recoverable request rows. Other resource trash is not claimed to be empty.
export function hasVisibleTrash(project, projects) {
  return (
    projects.some((item) => Boolean(item.archived)) ||
    project.requests.some((item) => Boolean(item.deletedAt))
  );
}

export function openEmptyTrash(dialog, opener) {
  if (dialog.open) return;
  dialog.innerHTML = `<form method="dialog" class="empty-trash-form"><header><h2 id="empty-trash-heading">回收站</h2><button type="submit" value="close" aria-label="关闭" autofocus>×</button></header><div class="empty-trash-content"><div>${icon("body-empty")}<p id="empty-trash-description">暂无可在此恢复的接口或归档项目</p></div></div></form>`;
  const listeners = new AbortController();
  const close = (event) => {
    if (!dialog.open) return;
    event.preventDefault();
    listeners.abort();
    dialog.close();
    if (opener.isConnected) opener.focus({ preventScroll: true });
  };
  dialog.addEventListener("cancel", close, { signal: listeners.signal });
  dialog.addEventListener("submit", close, { signal: listeners.signal });
  dialog.showModal();
}
