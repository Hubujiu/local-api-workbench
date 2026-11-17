# Apipost 单机版 2.0：公开功能与 Local API 逐项对照

核对时间：2026-10-17。被比较实现固定为提交 d383014e2ab8d6d70d7ba7c88cdb8ba131f14249。

## 结论

当前实现是可运行的独立候选版，尚不是完整复刻。此前以若干核心工作流和 CI 通过作为交付依据，不能覆盖原版全部公开能力。本轮仅分析对比，不把缺失项改写成已完成。

官网 2.0 MCP 专页明确列出 30 个工具，旧 help/mcp 页只列 5 个，存在文档版本差异；以更新日志及 2.0 专页补全范围。现有实现最多暴露 9 个工具；按能力映射，10 项基础能力可对应，2 项部分对应，18 项缺失。工具可以合并，因此这不是简单的 9/30 完成率。

本表“已实现”仅表示公开描述的基础能力有对应代码/测试，不表示逐像素、所有参数、所有错误语义或原版 SDK 完全兼容。只在截图看到的菜单，标记其存在，不编造其隐藏规则。官网没有详细说明的协议、数据库品类等保留待核实，不把 SaaS 全量功能自动算入单机版。

## 计数（不同章节存在交叉，禁止相加计算总完成率）

- F：51 项；已实现 15，部分实现 21，缺失 12，行为不同 2，待核实 1
- M：30 项；已实现 10，缺失 18，部分实现 2
- U：14 项；部分实现 11，缺失 3
- X：3 项；明确排除 3

## UI 风格提取

- 浅色：低饱和米白/奶油底、暖棕金强调色、暖灰文字、很细的分隔线，少阴影、小圆角。不是大卡片营销站风格。
- 深色：近黑的暖棕底与浅金按钮，仍保持暖色；当前冷灰深色主题有明显差异。
- 布局：细图标栏 → 项目树/设置二级导航 → 主编辑区，顶栏、请求标签、操作栏紧凑叠放；请求/响应纵向分割。
- 信息语义：方法颜色区分；状态蓝点；AI变更橙色；失败红色。AI高亮是有数据来源的功能，不只是配色。
- 控件：参数标签、Body横排radio、发送/保存下拉、边侧参数助手、可展开编辑区；不能只保留相同文字就算UI一致。
- 原创Logo与名称继续保留，原版品牌/授权信息不复制。

## A. 产品功能逐项对照

