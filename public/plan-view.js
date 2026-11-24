import { renderStepPicker } from "./plan-step-picker.js";
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
    '<section class="plan-main' +
    (tab === "plans" && plan ? " plan-editor" : "") +
    '">' +
    (tab === "runs"
      ? '<div id="plan-run-records">' + renderRuns(runs, lastRun) + "</div>"
      : plan
        ? renderEditor(plan, busy, project, project.requests || [])
        : '<div class="plan-selection-empty"><p>请选择或新建一个执行计划</p></div>') +
    "</section></div></div>"
  );
}
function renderEditor(plan, busy, project, requests) {
  const environments = project.environments || [];
  const environmentId =
    plan.environmentId || project.currentEnvironmentId || environments[0]?.id;
  const hasEnvironment = environments.some(({ id }) => id === environmentId);
  return (
    '<div class="row plan-editor-heading"><div class="row grow"><h2>执行计划编辑器</h2><time class="subtle">最近修改：' +
    esc(historyDate(plan.updatedAt || plan.createdAt)) +
    '</time></div><button id="run-plan" class="primary" ' +
    (busy ? "disabled" : "") +
    ">" +
    (busy ? "执行中…" : "执行计划") +
    "</button>" +
    (busy ? '<button id="cancel">停止</button>' : "") +
    '<button id="delete-plan" class="danger">删除计划</button></div>' +
    (Object.values(plan.provenance?.fields || {}).includes("ai") ||
    Object.values(plan.provenance?.steps || {}).includes("ai")
      ? '<div class="notice ai-value">橙色内容由 AI 创建或修改；你可以检查并直接修改。</div>'
      : "") +
    '<div class="plan-editor-fields"><label for="plan-name">计划名称</label><input id="plan-name" placeholder="例如：用户下单验证" class="' +
    ai(plan, "name") +
    '" value="' +
    esc(plan.name) +
    '"><label for="plan-description">计划说明</label><textarea id="plan-description" placeholder="说明该执行计划的验证目标" class="' +
    ai(plan, "description") +
    '">' +
    esc(plan.description || "") +
    "</textarea>" +
    '<label for="plan-env">执行环境</label><div class="plan-environment-field"><select id="plan-env" class="' +
    ai(plan, "environmentId") +
    '">' +
    (hasEnvironment
      ? ""
      : '<option value="" selected disabled>环境不可用</option>') +
    environments
      .map(
        (env) =>
          '<option value="' +
          esc(env.id) +
          '" ' +
          (env.id === environmentId ? "selected" : "") +
          ">" +
          esc(env.name) +
          "</option>",
      )
      .join("") +
    "</select>" +
    '<button type="button" id="view-plan-environment" aria-label="查看执行环境" aria-haspopup="dialog" aria-controls="plan-environment-inspection"' +
    (hasEnvironment ? "" : " disabled") +
    ">查看</button></div></div>" +
    '<dialog id="plan-environment-inspection" aria-labelledby="plan-environment-inspection-title"><header><button type="button" aria-label="关闭执行环境">×</button><h2 id="plan-environment-inspection-title"></h2></header><div class="plan-environment-scroll"><p>查看当前项目的环境和全局变量。变量值不显示，不会运行计划。</p><div id="plan-environment-inspection-tabs"></div></div></dialog>' +
    '<section class="plan-editor-workflow"><h3>执行步骤</h3>' +
    renderStepPicker(requests) +
    plan.steps
      .map((step, index) => renderPlanStep(step, index, plan))
      .join("") +
    (!plan.steps.length
      ? '<div class="notice">计划为空，请添加已有接口的独立快照。</div>'
      : "") +
    '<div class="plan-save"><button id="save-plan-details" class="primary">保存计划</button></div></section>' +
    '<section class="plan-editor-advanced">' +
    '<label for="plan-status-policy">成功状态规则</label><select id="plan-status-policy" class="' +
    ai(plan, "statusPolicy") +
    '"><option value="assertions" ' +
    (plan.statusPolicy !== "strict200" ? "selected" : "") +
    '>默认 2xx，可用状态断言指定预期错误</option><option value="strict200" ' +
    (plan.statusPolicy === "strict200" ? "selected" : "") +
    ">原版兼容：仅 200，断言不能豁免非 200</option></select>" +
    '<div class="row"><button id="edit-plan">编辑 JSON</button><button id="edit-plan-structure">编辑步骤结构</button></div></section>'
  );
}
function stepOverview(
  step,
  position,
  inheritedDisabled = false,
  inspectIndex = null,
) {
  const summary = planStepSummary(step);
  const title = esc(step.name || summary.kind);
  const heading =
    inspectIndex === null
      ? "<strong>" + title + "</strong>"
      : '<button type="button" class="plan-snapshot-opener" data-plan-inspect-step="' +
        inspectIndex +
        '" aria-expanded="false" aria-controls="plan-snapshot-' +
        inspectIndex +
        '">' +
        title +
        "</button>";
  return (
    '<span class="step-number">' +
    esc(position) +
    "</span>" +
    '<span class="method">' +
    esc(summary.kind) +
    "</span>" +
    '<div class="grow">' +
    heading +
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
    stepOverview(step, index + 1, false, advanced ? null : index) +
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
    (advanced
      ? ""
      : '<section class="plan-snapshot-inspection" id="plan-snapshot-' +
        index +
        '" aria-label="请求快照" hidden><h4>请求 <span>步骤快照 · 不读取源接口</span></h4><div id="plan-snapshot-tabs-' +
        index +
        '" class="plan-snapshot-tabs"></div></section>') +
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
