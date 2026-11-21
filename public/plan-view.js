import { isHTTPPlanStep, planStepSummary } from "./plan-step-types.js";
import { assertionState } from "./assertion-state.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const ai = (plan, field) =>
  plan.provenance?.fields?.[field] === "ai" ? "ai-value" : "";
export function renderPlans({ project, planId, lastRun, busy, tab = "plans" }) {
  const plan = project.plans.find((item) => item.id === planId);
  const runs = lastRun
    ? [lastRun, ...project.runs.filter((run) => run.id !== lastRun.id)]
    : project.runs;
  const tabs =
    '<div class="plan-tabs" aria-label="计划与记录"><button data-plan-tab="plans" aria-pressed="' +
    (tab === "plans") +
    '" class="' +
    (tab === "plans" ? "primary" : "") +
    '">执行计划</button><button data-plan-tab="runs" aria-pressed="' +
    (tab === "runs") +
    '" class="' +
    (tab === "runs" ? "primary" : "") +
    '">执行记录</button></div>';
  return (
    '<div class="page plans-page"><header class="plans-heading"><h1>AI执行计划</h1><p>手动编排接口步骤，执行后查看报告；AI 可通过已授权的 MCP 连接协助操作。</p></header>' +
    (tab === "runs"
      ? '<div class="plan-history-controls">' +
        tabs +
        '<div class="plan-history-actions"><button type="button" class="ghost" id="refresh-plan-history" title="只读刷新已保存记录，不运行计划或保存草稿。">刷新执行记录</button><span id="plan-history-refresh-status" role="status" class="subtle"></span></div></div>'
      : tabs) +
    '<p id="mcp-plan-status" class="subtle"></p>' +
    '<div class="plan-layout' +
    (tab === "runs" ? " plan-history-layout" : "") +
    '">' +
    (tab === "runs"
      ? ""
      : '<aside class="plan-list"><div class="row"><strong class="grow">执行计划</strong><button id="new-plan" class="primary">新建计划</button></div>' +
        project.plans
          .map(
            (item) =>
              '<button data-plan="' +
              item.id +
              '" class="' +
              (item.id === planId ? "active" : "") +
              '">' +
              esc(item.name) +
              "</button>",
          )
          .join("") +
        (project.plans.length
          ? ""
          : '<p class="plan-list-empty">暂无执行计划</p>') +
        "</aside>") +
    '<section class="plan-main">' +
    (tab === "runs"
      ? '<div id="plan-run-records">' + renderRuns(runs, lastRun) + "</div>"
      : plan
        ? renderEditor(plan, busy, project.environments)
        : '<div class="plan-selection-empty"><p>请选择或新建一个执行计划</p></div>') +
    "</section></div></div>"
  );
}
function renderEditor(plan, busy, environments) {
  return (
    '<div class="row"><h2 class="grow">执行计划编辑器</h2><button id="run-plan" class="primary" ' +
    (busy ? "disabled" : "") +
    ">" +
    (busy ? "执行中…" : "执行计划") +
    "</button>" +
    (busy ? '<button id="cancel">停止</button>' : "") +
    '<button id="delete-plan" class="danger">删除计划</button></div>' +
    '<p class="subtle">最近修改：' +
    esc(plan.updatedAt || plan.createdAt) +
    "</p>" +
    (Object.values(plan.provenance?.fields || {}).includes("ai") ||
    Object.values(plan.provenance?.steps || {}).includes("ai")
      ? '<div class="notice ai-value">橙色内容由 AI 创建或修改；你可以检查并直接修改。</div>'
      : "") +
    '<label>计划名称</label><input id="plan-name" class="' +
    ai(plan, "name") +
    '" value="' +
    esc(plan.name) +
    '"><label>计划说明</label><textarea id="plan-description" class="' +
    ai(plan, "description") +
    '">' +
    esc(plan.description || "") +
    "</textarea>" +
    '<label>执行环境</label><select id="plan-env" class="' +
    ai(plan, "environmentId") +
    '">' +
    environments
      .map(
        (env) =>
          '<option value="' +
          env.id +
          '" ' +
          (env.id === plan.environmentId ? "selected" : "") +
          ">" +
          esc(env.name) +
          "</option>",
      )
      .join("") +
    "</select>" +
    '<label>成功状态规则</label><select id="plan-status-policy" class="' +
    ai(plan, "statusPolicy") +
    '"><option value="assertions" ' +
    (plan.statusPolicy !== "strict200" ? "selected" : "") +
    '>默认 2xx，可用状态断言指定预期错误</option><option value="strict200" ' +
    (plan.statusPolicy === "strict200" ? "selected" : "") +
    ">原版兼容：仅 200，断言不能豁免非 200</option></select>" +
    '<div class="page-head"><h3>执行步骤</h3><div class="row"><button id="edit-plan">编辑 JSON</button><button id="edit-plan-structure">编辑步骤结构</button><button id="add-step">＋ 添加步骤</button></div></div>' +
    plan.steps
      .map((step, index) => renderPlanStep(step, index, plan))
      .join("") +
    (!plan.steps.length
      ? '<div class="notice">计划为空，请添加已有接口的独立快照。</div>'
      : "") +
    '<div class="plan-save"><button id="save-plan-details" class="primary">保存计划</button></div>'
  );
}
function stepOverview(step, position, inheritedDisabled = false) {
  const summary = planStepSummary(step);
  return (
    '<span class="step-number">' +
    esc(position) +
    "</span>" +
    '<span class="method">' +
    esc(summary.kind) +
    "</span>" +
    '<div class="grow"><strong>' +
    esc(step.name || summary.kind) +
    "</strong>" +
    '<div class="subtle">' +
    esc(summary.detail) +
    "</div>" +
    (step.enabled === false || inheritedDisabled
      ? '<span class="muted">已禁用（含上层禁用）</span>'
      : "") +
    "</div>"
  );
}
function nestedSteps(step, position, inheritedDisabled = false, depth = 0) {
  if (!["repeat", "if"].includes(step.type)) return "";
  if (depth >= 8) return '<p class="notice">结构过深，请使用 JSON 检查。</p>';
  return (
    '<div class="plan-step-children">' +
    (step.steps || [])
      .map((child, index) => {
        const path = position + "." + (index + 1);
        const disabled = inheritedDisabled || step.enabled === false;
        return (
          '<div class="row" data-plan-node="' +
          esc(path) +
          '">' +
          stepOverview(child, path, disabled) +
          "</div>" +
          nestedSteps(child, path, disabled, depth + 1)
        );
      })
      .join("") +
    "</div>"
  );
}
function renderPlanStep(step, index, plan) {
  const advanced = !isHTTPPlanStep(step);
  return (
    '<section class="plan-step-block"><div class="plan-step ' +
    (plan.provenance?.steps?.[step.id] === "ai" ? "ai-value" : "") +
    '" draggable="true" data-step-drag="' +
    index +
    '">' +
    '<span class="drag-handle" title="拖动排序">⠿</span>' +
    '<input type="checkbox" data-step-enable="' +
    index +
    '" ' +
    (step.enabled !== false ? "checked" : "") +
    ' aria-label="启用步骤">' +
    stepOverview(step, index + 1) +
    '<button data-step-up="' +
    index +
    '" ' +
    (index === 0 ? "disabled" : "") +
    ' aria-label="上移步骤">↑</button>' +
    '<button data-step-edit="' +
    index +
    '">' +
    (["repeat", "if"].includes(step.type)
      ? "编辑循环/条件"
      : advanced
        ? "编辑 JSON"
        : "编辑") +
    "</button>" +
    '<button data-step-delete="' +
    index +
    '" class="danger">移除</button></div>' +
    nestedSteps(step, index + 1) +
    (advanced
      ? '<p class="subtle">循环/条件可视化修改；协议和结构详情使用完整 JSON，未修改字段保留。</p>'
      : "") +
    "</section>"
  );
}
function historyDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US");
}
export function renderRuns(runs, lastRun) {
  if (!runs.length) return '<p class="plan-history-empty">暂无执行记录</p>';
  return (
    '<p class="plan-history-limit">为避免本地文件过大，执行记录仅保留最近 50 条</p>' +
    runs
      .map(
        (run) =>
          '<details class="card" data-plan-run-id="' +
          esc(run.id) +
          '" ' +
          (run.id === lastRun?.id ? "open" : "") +
          '><summary><span class="plan-run-source">' +
          (run.source === "manual" || (!run.source && run === lastRun)
            ? "人工"
            : run.source === "mcp"
              ? "AI"
              : run.source === "cli"
                ? "CLI"
                : "来源未知") +
          '</span><span class="plan-run-title">业务流程执行 · ' +
          esc(run.planName) +
          '</span><time class="plan-run-time subtle">' +
          esc(historyDate(run.createdAt)) +
          '</time><span class="plan-run-verdict ' +
          (run.status === "passed"
            ? "success"
            : run.status === "failed"
              ? "failed"
              : "subtle") +
          '">' +
          (run.status === "passed"
            ? "通过"
            : run.status === "cancelled"
              ? "已取消"
              : run.status === "failed"
                ? "失败"
                : "结果待核对") +
          '</span></summary><div class="plan-run-body">' +
          run.results.map(renderRunStep).join("") +
          '<div class="plan-run-evidence-footer"><p class="subtle plan-run-hash">快照 SHA256: ' +
          esc(run.planHash) +
          '</p><button data-export-run="' +
          esc(run.id) +
          '">导出证据 JSON</button></div></div></details>',
      )
      .join("")
  );
}

