# 执行历史刷新焦点候选

基于 #248 head `b5e4899b27e3986c8044ed31a0e624eac8654a0c`、tree
`2b2a60439f2280687960ce4f12f7e1dd8994e058`。尚未发布或完成验收。

原实现已有 role=status。实际缺口是 GET pending 时用户移入旧记录的控件，
成功刷新 innerHTML 替换后焦点丢失。本候选在替换当时捕获记录区域内焦点，
按稳定 run ID 恢复导出控件或记录 summary；旧嵌套控件映射到所属记录 summary，
记录消失则回到已重新启用的刷新按钮。外部焦点不抢回，失败读取不改变焦点。
导出控件所在记录需展开才能聚焦；使用 preventScroll，但不宣称真实浏览器滚动位置已验证。
不改变 GET、草稿、CAS、未知写入守卫、预算或执行语义。

单测覆盖纯 helper 和实际 app handler：字面 ID、未知嵌套控件、外部焦点、
旧 DOM、失败读取、fallback 时按钮已启用；真实 HTTP 验证新增模块静态路由。
桌面构建已有递归复制 public 目录，不需改变构建配置。

真实浏览器候选复用 held GET，使用 locator.focus() 把焦点置于实际可见导出按钮，
等待实际刷新 listener 完结，再核对 document.activeElement 对应同一记录且记录展开。
这是程序化真实 DOM 焦点验证，不是物理键盘 Tab、读屏软件或滚动位置验收。
保留原完整导出、草稿/CAS 与无重放断言。

本机 Chromium 启动仍 socket EPERM，未执行新增浏览器步骤。待 CI 验证
`PLAN_HISTORY_REFRESH_FOCUS_BROWSER_PASS`、既有 marker 和全部 jobs 后才能记为通过。