| ID | 功能 | 状态 | 原版公开要求 | 当前实现 / 差距 | 来源 | 代码/证据 |
|---|---|---|---|---|---|---|
| F01 | 本地运行、无云账号 | 已实现 | 接口、记录和文档留在本机；断公网可运行 | 桌面包内置运行时，源码安装依赖时需联网 | S1 | src/server.mjs; desktop/main.mjs; desktop-smoke |
| F02 | 项目创建及自选目录 | 已实现 | 默认目录或用户自选位置 | 可创建项目、自选目录并注册位置 | S4 | Store.create; desktop choose-directory; runtime.test |
| F03 | 打开项目位置 | 已实现 | 顶栏打开当前目录 | 桌面打开文件所在目录；浏览器提供路径 | S4 | desktop/main.mjs open-project-location |
| F04 | 项目文件组织 | 部分实现 | 项目 ID 文件夹；apis 每接口一 JSON；envs/settings 分开 | 当前每项目一个 JSON，历史/定义混存；不是原版结构 | S5 | Store.file/create |
| F05 | Git 入口 | 已实现 | 打开项目终端，手动执行 Git 命令 | 打开终端/目录，不内置推送合并 | S5 | desktop/terminal.mjs; terminal.test |
| F06 | 关键词/URL 搜索 | 部分实现 | 截图有关键词/URL 与类型筛选 | 关键词/URL 搜索存在，类型筛选及树定位工具未对齐 | I1 | public/app.js renderTree |
| F07 | 目录、接口和文档树 | 部分实现 | 同一树展示目录、HTTP/SSE、Markdown 文档 | 当前树主要为 HTTP 接口；文档和协议在独立页面 | I1 | public/app.js renderTree/pageContent |
| F08 | 最近请求 | 已实现 | 截图有最近入口 | 本地最近 50 条历史，可查看证据 | I1 | Store.append; public/app.js history |
| F09 | 回收站 | 已实现 | 截图有回收站入口 | 软删除和恢复接口 | I1 | public/app.js trash; src/mcp.mjs delete |
| F10 | API 设计 | 部分实现 | 有独立设计页、接口定义及参数/响应信息 | 描述、请求 Schema、示例已做；缺完整响应 Schema/参数属性设计器 | S3 | normalizeRequest; exportOpenAPI; modePanel |
| F11 | HTTP 调试 | 已实现 | 请求方法、URL、发送、保存 | 真实 HTTP(S)，超时、取消、响应证据 | I1 | executeRequest; runtime.test |
| F12 | Header/Query/Path/Cookie | 已实现 | 截图有对应参数标签 | 可编辑键值行、开关、变量替换 | I1 | public/app.js parameter editors; runtime |
| F13 | 请求体类型 | 已实现 | none/form-data/urlencoded/binary/msgpack/raw | 实现相应模式；原版选项布局尚不同 | I1 | runtime.test; MessagePack byte vectors |
| F14 | 认证 | 部分实现 | 截图有认证入口，MCP详情包含鉴权 | Basic/Bearer/API Key/Digest/OAuth2存在；官方未完整列出类型，不能称完全覆盖 | S7 | digest/oauth/runtime tests |
| F15 | 请求协议版本选择 | 缺失 | 截图有 http/1.1 下拉 | 无协议版本选择，无 HTTP/2 实现 | I1 | request row; src/connection.mjs |
| F16 | 基于 Schema 生成请求数据 | 部分实现 | 截图有生成按钮 | 基础 schema 样例生成存在；复杂约束覆盖未完整验证 | I1 | sampleFromSchema; core.test |
| F17 | 参数助手 | 缺失 | 编辑区右侧有参数助手 | 没有对应抽屉/帮助工作流 | I1 | public/app.js |
| F18 | 响应展示与日志 | 部分实现 | 实时响应、响应头、Cookie、响应示例、实际请求、控制台 | 响应/头/Cookie/请求/日志存在；响应示例放在 Mock 页，未对齐标签 | I1 | responseContent |
| F19 | 接口用例 | 部分实现 | 独立接口用例页 | 当前仅引导转为执行计划，没有独立接口用例管理 | S3 | modePanel cases |
| F20 | 一键压测 | 部分实现 | 保留压测入口，官方未公开所有参数 | 可运行有界 100 次/10并发、P50/P95、取消；高级配置与报告等同未证实 | S3 | server load; bounded-load test |
| F21 | Mock 基础 | 部分实现 | Mock 页及 Mock 服务配置 | 当前固定响应示例+索引选择，固定 JSON Content-Type | I3 | server mock route |
| F22 | 智能 Mock 匹配 | 缺失 | 配置截图有智能 Mock 匹配菜单 | 无条件匹配/规则优先级等工作流；具体原版规则还需补证 | I3 | server mock route |
| F23 | 文档与分享 | 部分实现 | 文档入口和单接口分享按钮 | 可维护文档并导出 HTML/Markdown；缺原版单接口分享流程的等价验证 | S1 | document-export.js; docs page |
| F24 | 数据字典 | 部分实现 | 文档/导航列出数据字典 | 可编辑 JSON Schema 并复制应用；缺完整可视化模型编辑和引用更新机制 | S2 | dictionary page; data-use-dictionary |
| F25 | 数据库连接 | 部分实现 | 公开文档说明保留数据库连接 | SQLite/PG/MySQL只读查询已测；原版支持库种类、写入及脚本联动未公开完整 | S3 | database/remote-database tests |
| F26 | 可视化断言与变量提取 | 已实现 | 公开说明保留两项能力 | 有编辑器、断言结果、提取和步骤传递；不等于所有操作符兼容 | S2 | evaluateAssertions; runPlan; public editors |
| F27 | 接口前后置操作 | 部分实现 | 公开说明及截图有前后置操作 | 声明式操作+隔离同步脚本；原版 SDK、异步API、自定义函数不完整 | S3 | scripts.mjs; script-worker.mjs |
| F28 | 项目环境管理 | 部分实现 | 环境可查询/切换/增删改 | UI可创建/编辑变量/删除/选择，缺原版统一当前环境与服务模型 | S7 | project.environments; env UI |
| F29 | 多服务与环境地址矩阵 | 缺失 | 共享服务定义，不同环境对应不同地址 | 仅 baseUrl 普通变量，无 serviceId 或共享服务实体 | S7 | Store.create; normalizeRequest |
| F30 | 项目全局变量 | 缺失 | 与环境变量独立的全局变量 | 只有环境变量及临时调试值，没有独立全局变量层 | S7 | Store.create; execute route |
| F31 | 运行时变量查看/维护 | 部分实现 | 可读取环境变量当前运行时值 | 临时调试变量能传递/清空；缺独立查看编辑及 MCP 查询 | S7 | server debugSessions |
| F32 | 自定义函数公共资源 | 缺失 | 配置截图有自定义函数菜单 | 无项目共享函数库 | I3 | project schema; scripts |
| F33 | 状态码字典 | 缺失 | 配置截图有状态码字典 | 无对应维护界面/数据模型 | I3 | project schema |
| F34 | 接口属性 | 缺失 | 配置截图有接口属性 | 无可配置接口属性模型 | I3 | normalizeRequest |
| F35 | 接口生命周期状态 | 缺失 | 截图有开发中选择及接口状态配置 | 无接口状态字段和配置 | I1 | normalizeRequest; request toolbar |
| F36 | 导入/导出 | 部分实现 | 配置截图有手动导入与导出 | 支持OpenAPI/Postman/cURL/本工具备份；原版原生迁移不兼容 | I3 | core import/export/restore |
| F37 | 快照、重复步骤、顺序执行 | 已实现 | 计划独立快照；同接口重复；失败后继续 | 对应执行语义已实现并测试 | S9 | snapshotPlan; runPlan; plan-snapshots.test |
| F38 | 步骤参数、Cookie和脚本覆盖 | 部分实现 | 每步骤独立覆盖、可视编辑 | JSON弹窗可覆盖；缺与原版一致的细粒度步骤编辑器 | S9 | edit-step handler; snapshotPlan |
| F39 | 步骤间变量传递 | 已实现 | 提取Token/订单号供下一步使用 | 提取/脚本变量经vars传递 | S9 | runPlan; core.test |
| F40 | 接口脚本与计划脚本隔离 | 已实现 | 计划不隐式执行接口页原有脚本 | 复制步骤清除接口脚本；只执行计划明确配置的脚本 | S9 | plan-snapshots.js/test |
| F41 | 执行结果状态规则 | 行为不同 | 原版非200即失败，包括预期4xx | 当前默认2xx通过，可配置预期状态；不是原版规则 | S9 | runPlan statusOK |
| F42 | 计划说明及最近修改时间 | 缺失 | 官方计划图显示说明和最近修改 | 模型只有name/environment/createdAt/steps，无说明/updatedAt | I4 | snapshotPlan |
| F43 | 删除执行计划 | 缺失 | 官方图有删除计划按钮 | UI/MCP均没有删除计划入口 | I4 | plans page; mcp tools |
| F44 | AI修改来源及橙色高亮 | 缺失 | AI创建/更新字段和步骤标橙 | 没有字段级变更来源/高亮记录 | S9 | snapshotPlan; mcp save_plan; plans UI |
| F45 | AI执行中的即时状态 | 部分实现 | 顶栏和计划编辑器都显示AI执行状态 | 本机点击执行有busy；MCP执行缺逐步推送、统一状态反馈 | S9 | mcpLastActivity; UI polling |
| F46 | 逐步运行证据/最近50次 | 已实现 | 请求、响应、断言、日志、提取值；最近50条 | 本地保存及MCP读取；另有CLI和计划hash | S9 | runPlan; Store.append; cli.test |
| F47 | 计划/记录分栏与步骤拖拽 | 部分实现 | 计划/记录标签、左计划列表、可拖拽步骤外观 | 当前按钮列表+结果同屏，只有上移按钮，无拖拽 | I4 | plans page |
| F48 | MCP本机服务与授权 | 已实现 | 服务开关、项目授权、写入授权 | stdio/HTTP、allowlist、写入/执行授权；默认关 | S8 | createMCP; server MCP; tests |
| F49 | MCP各客户端配置 | 部分实现 | Cursor/Codex/Claude/VSCode/WorkBuddy/Trae分页复制，重新生成密钥 | 只给通用HTTP JSON及源码stdio命令；无六客户端适配页 | I3 | mcp-config handler |
| F50 | MCP重启与密钥生命周期 | 行为不同 | 截图说明客户端配置长期有效，可主动重置密钥 | 当前重启关闭HTTP MCP并撤销临时令牌；需重新配置 | I3 | createApp MCP state |
| F51 | 跨平台桌面包 | 待核实 | 官网截图展示macOS；公开平台清单未找到 | 仅Windows成品包验收；三平台core不是三平台桌面验收 | I1 | ci.yml; desktop-smoke |

