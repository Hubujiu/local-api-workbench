# 当前复刻进度（增量核验）

本文件补充 2026-10-17 的冻结基线 PARITY-AUDIT.md / parity-matrix.json。原基线不改写，避免把新增实现伪装成此前已有。

## 最新检查点

fc89867af4f789ae032d293770a471147903e9be 在 Actions 39088044728 全部 7 项通过，99 项本地核心测试。包括可视化步骤编辑、请求变更脚本助手、严格 200 可选规则、null 默认值修复与桌面启动诊断。其后的导航位置调整须独立跑 CI。

## 较早可核验版本

- 090686c97a9930dd678f4076080d2eece981642a：GitHub Actions 39087172439 全部 7 项通过；91 项核心测试，真实浏览器、Windows 打包启动、数据库集成。
- 后续提取来源及视觉修复：06f120f7d328e05964944f6c18a68476836c4ea8，本地 93 项通过，远端 Actions 39087389016 全部 7 项通过。每个后续提交仍须独立核验。
- 仍为 PR #1 / develop；未合入 main，未部署。完整复刻尚未验收。

## 相对基线已补齐的能力

| 原编号 | 新增能力 | 代码与证据 | 保留边界 |
|---|---|---|---|
| F04 | 项目 ID 目录、独立 APIs/环境/设置/计划/用例文件；旧格式迁移和写入恢复 | project-files.mjs / project-files.test.mjs | 独立格式，不兼容原版专有项目文件；非断电耐久保证 |
| F06/F07 | 类型过滤，HTTP、文档和保存的 SSE/WS/TCP 定义进入统一树 | app.js / protocol-definitions.mjs / ui-smoke.mjs | 具体树定位与原版快捷交互未完全一致 |
| F10/F18/F23 | 类型化参数与响应定义、OpenAPI 保留、响应示例标签、单接口 HTML 分享 | core.mjs / document-export.js / UI 下载校验 | 不是在线托管分享服务 |
| F15 | HTTP/1.1 与真实 HTTP/2 直连 | http2-connection.mjs / http2.test.mjs | HTTP/2 代理与 cURL 导出明确不支持 |
| F17 | 参数助手：变量、函数、请求结构、参数字典插入 | dictionary-view.js / parameter-dictionary.test.mjs / UI | 不是完整 IDE 编辑器 |
| F19 | 独立接口用例快照及执行 | cases.mjs / cases.test.mjs / UI | 与计划分开保存 |
| F21/F22 | 可开关 Mock、按条件顺序匹配、响应头与有界延迟 | mock.mjs / mock.test.mjs | 原版完整规则语义未公开核实 |
| F24 | 参数字典：类型/说明/默认值/示例/枚举、导入预览、临时捕获、内置项 | parameter-dictionary.mjs / tests / UI | 修正基线把参数字典当成 Schema 库的理解；DDL 只解析常用语法 |
| F28/F29/F30 | 环境 CRUD、共享服务与环境地址矩阵、全局变量 | environments.mjs / environments.test.mjs | 目录级服务继承未做 |
| F32–F35 | 共享函数、状态码字典、自定义接口属性、生命周期状态 | resources.mjs / resources.test.mjs / UI | 共享函数在隔离 VM 中运行，不获得系统权限 |
| F42–F44 | 计划说明、修改时间、删除、字段与步骤 AI 来源高亮 | plan-version.mjs / tests / plan-view.js | 来源由实际变更计算；不伪造 AI 执行记录 |
| F49/F50 | 客户端配置标签、密钥轮换、主动选择持久化授权 | mcp-client-config.js / mcp-config-store.mjs / tests | Trae 模板未实际验证；没有启动外部 Agent 测试 |
| M01–M30 | 30 项公开 MCP 能力对应工具，加 4 个旧别名 | mcp.mjs / mcp-expanded.test.mjs | 名称与项目 ID 属于本工具；不声称原版参数结构逐字兼容 |

计划步骤的名称、URL、方法、参数行、Body 与脚本已新增可视化快照编辑器；94 项本地测试通过，已在 b75f80e / Actions 39087539435 通过全部 CI。

## 仍需完成或明确差异

1. UI：计划步骤高级配置、空状态和布局切换、设置分区交互仍未做到截图一致。配色、栏宽、Body radio、计划左右布局、分裂按钮已推进，但不能以 CI 绿灯代替视觉一致性。
2. 脚本：仅安全同步 SDK 子集；变量作用域、完整 apt API、异步操作不等价。外部程序、任意 npm 与宿主网络/文件权限不能隐式开放。
3. 提取变量：新增响应头、Cookie、耗时、完整文本；XML/XPath、正则及持久化环境/全局目的作用域仍缺。当前调试/计划运行变量不冒充这些作用域。
4. 数据库：SQLite、PostgreSQL、MySQL 只读查询已验证；不能把在线版更多数据库和脚本能力当成本工具已支持。
5. 执行判定：当前默认 2xx，支持显式预期错误状态；新增 strict200 可选规则与原版非 200 即失败一致；为不改变已有计划，默认仍保留旧规则。
6. 导入迁移：支持 OpenAPI/Postman/cURL/本工具备份，不支持原版专有项目格式直接迁移。
7. 跨平台：Windows 成品包已验；macOS/Linux 核心测试通过不等于对应桌面包交付。
8. 部分官方公开页面仅有名称/截图，功能边界仍需补证；未知项不会直接标成完成。

## 验收方式

固定测试代码与 CI 工作流是可复跑的执行计划；浏览器截图/录像、请求响应证据与 Windows 包均由实际运行产生。核心用例、浏览器行为、视觉审查和原版语义对照分别提供证据，不相互替代。

每个新增提交以自己的 CI 为准。本文不计算综合百分比：功能、MCP 和 UI 清单有重叠，数量相加会造成虚假的完成度。

公开依据：
- https://offline.apipost.net/
- https://offline.apipost.net/mcp
- https://offline.apipost.net/help/executions
- https://wiki.apipost.cn/docs/project_set/key_description/ （在线版补充说明）
- https://wiki.apipost.cn/docs/http_debug/set-valuable/ （在线版补充说明）