function evidenceBlock(label, value) {
  return (
    '<details class="step-evidence" data-evidence="' +
    esc(label) +
    '"><summary>' +
    esc(label) +
    "</summary><pre>" +
    esc(
      typeof value === "string"
        ? value
        : JSON.stringify(value ?? null, null, 2),
    ) +
    "</pre></details>"
  );
}
function renderRunStep(step, index) {
  const failures = (step.assertions || []).filter(
    (assertion) => assertionState(assertion) === "failed",
  );
  const failure = failures[0];
  const compactMismatch =
    step.status === "failed" &&
    !!step.response &&
    !step.error &&
    failures.length === 1 &&
    failure.target === "status" &&
    failure.op === "eq" &&
    Number.isInteger(failure.actual) &&
    Number.isInteger(failure.value) &&
    failure.actual === step.response.status &&
    failure.actual !== failure.value;
  return (
    '<details class="card run-step" data-run-step="' +
    index +
    '" ' +
    (step.status === "failed" && !compactMismatch ? "open" : "") +
    "><summary>" +
    (index + 1) +
    '. <span class="' +
    (step.status === "passed" ? "success" : "failed") +
    '">' +
    esc(step.status) +
    "</span> <strong>" +
    esc(step.name) +
    '</strong> <span class="subtle">' +
    esc(step.response?.request?.method || step.request?.method) +
    " " +
    esc(step.response?.request?.url || step.request?.url) +
    "</span> · " +
    (step.response?.status || "") +
    " " +
    (step.response?.duration || 0) +
    "ms" +
    (compactMismatch
      ? '<span class="plan-step-status-mismatch failed">接口返回状态码 ' +
        failure.actual +
        "，期望 " +
        failure.value +
        "</span>"
      : "") +
    "</summary>" +
    renderStepEvidence(step) +
    "</details>"
  );
}
function renderStepEvidence(step) {
  const assertions = step.assertions || [];
  return (
    (step.error ? '<p class="notice failed">' + esc(step.error) + "</p>" : "") +
    '<section class="step-assertions"><h4>断言结果</h4>' +
    (assertions.length
      ? assertions
          .map(
            (assertion) =>
              '<div class="' +
              (assertionState(assertion) === "skipped"
                ? "muted"
                : assertion.passed
                  ? "success"
                  : "failed") +
              '">' +
              (assertionState(assertion) === "skipped"
                ? "跳过 · "
                : assertion.passed
                  ? "✓ "
                  : "× ") +
              esc(
                assertion.phase === "before"
                  ? "前置 · "
                  : assertion.phase === "after"
                    ? "后置 · "
                    : "",
              ) +
              esc(
                assertion.name ||
                  [
                    assertion.target,
                    assertion.op,
                    JSON.stringify(assertion.value),
                  ].join(" "),
              ) +
              (assertion.error ? "：" + esc(assertion.error) : "") +
              "</div>",
          )
          .join("")
      : '<p class="subtle">无断言记录</p>') +
    "</section>" +
    evidenceBlock(
      step.requestUnresolved ? "请求配置（未发送）" : "请求",
      step.request,
    ) +
    evidenceBlock("响应", step.response || "未收到响应") +
    evidenceBlock("脚本与操作日志", step.logs || []) +
    (step.subrequests?.length
      ? evidenceBlock("脚本HTTP子请求", step.subrequests)
      : "") +
    evidenceBlock("提取变量", step.extracted || {}) +
    evidenceBlock("完整步骤证据 JSON", step)
  );
}
