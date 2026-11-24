import { bindHTTPActionMenu } from "./http-post-actions.js";

export function httpPreActionsHTML({
  configured,
  advanced,
  script,
  scriptOpen,
  advancedOpen,
  hasScript,
  canWait,
}) {
  return `<section class="http-pre-actions" aria-label="预执行操作工作区">
    ${configured}
    ${scriptOpen ? `<section class="http-pre-script-card" aria-labelledby="http-pre-script-title"><header><h3 id="http-pre-script-title">自定义脚本</h3><button type="button" id="expand-script" class="ghost" aria-haspopup="dialog">展开脚本编辑器</button><button type="button" id="http-pre-hide-script" class="ghost">收起</button></header>${script}</section>` : hasScript ? '<p class="http-pre-safety">已配置前置 JavaScript</p>' : ""}
    <button type="button" id="http-pre-add" class="ghost" aria-haspopup="menu" aria-expanded="false" aria-controls="http-pre-menu"><span aria-hidden="true">＋</span> 添加操作项</button>
    <div id="http-pre-menu" popover="auto" role="menu" aria-label="添加操作项"><button type="button" class="ghost" role="menuitem" tabindex="-1" data-pre-action="script">自定义脚本</button><button type="button" class="ghost" role="menuitem" tabindex="-1" data-pre-action="database" aria-haspopup="dialog">数据库</button>${canWait ? '<button type="button" class="ghost" role="menuitem" tabindex="-1" data-pre-action="wait">等待</button>' : ""}</div>
    <details id="http-pre-advanced"${advancedOpen ? " open" : ""}><summary>脚本与高级设置</summary>${advanced}</details>
    <p class="http-pre-safety">脚本在沙箱运行；数据库只读操作需要单独授权。</p>
  </section>`;
}

export function bindHTTPPreActions(panel, { choose, onError }) {
  return bindHTTPActionMenu(panel, {
    triggerSelector: "#http-pre-add",
    menuSelector: "#http-pre-menu",
    actionAttribute: "data-pre-action",
    choose,
    onError,
  });
}