## B. 官网30项 MCP 能力逐项映射

| ID | 功能 | 状态 | 原版公开要求 | 当前实现 / 差距 | 来源 | 代码/证据 |
|---|---|---|---|---|---|---|
| M01 | apipost_list_projects | 已实现 | 官网2.0公开工具能力 | localapi_list_projects | S7 | src/mcp.mjs createMCP/tools/switch |
| M02 | apipost_create_project | 缺失 | 官网2.0公开工具能力 | 无创建并授权项目工具 | S7 | src/mcp.mjs createMCP/tools/switch |
| M03 | apipost_list_apis | 部分实现 | 官网2.0公开工具能力 | 只列接口与关键词；未含文档/目录实体和目录筛选 | S7 | src/mcp.mjs createMCP/tools/switch |
| M04 | apipost_get_api_detail | 已实现 | 官网2.0公开工具能力 | localapi_get_api_detail | S7 | src/mcp.mjs createMCP/tools/switch |
| M05 | apipost_sync_openapi | 已实现 | 官网2.0公开工具能力 | localapi_sync_openapi；具体字段兼容范围另测 | S7 | src/mcp.mjs createMCP/tools/switch |
| M06 | apipost_delete_apis | 已实现 | 官网2.0公开工具能力 | localapi_delete_apis，软删除 | S7 | src/mcp.mjs createMCP/tools/switch |
| M07 | apipost_execute_api | 缺失 | 官网2.0公开工具能力 | 无单接口MCP执行工具 | S7 | src/mcp.mjs createMCP/tools/switch |
| M08 | apipost_list_environments | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M09 | apipost_switch_environment | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M10 | apipost_create_environment | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M11 | apipost_update_environment | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M12 | apipost_delete_environment | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M13 | apipost_list_environment_servers | 缺失 | 官网2.0公开工具能力 | 无共享服务模型/工具 | S7 | src/mcp.mjs createMCP/tools/switch |
| M14 | apipost_create_environment_server | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M15 | apipost_update_environment_server | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M16 | apipost_delete_environment_server | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M17 | apipost_get_environment_variables | 缺失 | 官网2.0公开工具能力 | 无变量/运行时值查询工具 | S7 | src/mcp.mjs createMCP/tools/switch |
| M18 | apipost_upsert_environment_variable | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M19 | apipost_delete_environment_variable | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M20 | apipost_get_global_variables | 缺失 | 官网2.0公开工具能力 | 无全局变量模型/工具 | S7 | src/mcp.mjs createMCP/tools/switch |
| M21 | apipost_upsert_global_variable | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M22 | apipost_delete_global_variable | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M23 | apipost_create_execution_flow | 已实现 | 官网2.0公开工具能力 | localapi_save_plan 新建 | S7 | src/mcp.mjs createMCP/tools/switch |
| M24 | apipost_update_execution_flow | 已实现 | 官网2.0公开工具能力 | localapi_save_plan 按ID更新 | S7 | src/mcp.mjs createMCP/tools/switch |
| M25 | apipost_list_execution_flows | 已实现 | 官网2.0公开工具能力 | localapi_list_plans | S7 | src/mcp.mjs createMCP/tools/switch |
| M26 | apipost_get_execution_flow | 部分实现 | 官网2.0公开工具能力 | list_plans会返回完整计划，但无按ID详情工具 | S7 | src/mcp.mjs createMCP/tools/switch |
| M27 | apipost_delete_execution_flow | 缺失 | 官网2.0公开工具能力 | 无 | S7 | src/mcp.mjs createMCP/tools/switch |
| M28 | apipost_execute_flow | 已实现 | 官网2.0公开工具能力 | localapi_run_plan；额外execute权限 | S7 | src/mcp.mjs createMCP/tools/switch |
| M29 | apipost_list_execution_runs | 已实现 | 官网2.0公开工具能力 | localapi_list_plans附带运行摘要 | S7 | src/mcp.mjs createMCP/tools/switch |
| M30 | apipost_get_execution_result | 已实现 | 官网2.0公开工具能力 | localapi_get_run | S7 | src/mcp.mjs createMCP/tools/switch |

