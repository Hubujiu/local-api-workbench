# Local API Workbench

开发中，尚未完成 Apipost 全功能复刻验收。当前以后端完整流程为重点，最新已验证提交、功能边界与遗留问题统一见 [后端检查点](docs/BACKEND-CHECKPOINT-2026-10-25.md)。历史逐项清单与交付候选记录仅代表各自版本，不作为当前能力或最新验收结论。改动按功能保存在独立 draft PR，同功能修复更新原 PR；组合分支用于集成验证，尚未合入 main 或部署。

本地优先的 API 工作台。独立实现，非 Apipost 官方产品，不包含其品牌素材、二进制、许可证或付费服务。以 Apipost 单机版公开操作文档和工作台布局为参考。

历史 0.1.0 候选记录见 [历史交付清单](docs/DELIVERY.md)，旧逐项清单见 [历史功能对照](docs/PARITY-CURRENT.md) 与 [历史核验摘要](docs/CURRENT-PARITY.md)。可运行、某次 CI 通过或下面的能力列表均不等于完整复刻交付。

## 启动

安装 Node.js 24 LTS，首次安装依赖需联网；安装后可离线运行：

```
npm ci
npm start
```

浏览器打开终端打印的本地链接（带本次启动的访问令牌，进入页面后自动从地址栏清除）。不要分享该链接。Windows 可双击 `scripts/start.cmd`。默认数据位于启动目录 `.local-api/`；用 `LOCAL_API_DATA` 指定目录。每个项目使用独立 ID 目录，apis/envs/settings/plans/cases 分文件保存；history 默认不纳入新建项目的 Git 跟踪。写入使用事务日志恢复、项目锁与冲突检测。旧版单个 JSON 在第一次保存时迁移，原文件保留为备份。不要把包含密钥、历史或响应的运行目录提交到 Git。

桌面包装：在 `desktop/` 执行 `npm ci`、`npm start`。安装 Electron 时需要网络，运行时不需要；数据保存在 Electron userData/projects。候选包须对应后端检查点中已核验的组合提交，不能把单功能 PR 的产物当成完整组合。Windows 便携包从该提交成功的 Actions 运行下载 LocalAPI-Windows-portable，完整解压后运行 LocalAPI.exe；不要只复制 exe。无需另装 Node.js。包尚未签名，若系统阻止运行，请先核对来源和 build-manifest.json，不要绕过系统安全警告。

签名认证定义往返已随上一根组合 `0de7ffd1` 通过其精确提交 CI，覆盖有界 AWSv4（Header／受限 S3 Query）、Hawk、EdgeGrid 原生 JSON／目录及真实 MCP／CLI、冻结与恢复流程；导出本身不签名或发送请求。当前新增项目 TCP／WebSocket／SSE 会话终态自动保存候选，已有本地原生导入、模板快照、真实远端结束、只读 MCP 历史与恢复证据，**本候选根组合 CI 与 PR40 最终功能头独立 CI 尚待核验**。保存失败保留真实收据，只允许显式重试存储，不重放网络；显式等待后端 `app.close()` 可观察保存结果，桌面退出与信号终止尚未接入，不宣称耐崩溃保存。最新精确状态见后端检查点。

## 已实现的核心

- 多级目录树与整棵子树原子改名/移除；可明确开启祖先参数/认证/脚本继承，默认保持精确目录，旧快照不变。
- 隔离脚本支持有界 Promise/await、HTTP、定时器、await $.ajax/异步回调、CSV/XML响应解析；所有作用域共享原运行配额。
- Schema支持常用约束、局部引用、元组以及保守的allOf交集样例；无法安全求解时明确要求example。
- 文档可插入有大小/像素限制的本地PNG/JPEG，离线HTML/Markdown保留图片；不自动加载远程图片或执行原始HTML。
- OAuth1 提供显式 OOB/PIN 和有界本机回调流程，包含单次领取、取消和过期处理；临时秘密仅在内存，交换后仍须显式保存接口，不自动取得第三方账号授权。

- 项目/精确目录共享前后置脚本：异步完成后再进入下一作用域、单独关闭继承、用例冻结；计划仅执行显式代码，不自动加入共享脚本。见 [顺序与隔离边界](docs/ADR-SHARED-SCRIPTS.md)。

- 项目/目录共享认证：显式作用域覆盖、none阻止上层、接口认证优先和单独关闭继承；不自动获取令牌或读取系统凭据。见 [认证继承边界](docs/ADR-SHARED-AUTH.md)。

