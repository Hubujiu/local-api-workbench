# 手动只读执行记录刷新候选

基线为 #244 `420acf74edd271651154cc0e14c1f8fa3737caf9`，导入后 tree
`de0f5142d2145c1e4e6ce9f25f55d221a4e8e3ca` 已核对。尚未发布或完成产品验收。

执行记录页提供显式刷新。现有 owner `GET /api/projects/:id` 返回完整项目，
**不是专用历史端点**；本候选只选择 `runs`，不采纳配置、revision、
configRevision、磁盘指纹，不承认任何不确定写入已解决，不调用保存或运行。
“只读”指 GUI 只发 GET、不执行或保存的语义；不保证服务端正常存储恢复完全无磁盘写入。
仅替换记录区域 DOM，不重建编辑器。服务端读失败或格式/身份错误保留旧记录。

采用项目对象、打开序号、编辑版本、当前页/标签、DOM 存活、执行/保存状态和
lastRun 身份守卫；旧请求以及执行记录已被其他操作替换时拒绝采用。
本地 lastRun 与已保存记录重复时，显示和导出均选同一 lastRun；未知结果不显示成功。
先渲染后更新缓存，嵌套证据格式错误不能清掉旧记录。

## 已验证与待办

控制器、视图和真实 app handler 提取接线单测覆盖异步身份、草稿、运行、保存、
页面切换、错误、重复记录、导出一致性。接线测试使用模拟 DOM，**不是浏览器证明**。

发布前须独立复审，并完成真实浏览器旅程验证：GUI 先打开且有未保存草稿，再由正式
MCP 工具执行合成注册/提取/登录，点击刷新显示新记录；请求计数不增加，草稿不变，
导出与显示证据一致。另覆盖失败停止和失败刷新保留旧证据。
延迟响应后切换项目仍由接线单测覆盖；新增同 owner/tab 往返的真实浏览器候选分支，待 CI。
不得复用仅在 MCP 运行后才打开 GUI 的旧 fixture 作为交叉界面证据。

后续与 #245 保存 CAS 测试精确整合后再验证完整 CI；不得把本地单测等同完整产品。
本候选没有轮询或运行中流式观察，也不保证远端业务恰好一次。

## 真实浏览器候选（待 CI）

已新增 `tests/helpers/plan-history-refresh-ui.mjs` 并接入 ui-smoke。
两条成功/失败停止旅程均在正式 MCP 执行前打开 GUI，保留请求草稿；
刷新后比较完整导出、无业务重放、仅 GET；额外真实第二 owner 配置写入后，
GUI 显式保存仍以原 configRevision 被拒，证明刷新没有偷采 CAS 权限。
模拟 503 只用于失败读取分支，主成功路径使用真实服务端和正式 MCP SDK。

2026-11-15 本地 Chromium 启动遭 socket() EPERM/SIGABRT，未执行浏览器步骤。
上述是已接线的验收候选，不是浏览器已通过；仍须 CI 实际 marker 与全部 jobs。

## 延迟 GET 的 DOM 所有权候选

基于 #246 `9c44eca4dfd28bc3bbe5610bfe70483d7e1d7962` 精确 tree
`8aef2f82098141171dd45ec92c096e515b4e7146`，仅补测试。
现有 holdRealResponse 对真实 loopback GET 先 fetch，再延迟交付原响应。
请求仍 pending 时断言按钮 disabled，原生 click 不产生第二请求；切换 Plans 再回 History，
确认原 DOM 已脱离后释放。fixture-only 监听器包装等待真正 async click handler 完结，
之后再次往返重绘证明缓存未被旧响应暗中采用。随后现有新显式刷新必须采用真实 MCP 记录，
完整导出、草稿和 CAS 拒绝、无业务重放断言保持。路由清理复用原 helper，保留主断言错误。

该监听器仅观察特定刷新按钮的 handler 完结，不替换生产响应或内部状态；
单测证明 this/event/result/rejection 均保留，无关 listener 不包装。
本地 Chromium 仍在启动时 socket EPERM，真实该分支未执行，不能当作通过。
需要 CI `PLAN_HISTORY_REFRESH_HELD_BROWSER_PASS` 及原浏览器 marker/全部 jobs 才能确认。
