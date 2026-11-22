import { icon } from "./icons.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export function loadWorkspace(options = {}, loadResult, busy = false) {
  return `<section class="load-workspace" aria-label="一键压测"><div class="load-setup"><h2 class="load-setup-heading">压测设置</h2><div class="load-setup-content"><div class="load-controls load-setup-grid">
    <div class="load-setup-row"><label for="load-data-file">导入 CSV（可选）</label><input id="load-data-file" type="file" accept=".csv,text/csv" ${busy ? "disabled" : ""}></div>
    <div class="load-setup-row"><label for="load-concurrency">并发数</label><input id="load-concurrency" type="number" value="${esc(options.concurrency ?? 1)}" min="1" max="10"></div>
    <div class="load-setup-row"><label for="load-mode">模式</label><div class="load-setup-mode"><select id="load-mode" ${busy ? "disabled" : ""}><option value="count" ${options.mode !== "duration" ? "selected" : ""}>按请求数</option><option value="duration" ${options.mode === "duration" ? "selected" : ""}>按持续时长</option></select><label>请求数 / 上限 <input id="load-count" type="number" value="${esc(options.count ?? 10)}" min="1" max="100"></label><label>时长（秒，仅时长模式） <input id="load-duration" type="number" min="1" max="60" value="${esc(options.durationSeconds ?? 10)}" ${busy ? "disabled" : ""}></label></div></div>
  </div><div class="load-data-panel"><label for="load-data">参数化数据（UTF-8 CSV，可选）</label><p class="muted">首行为变量名，后续行依次循环供 {{变量名}} 使用，仅覆盖本次运行。最多64 KiB、100行、50列；数据只保留在当前页面会话，不保存到项目。</p><textarea id="load-data" rows="4" spellcheck="false" ${busy ? "disabled" : ""} placeholder="id,name&#10;1,示例">
${esc(options.dataCSV ?? "")}</textarea></div>
  <div class="load-setup-actions"><button id="load-run" class="primary" ${busy ? "disabled" : ""}>开始压测</button>${busy ? '<button id="cancel">停止</button>' : ""}<details class="load-safety"><summary>压测范围与安全说明</summary><p class="muted">仅对你有权测试的接口使用。最多100次主请求执行、并发10，支持取消。包含脚本、动态值和断言；每次执行的变量独立，不回写项目。脚本子请求另计（各自受沙箱上限约束），HTTP调用数不等于网络往返次数。P50/P95是主请求耗时，逐次elapsed另含脚本等待；脚本与子请求也可能产生副作用。</p><p class="muted">按时长模式限定1至60秒，仍受请求上限约束；先到时长或请求上限即停止，不保证持续到指定秒数。到时会中断尚未完成的请求和脚本，并保留记录。</p></details></div></div></div><section class="load-results" aria-label="压测结果">${
    loadResult
      ? `<div class="grid-stats">${[
          ["已记录", loadResult.count],
          [
            "停止原因",
            {
              count: "请求数完成",
              "count-limit": "达到请求上限",
              duration: "达到持续时长",
              cancelled: "手动取消",
            }[loadResult.stopReason] || "未知",
          ],
          ["通过", loadResult.passed],
          ["未通过（含中断）", loadResult.count - loadResult.passed],
          ["总耗时", loadResult.elapsed + " ms"],
          ["主请求调用", loadResult.mainRequests ?? loadResult.count],
          ["脚本子请求", loadResult.scriptRequests ?? 0],
          [
            "P50",
            loadResult.timingSamples === 0 ? "—" : loadResult.p50 + " ms",
          ],
          [
            "P95",
            loadResult.timingSamples === 0 ? "—" : loadResult.p95 + " ms",
          ],
        ]
          .map(
            ([l, v]) =>
              `<div class="stat">${l}<strong>${esc(v)}</strong></div>`,
          )
          .join(
            "",
          )}</div><pre>${esc(JSON.stringify(loadResult.results, null, 2))}</pre>`
      : `<div class="load-idle-result"><span aria-hidden="true">${icon("body-empty")}</span><p>暂无压测结果</p></div>`
  }</section></section>`;
}