## C. UI逐项对照

| ID | 功能 | 状态 | 原版公开要求 | 当前实现 / 差距 | 来源 | 代码/证据 |
|---|---|---|---|---|---|---|
| U01 | 整体配色 | 部分实现 | 浅米白/暖棕金；深色仍为暖黑棕金 | 浅色接近；当前深色是冷灰紫 #202125/#28282c，应调整 | I1/I2 | public/style.css |
| U02 | 主布局与密度 | 部分实现 | 约50px图标栏+297px树栏（1328px官方图），紧凑工具区 | 当前58px+256px（1440px既有CI图），按钮间距/编辑器高度不同；需同视口再测 | I1 | style.css; prior CI image仅作辅助，不是本次新视觉验收 |
| U03 | 顶栏布局 | 部分实现 | 项目居中，打开位置/刷新；右MCP状态开关 | 项目与保存按钮靠右，缺同位MCP状态开关 | I1 | public/app.js render |
| U04 | 二级配置导航 | 缺失 | 配置页左侧还有基础/Mock/公共资源/导入导出/MCP树 | 当前配置是单页卡片，没有二级导航 | I3 | pageContent settings |
| U05 | 功能入口位置 | 部分实现 | 执行计划在顶栏入口；SSE是接口树项 | 当前执行计划/协议/数据库追加到左图标栏 | I1/I4 | public/app.js navigation |
| U06 | 接口工作区标签 | 部分实现 | 设计/调试/用例/压测/Mock一组；旁边状态/名称/分享 | 主标签存在；状态/分享区域和布局不同 | I1 | modePanel/request toolbar |
| U07 | Body类型选择 | 部分实现 | 横排radio，raw后有格式下拉 | 当前为单一下拉，交互不同 | I1 | parameter editor |
| U08 | 编辑器与参数助手 | 部分实现 | 行号、当前行、展开按钮、右侧参数助手 | 有行号/JSON高亮；缺助手、展开控制和成熟编辑交互 | I1 | code-format.js; app.js |
| U09 | 发送/保存分裂按钮 | 缺失 | 按钮旁有下拉操作 | 当前普通按钮 | I1 | request toolbar |
| U10 | 空状态与底栏 | 部分实现 | 火箭插画、布局切换、精简模式、设置；授权信息 | 当前♧占位、无布局/精简切换；授权信息按范围排除 | I1 | responseContent; footer |
| U11 | 计划编辑页面 | 部分实现 | 左计划列表+右名称/说明/环境/步骤编辑器 | 当前横向计划按钮+JSON弹窗编辑 | I4 | plans page |
| U12 | AI变更视觉语言 | 缺失 | 橙色字段/步骤编号/提示条 | 无AI来源字段与视觉映射 | I4 | plans page |
| U13 | MCP配置页面 | 部分实现 | 服务状态卡片、授权区、六客户端标签、密钥操作 | 当前弹窗+通用配置展示 | I3 | mcp-config handler |
| U14 | 计划执行记录页面 | 部分实现 | 计划/执行记录独立标签，失败步骤展开 | 当前同屏原生details；信息存在但布局和交互不同 | I5 | run details markup |

