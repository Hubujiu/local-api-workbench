import {
  canUseHTTPPreWait,
  defaultHTTPPreWaitMilliseconds,
  isHTTPPreWaitMarker,
  maxHTTPPreWaitMilliseconds as limit,
} from "./http-pre-wait-contract.js";
export const waitDraftError = "请修正前置等待时长后再保存或发送";
const durationError = "等待时长须为 0 至 10000 毫秒的整数";
const budgetError = "启用的前置等待累计不能超过 10000 毫秒";

export const isHTTPPreWait = (operation) =>
  operation?.type === "wait" && operation.waitVersion === 1;

export const supportsHTTPPreWait = canUseHTTPPreWait;

export function validateHTTPPreWaits(request, operations) {
  let total = 0;
  for (const operation of operations) {
    if (!isHTTPPreWaitMarker(operation)) continue;
    if (!supportsHTTPPreWait(request))
      throw Error("导入任务、GraphQL 和 SDK URL 模式不支持普通前置等待");
    if (
      !isHTTPPreWait(operation) ||
      Object.keys(operation).length !== 4 ||
      typeof operation.enabled !== "boolean" ||
      !Number.isInteger(operation.milliseconds) ||
      operation.milliseconds < 0 ||
      operation.milliseconds > limit
    )
      throw Error(durationError);
    if (operation.enabled && (total += operation.milliseconds) > limit)
      throw Error(budgetError);
  }
}

export function addHTTPPreWait(request) {
  const operation = {
    type: "wait",
    waitVersion: 1,
    milliseconds: defaultHTTPPreWaitMilliseconds,
    enabled: true,
  };
  validateHTTPPreWaits(request, [...request.before, operation]);
  request.before.push(operation);
  return request.before.length - 1;
}

export function createHTTPPreWaitDrafts() {
  // The same row object follows its request through reordering and rerenders.
  const invalid = new WeakMap();
  const propose = (request, operation, patch) =>
    validateHTTPPreWaits(
      request,
      request.before.map((row) =>
        row === operation ? { ...row, ...patch } : row,
      ),
    );
  return {
    read: (operation) => invalid.get(operation),
    pending: (requests) =>
      requests.some((request) =>
        (request.before || []).some((operation) => invalid.has(operation)),
      ),
    clear: (operation) => invalid.delete(operation),
    edit(request, operation, raw) {
      try {
        const milliseconds = /^\d{1,5}$/u.test(raw) ? Number(raw) : NaN;
        propose(request, operation, { milliseconds });
        const changed = operation.milliseconds !== milliseconds;
        operation.milliseconds = milliseconds;
        invalid.delete(operation);
        return changed;
      } catch (error) {
        invalid.set(operation, { raw, message: error.message });
        return false;
      }
    },
    toggle(request, operation, enabled) {
      propose(request, operation, { enabled });
      operation.enabled = enabled;
    },
  };
}

export function httpPreWaitHTML(operation, index, length, draft, esc) {
  return `<div class="http-pre-wait-card" data-operation-index="${index}" data-pre-wait-row>
    <div class="http-pre-wait-bar">
      <input type="checkbox" role="switch" class="http-pre-wait-toggle" data-pre-wait-toggle="${index}" aria-label="启用等待" ${operation.enabled ? "checked" : ""}>
      <span class="http-pre-wait-title">等待</span>
      <label class="http-pre-wait-duration"><input data-pre-wait-ms="${index}" type="text" inputmode="numeric" aria-label="等待时长（毫秒）" aria-describedby="http-pre-wait-error-${index}" aria-invalid="${Boolean(draft)}" maxlength="6" value="${esc(draft?.raw ?? operation.milliseconds)}"><span aria-hidden="true">ms</span></label>
      <div class="http-pre-wait-tools"><button type="button" class="ghost" data-move-operation="${index}:-1" ${index === 0 ? "disabled" : ""}>上移</button><button type="button" class="ghost" data-move-operation="${index}:1" ${index === length - 1 ? "disabled" : ""}>下移</button><button type="button" class="ghost" data-remove-operation="${index}" aria-label="删除等待">×</button></div>
    </div>
    <p id="http-pre-wait-error-${index}" class="http-pre-wait-error" aria-live="polite" ${draft ? "" : "hidden"}>${esc(draft?.message || "")}</p>
  </div>`;
}