- 项目/精确目录 Header / Query / Cookie / 表单文本：集中编辑、接口覆盖/关闭继承，新计划与用例冻结，旧快照不漂移；共享认证支持单独继承/禁用并冻结快照，共享脚本采用明确作用域次序及统一预算，执行计划不自动继承。见 [范围与优先级](docs/ADR-GLOBAL-PARAMETERS.md)。

### 后端完整流程与范围

- **项目与往返：** 本地持久化、事务恢复、备份及受支持原生 JSON／目录定义导入导出，衔接冻结执行、再导出、恢复重启和项目隔离。不能表达的语义明确拒绝；原生交换不等于完整备份，输出身份可能重新映射。
- **请求与认证：** 支持已列明的协议、认证、超时和取消。原生两格式、Postman、OpenAPI 的明确无认证声明不会被目标共享认证覆盖。原生导出不能保留 SDK URL 对象模式时明确拒绝，不静默丢失行为；旧保存记录不猜测迁移。
- **前后置任务：** 有界脚本、等待、数据库查询、原生提取和断言可按受支持顺序混排。提取有十类来源的限定子集，断言有十一类来源、十五种比较；阶段限制、状态隔离、完成性检查及共享预算保持，不代表全量原版 SDK。
- **Mock 与数据库：** 受支持的条件 Mock 定义可导出再导入并真实调用。数据库默认只读；SQLite／PostgreSQL／MySQL 有限写入须逐次明确授权。CLI／MCP 可取得限定临时只读权限，不因此获得写权限。
- **计划与结果：** 冻结配置不随 live 修改漂移，结果记录实际执行环境，同时保留计划默认值。成功、失败、保存失败、未知提交和恢复分别保留真实证据；不把保存失败说成请求失败，也不自动重放网络操作。
- **MCP 后端：** 官方 SDK HTTP／stdio 的协商、项目及权限隔离、原生交换和冻结计划执行，与实际 CLI、持久化和恢复衔接；并非所有外部宿主客户端都已实机验收。

另外提供有界压测（最大100请求、10并发），禁止用于未授权目标；现有工作台无 CDN、遥测或内置云模型。本文不把测试数量换算成交付率，具体提交的验收仍以后端检查点为准。

## MCP

```
node src/mcp.mjs --project <project-id>
```

默认只读；`--write` 允许项目变更；再加 `--execute` 才能执行保存的计划。项目 allowlist 必须显式给定。不要把这些参数配置给不信任的 Agent。MCP 本身不提供 AI 推理；可供用户已有 Agent 使用。按 MCP 2025-06-18 stdio JSON-RPC 协议实现。

授权项目可用 `localapi_export_project` 导出、以 `--write` 使用 `localapi_import_project` 合并导入；显式格式仅 `apipost` / `apipost-directory`，内联 JSON 最多 4 MiB，不读文件、不抓取 URL、不清空或新建项目、不执行请求。导出可能包含已保存的凭据，分享前须检查。详见 [MCP 项目定义往返边界](docs/ADR-MCP-PROJECT-INTERCHANGE.md)。

## 固定验收

```
npm run check
npm test
node tests/ui-smoke.mjs
```

最后一个命令需要 Playwright/Chromium。CI 重复这些固定步骤，并保留截图证据。测试只访问临时本地 fixture，不访问第三方业务服务。计划与边界见 `docs/PLAN.md`。

## 当前差距（不隐藏）

- 原版 GUI 的当前完整流程尚未验收，像素一致性和签名发行未完成；当前不新增前端或视觉打磨。
- 独立 XML／运行时专项未完成；PR37 实验默认关闭、未进入生产组合。历史失败不因后续 CI 通过而改判，既有 Windows XML 预算超时的根因不宣称已解决。
- 全量专有行为、全部原生数据变体和所有外部 MCP 客户端未完整验证；SQL Server 等许可前提未确认的验证不冒充完成。
- 本地循环 OpenAPI 引用可保留，外部引用不自动拉取。原生定义交换无法保留的依赖、历史来源或配置明确拒绝，完整状态使用 Workbench 备份。
- SSE/WebSocket/TCP 提供有界采集与交互会话，最长15分钟、总计8MiB、最近200条消息，不代表全部协议扩展。
- 不包含付款、License 激活、在线团队/账号协同或商业 AI 服务，不绕过原版授权。

功能与修复按各自 draft PR 保存，组合验证按精确提交单独记账；未经批准不合入 main、不部署。

## 脚本