## D. 排除项

| ID | 功能 | 状态 | 原版公开要求 | 当前实现 / 差距 | 来源 | 代码/证据 |
|---|---|---|---|---|---|---|
| X01 | 付款/订阅/许可证/序列号/续费 | 明确排除 | 收费与设备绑定 | 按用户要求不实现 | S10 | 用户范围 |
| X02 | 在线账号与云协作 | 明确排除 | 单机版已明确舍弃在线协同 | 不添加在线团队/账号 | S2 | 用户范围与原版定义 |
| X03 | 传统测试角色自动化模块 | 明确排除 | 原版明确舍弃；AI执行计划仍保留 | 不把这一模块与AI计划混为一谈 | S2 | 原版公开范围 |

## E. 后续补齐顺序

1. P0：环境/全局变量/共享服务数据模型；MCP缺失18项和2项不完整能力；固定输入输出契约和权限负向测试。
2. P0：计划删除、说明/修改时间、AI变更来源与实时执行状态；明确保留改进的2xx/预期4xx规则还是提供原版兼容模式，不能默默声称一致。
3. P1：独立接口用例、API状态/属性、状态码字典、共享自定义函数、智能Mock匹配。截图只证明入口存在的规则先标“待补证”，实现时公开假设。
4. P1：项目按接口/环境/配置拆文件，改进Git可审查性；保留旧格式迁移和备份兼容，不能直接破坏现有项目。
5. P1：按同视口复刻主工作台、配置二级导航、计划编辑器、Body选择器、参数助手；每页对照截图验收。
6. P2：客户端专用MCP配置、文档分享细节、数据库/脚本完整能力边界及跨平台桌面验收。

