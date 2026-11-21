import { icon } from "./icons.js";

export function emptyCasePanel(project, sourceRequestId, busy = false) {
  if (
    (project.cases || []).some(
      (item) => item.sourceRequestId === sourceRequestId,
    ) ||
    (project.caseFolders || []).some(
      (item) => item.sourceRequestId === sourceRequestId,
    )
  )
    return null;
  return `<section class="case-empty-layout" aria-label="接口用例"><aside class="case-empty-menu" aria-label="用例导航"><div class="case-empty-menu-title">${icon("☷")}接口用例</div><div class="case-empty-menu-current" aria-current="page">请求快照</div><button id="create-case" type="button">${icon("⑂")}创建执行计划</button><details class="case-empty-help"><summary>用例说明</summary><p>每个用例保存独立请求快照，可覆盖参数、断言和脚本。原接口修改不会自动覆盖用例。分组仅组织用例，不改变请求快照。</p></details></aside><div class="case-empty-stage"><div class="case-empty-actions"><button id="new-interface-case" type="button" class="case-empty-action" ${busy ? "disabled" : ""}><span class="case-empty-icon">${icon("☷")}</span><strong>添加用例</strong></button><button id="new-case-folder" type="button" class="case-empty-action" ${busy ? "disabled" : ""}><span class="case-empty-icon case-empty-icon-folder">${icon("▧")}</span><strong>添加分组</strong></button></div></div></section>`;
}
