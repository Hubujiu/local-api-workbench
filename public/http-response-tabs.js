const responseViews = [
  ["body", "实时响应"],
  ["headers", "响应头"],
  ["cookies", "Cookie"],
  ["examples", "响应示例"],
  ["request", "实际请求"],
  ["logs", "控制台"],
  ["visualization", "可视化"],
  ["scriptResponse", "脚本视图"],
  ["assertions", "断言结果"],
  ["extracted", "提取变量"],
];

export function httpResponseTabs(active, hasSubrequests, headerCount) {
  const views = hasSubrequests
    ? [...responseViews, ["subrequests", "脚本子请求"]]
    : responseViews;
  return `<div class="response-tabs" role="group" aria-label="响应视图">${views
    .map(
      ([key, label]) =>
        `<button type="button" data-response="${key}" class="${active === key ? "active" : ""}" aria-pressed="${active === key}">${label}${key === "headers" && Number.isSafeInteger(headerCount) && headerCount >= 0 ? ` <span class="http-response-header-count">(${headerCount})</span>` : ""}</button>`,
    )
    .join("")}</div>`;
}

export function readResponseTabsPosition(strip, active) {
  return {
    scrollLeft: strip?.scrollLeft || 0,
    focused: strip?.contains(active) ? active.dataset.response : undefined,
    selected: strip?.querySelector(".active")?.dataset.response,
  };
}

export function restoreResponseTabsPosition(strip, previous) {
  if (!strip) return;
  strip.scrollLeft = previous.scrollLeft;
  const button = [...strip.querySelectorAll("[data-response]")].find(
    (item) => item.dataset.response === previous.focused,
  );
  if (button) button.focus({ preventScroll: true });
  const selected = strip.querySelector(".active");
  const target =
    button || (selected?.dataset.response !== previous.selected && selected);
  if (!target) return;
  const edges = strip.getBoundingClientRect();
  const bounds = target.getBoundingClientRect();
  if (bounds.left < edges.left) strip.scrollLeft += bounds.left - edges.left;
  else if (bounds.right > edges.right)
    strip.scrollLeft += bounds.right - edges.right;
}
