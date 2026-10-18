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
  return (
    '<div class="page plans-page"><div class="plan-tabs"><button data-plan-tab="plans" class="' +
    (tab === "plans" ? "primary" : "") +
    '">执行计划</button><button data-plan-tab="runs" class="' +
    (tab === "runs" ? "primary" : "") +
    '">执行记录</button></div><p id="mcp-plan-status" class="subtle"></p>' +
    '<div class="plan-layout"><aside class="plan-list"><div class="row"><strong class="grow">执行计划</strong><button id="new-plan" class="primary">新建计划</button></div>' +
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
    '</aside><section class="plan-main">' +
    (tab === "runs"
      ? renderRuns(runs, lastRun)
      : plan
        ? renderEditor(plan, busy, project.environments)
        : '<div class="empty"><p>新建计划后添加接口步骤。</p></div>') +
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
    '<div class="page-head"><h3>执行步骤</h3><div class="row"><button id="edit-plan">编辑 JSON</button><button id="add-step">＋ 添加步骤</button></div></div>' +
    plan.steps
      .map(
        (step, index) =>
          '<div class="plan-step ' +
          (plan.provenance?.steps?.[step.id] === "ai" ? "ai-value" : "") +
          '" draggable="true" data-step-drag="' +
          index +
          '"><span class="drag-handle" title="拖动排序">⠿</span><span class="step-number">' +
          (index + 1) +
          '</span><input type="checkbox" data-step-enable="' +
          index +
          '" ' +
          (step.enabled ? "checked" : "") +
          ' aria-label="启用步骤"><span class="method ' +
          step.request.method +
          '">' +
          step.request.method +
          '</span><div class="grow"><strong>' +
          esc(step.name) +
          '</strong><div class="subtle">' +
          esc(step.request.url) +
          '</div></div><button data-step-up="' +
          index +
          '" ' +
          (index === 0 ? "disabled" : "") +
          ' aria-label="上移步骤">↑</button><button data-step-edit="' +
          index +
          '">编辑</button><button data-step-delete="' +
          index +
          '" class="danger">移除</button></div>',
      )
      .join("") +
    (!plan.steps.length
      ? '<div class="notice">计划为空，请添加已有接口的独立快照。</div>'
      : "") +
    '<div class="plan-save"><button id="save-plan-details" class="primary">保存计划</button></div>'
  );
}
function renderRuns(runs, lastRun) {
  return (
    '<h2>执行记录 <span class="subtle">最近 50 条</span></h2>' +
    (runs
      .map(
        (run) =>
          '<details class="card" ' +
          (run.id === lastRun?.id ? "open" : "") +
          '><summary><span class="' +
          (run.status === "passed" ? "success" : "failed") +
          '">' +
          (run.status === "passed"
            ? "✓ 通过"
            : run.status === "cancelled"
              ? "■ 已取消"
              : "× 失败") +
          "</span> " +
          esc(run.planName) +
          ' <span class="subtle">' +
          esc(run.createdAt) +
          " · " +
          run.results.length +
          ' 步</span></summary><p class="subtle">快照 SHA256: ' +
          esc(run.planHash) +
          "</p>" +
          run.results
            .map(
              (step, index) =>
                '<details class="card run-step" data-run-step="' +
                index +
                '" ' +
                (step.status === "failed" ? "open" : "") +
                "><summary>" +
                (index + 1) +
                '. <span class="' +
                (step.status === "passed" ? "success" : "failed") +
                '">' +
                esc(step.status) +
                "</span> " +
                esc(step.name) +
                " · " +
                (step.response?.status || "") +
                " " +
                (step.response?.duration || 0) +
                "ms</summary>" +
                renderStepEvidence(step) +
                "</details>",
            )
            .join("") +
          '<button data-export-run="' +
          run.id +
          '">导出证据 JSON</button></details>',
      )
      .join("") || '<div class="empty"><p>计划运行后会保留逐步证据。</p></div>')
  );
}

function evidenceBlock(label, value, open = false) {
  return (
    '<details class="step-evidence" ' +
    (open ? "open" : "") +
    "><summary>" +
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
              (assertion.passed ? "success" : "failed") +
              '">' +
              (assertion.passed ? "✓ " : "× ") +
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
    evidenceBlock(
      "响应",
      step.response || "未收到响应",
      step.status === "failed" && !!step.response,
    ) +
    evidenceBlock("脚本与操作日志", step.logs || []) +
    evidenceBlock("提取变量", step.extracted || {}) +
    evidenceBlock("完整步骤证据 JSON", step)
  );
}