## F. 来源与证据边界

本轮在自有云浏览器重新读取官网与帮助页，并下载/查看官方浅色、深色、MCP和执行计划截图。代码检查覆盖当前本地源文件。当前实现的既有CI截图只作为辅助历史证据，未伪称本轮重新操作原版或已完成新视觉回归。官网页面不是可交互客户端；尚未公开的隐藏行为不能据此推定。

- S1: https://offline.apipost.net/
- S2: https://offline.apipost.net/help/
- S3: https://offline.apipost.net/help/basics/
- S4: https://offline.apipost.net/help/projects/
- S5: https://offline.apipost.net/help/git/
- S6: https://offline.apipost.net/help/changelog/
- S7: https://offline.apipost.net/mcp/
- S8: https://offline.apipost.net/help/mcp/
- S9: https://offline.apipost.net/help/executions/
- S10: https://offline.apipost.net/pricing/
- I1: https://offline.apipost.net/images/apipost-desktop-light.png
- I2: https://offline.apipost.net/images/apipost-desktop.png
- I3: https://offline.apipost.net/images/mcp-connection.png
- I4: https://offline.apipost.net/images/help/executions/ai-created-flow.png
- I5: https://offline.apipost.net/images/help/executions/ai-execution-record.png

- 实现：[固定提交](https://github.com/Hubujiu/local-api-workbench/tree/d383014e2ab8d6d70d7ba7c88cdb8ba131f14249)
- 既有行为测试：[7项CI通过](https://github.com/Hubujiu/local-api-workbench/actions/runs/39038506234)。它只验证已写验收，不证明本表缺项已经完成。
- 原版图片只作为对照来源引用，不作为本产品可再分发的品牌素材。