前后置脚本运行在独立 QuickJS/WASM 工作线程中，不暴露 Node、文件或任意模块。支持变量作用域、pm.request/response、pm.test/Chai、CryptoJS、apt.assert与console.log。新增有界pm.sendRequest(config, callback)：最多10次、同时4次，仅HTTP(S)，单请求1500ms、请求64KiB、响应256KiB；支持回调（含async回调）或省略回调取得Promise，并支持顶层await。只有真实接口前后置脚本启用网络，纯函数预览/动态值/正则提取不启用。累计脚本运行预算250ms（墙钟时间，不含网络等待）、VM内存16MiB、整个工作线程仍限2秒。子请求及失败证据保留在计划记录中。

支持有界 setTimeout/clearTimeout（单次0–1000ms，累计100次/同时32次）及 done 回调断言；定时器与HTTP共同等待完成，不延长总截止时间。支持有限 $.ajax 的 success/error/complete 回调、JSON字符串和标量表单/查询数据，沿用同一HTTP代理。支持Promise断言和定时器async回调；未处理的Promise拒绝使执行失败。async:false、$.ajax的Promise返回/async回调及setInterval仍不支持。异步执行与引擎可复现构建见 docs/ADR-PROMISE-SCRIPTS.md。具体边界见 docs/ADR-CALLBACK-ASSERTIONS.md 和 docs/ADR-AJAX-CALLBACKS.md。

## OAuth2 与 Digest

支持 Digest MD5/SHA-256/SHA-512-256 与 auth/auth-int challenge；OAuth2 提供 client_credentials、refresh_token、授权码 PKCE S256。授权码回调地址在界面显示，需要在提供方登记。凭据只发往用户输入的 endpoint，优先使用 HTTPS；本地保存令牌前仍需用户点击保存。

HTTP MCP 可在项目配置中按需启用，默认关闭；可显式勾选跨重启保留授权、端口和密钥，不勾选时每次启动重新授权；提供单独的连接令牌、项目 allowlist 和读写/执行权限。关闭即撤销令牌。TLS 证书校验始终开启，支持自定义 CA、客户端 PEM 证书/私钥与 HTTP/HTTPS CONNECT 代理。

## Cookie管理器

请求的Cookie标签可管理当前项目/环境的本机Cookie。默认关闭；开启后自动保存和发送匹配Cookie，并覆盖手工Cookie输入。本机明文存储（界面遮蔽值），Cookie库文件不进入项目导出/备份，但请求响应历史可能含Cookie，分享前必须检查；请勿将数据目录公开。调试、计划、CLI及授权MCP共享所选环境的Cookie；压测每次迭代使用隔离副本且不写回。详见 docs/ADR-COOKIE-JAR.md。

## 常用内置动态变量

URL、Header、Body等字段支持 {{$guid}}、{{$randomUUID}}、{{$timestamp}}、{{$isoTimestamp}}、{{$randomInt}}、{{$randomBoolean}} 等163个可选名称（含别名）的基础及英文Faker目录占位符；同名显式变量优先。脚本中用 pm.variables.replaceIn 或 apt.variables.replaceIn，后置脚本可读取刚提取的变量。参数助手可选择并插入，未知变量仍报错；不是完整Faker API、历史版本或多语言目录。见 docs/ADR-BUILTIN-VARIABLES.md。

## 数据库查询与逐次授权写入

SQLite、PostgreSQL、MySQL、Redis、MongoDB、ClickHouse 默认只读，具体命令／查询子集及参数限制见各自 ADR。SQLite／PostgreSQL／MySQL 的受限单语句 DML 须逐次明确确认，保留事务、超时、取消、锁与结果限额；结果不确定时先查证，不能自动重试。连接凭据不自动永久保存，不开放任意脚本。只操作可信数据库并先备份。详见 [SQLite 写入](docs/ADR-SQLITE-WRITES.md)、[PostgreSQL 写入](docs/ADR-POSTGRES-WRITES.md)、[MySQL 写入](docs/ADR-MYSQL-WRITES.md)。

## 参数化压测

一键压测可粘贴或导入 UTF-8 CSV。首行为变量名，数据行按执行序号循环，覆盖该次执行的运行时变量，用 {{变量名}} 或 apt.getVar 读取。限64 KiB/100行/50列，不改变100次主请求和10并发上限。数据仅存在当前页面会话，不写回项目；无效CSV在发请求前拒绝。详见 docs/ADR-LOAD-DATA.md。

## 现代 Apipost JSON 导入

现代 Apipost JSON 和 Offline2 原生目录支持各自列明的有界资源、环境、模型、用例／计划及前后置任务迁移。受支持任务保持声明顺序，并可进入冻结计划、真实执行和受支持定义往返；导入本身不执行请求、不恢复数据库凭据。请求提取仅支持前置配置快照，其中正文复用已有 JSON5 解析器并保留结构/数值/字节限制，none/精确空正文为空对象快照（不改变发送正文）；响应提取仅支持后置；未知任务、资源依赖或无法保留的语义整批拒绝。完整范围见后端检查点及对应 ADR，不代表全资源或跨版本完全兼容。

活动文档的标题、正文、目录和当前状态可进行受限原生定义往返；历史来源身份精确保留用完整备份。复用模型图支持空目录、可验证的局部/整模型引用和请求/响应关联，缺省 `modelNameMode: "namespaced"` 仍要求模型名满足当前项目名称空间的可逆条件。调用方可在 owner 导入 body、owner 原生导出 query 或 MCP 两个项目工具中显式选择 `modelNameMode: "preserve"`，使用原生 name/display_name 保留任意合法模型名，支持项目改名；导出与回读两端须分别选择，不从文件自动启用，也不存为项目设置。原样名称须为有效 Unicode、非空且最多 200 个 UTF-16 单位，冲突或超限拒绝；外部引用、跨模型子路径及不能验证的依赖拒绝。模型本身可为布尔定义，API直接布尔schema不在原生出口支持范围内。这里是静态定义转换，不代表新增schema执行能力。见 [原生出口边界](docs/ADR-NATIVE-PROJECT-EXPORT.md)。

## NTLMv2（有限旧服务兼容）

认证面板支持显式用户名/密码/域/工作站的 NTLMv2，仅HTTP/1.1直连，在同一隔离连接完成握手。沿用TLS证书校验、总超时、取消和响应大小限制；不使用系统凭据、不降级NTLMv1/LM、不跨连接重放。要求MIC/EPA/通道绑定或会话签名/封装的服务，以及代理/HTTP2会明确拒绝。NTLM本身属于旧协议，请优先使用HTTPS和现代认证。保存凭据为本地明文，历史可含认证响应，请勿公开。详见 docs/ADR-NTLMV2.md。

## 脚本工具库

隔离脚本可直接使用 lodash（\_）、moment 和 uuid，并支持 require('lodash') / require('moment') / require('uuid')。Moment包含英文和中文locale，不含timezone数据库；不开放任意npm模块或外部locale加载。延迟/防抖使用已有有界定时器，模板执行仍在QuickJS内。保留VM及总时限，脚本输出上限按UTF-8字节计数。版本与许可证随本地bundle固定，详见 docs/ADR-SCRIPT-UTILITY-LIBRARIES.md。

### 响应可视化

后置脚本支持 apt.visualizer.set(template, data) / pm.visualizer.set 与 clear，采用固定 Handlebars 4.7.10，在现有 QuickJS 配额内执行。响应区“可视化”展示隔离的静态表格/列表；丢弃脚本、图片、链接、用户CSS和外部资源，只加载本工具内置样式。不支持完整动态图表或旧 Visualizing API。模板/数据/输出限制及验证入口见 docs/ADR-RESPONSE-VISUALIZER.md。

### 数据库前后置操作

数据库页可明确授权本项目的临时会话连接，再在前/后执行操作中添加只读查询、参数绑定和结果变量提取。连接凭据只存应用进程内存，不随项目保存；重启后重新配置并绑定。默认没有授权，MCP/CLI/压测不自动获得权限；CLI/MCP 可分别显式获得限定临时只读权限，凭据不随项目备份恢复。支持范围、顺序、撤销和验证见 docs/ADR-DATABASE-OPERATIONS.md。

ClickHouse HTTP/HTTPS只读查询支持类型化参数：数组第0项使用 {p0:String}，命名对象可用 {name:String}。默认端口8123/TLS8443，证书校验不可关闭。GET URL会包含SQL与参数，请注意数据库/代理日志；凭据仅放认证头。限制与真实服务验证见 docs/ADR-CLICKHOUSE-READS.md。

### Apipost Faker 占位符

支持已列明的 $fakerjs.Company.name、$fakerjs.Internet.displayName/password 等固定无参数路径，并提供沙箱内 mockExp(text)。沿用英文Faker及原有大小/次数/执行预算，不开放任意属性路径或完整Mock.js语法。完整可选名单由参数助手展示，具体兼容范围见 docs/ADR-APIPOST-FAKER-ALIASES.md。

### 脚本执行上下文

apt.info / pm.info 提供实际脚本阶段、请求ID/名称与迭代编号；普通调试为0/1，压测使用真实迭代和CSV行。apt.iterationData / pm.iterationData 支持只读 has/get/toObject/replaceIn，不能修改测试数据。原变量优先级和脚本配额不变，见 docs/ADR-SCRIPT-EXECUTION-CONTEXT.md。
