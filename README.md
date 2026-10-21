# Local API Workbench

开发中，尚未通过完整复刻验收。当前完整逐项清单见 [PARITY-CURRENT](docs/PARITY-CURRENT.md)，差异与核验版本见 [CURRENT-PARITY](docs/CURRENT-PARITY.md)，逐轮实现与 CI 证据见 [迭代记录](docs/ITERATION-2026-10-18.md)。

本地优先的 API 工作台。独立实现，非 Apipost 官方产品，不包含其品牌素材、二进制、许可证或付费服务。以 Apipost 单机版公开操作文档和工作台布局为参考。

**交付候选版 0.1.0。功能与可验证范围见 [交付清单](docs/DELIVERY.md)，不能将公开文档范围的独立实现等同于全部专有行为或像素级一致。**

## 启动

安装 Node.js 24 LTS，首次安装依赖需联网；安装后可离线运行：

```
npm ci
npm start
```

浏览器打开终端打印的本地链接（带本次启动的访问令牌，进入页面后自动从地址栏清除）。不要分享该链接。Windows 可双击 `scripts/start.cmd`。默认数据位于启动目录 `.local-api/`；用 `LOCAL_API_DATA` 指定目录。每个项目使用独立 ID 目录，apis/envs/settings/plans/cases 分文件保存；history 默认不纳入新建项目的 Git 跟踪。写入使用事务日志恢复、项目锁与冲突检测。旧版单个 JSON 在第一次保存时迁移，原文件保留为备份。不要把包含密钥、历史或响应的运行目录提交到 Git。

桌面包装：在 `desktop/` 执行 `npm ci`、`npm start`。安装 Electron 时需要网络，运行时不需要；数据保存在 Electron userData/projects。Windows 便携包在 PR 的最新成功 Actions 运行中下载 LocalAPI-Windows-portable，完整解压后运行 LocalAPI.exe；不要只复制 exe。无需另装 Node.js。包尚未签名，若系统阻止运行，请先核对来源和 build-manifest.json，不要绕过系统安全警告。

## 已实现的核心

- 多级目录树与整棵子树原子改名/移除；可明确开启祖先参数/认证/脚本继承，默认保持精确目录，旧快照不变。
- 隔离脚本支持有界 Promise/await、HTTP、定时器、await $.ajax/异步回调、CSV/XML响应解析；所有作用域共享原运行配额。
- Schema支持常用约束、局部引用、元组以及保守的allOf交集样例；无法安全求解时明确要求example。
- 文档可插入有大小/像素限制的本地PNG/JPEG，离线HTML/Markdown保留图片；不自动加载远程图片或执行原始HTML。
- OAuth1提供显式OOB/PIN令牌申请/交换，服务必须支持该流程；临时秘密仅在内存，获取后仍需手工保存接口。


- 项目/精确目录共享前后置脚本：异步完成后再进入下一作用域、单独关闭继承、用例冻结；计划仅执行显式代码，不自动加入共享脚本。见 [顺序与隔离边界](docs/ADR-SHARED-SCRIPTS.md)。

- 项目/目录共享认证：显式作用域覆盖、none阻止上层、接口认证优先和单独关闭继承；不自动获取令牌或读取系统凭据。见 [认证继承边界](docs/ADR-SHARED-AUTH.md)。

- 项目/精确目录 Header / Query / Cookie / 表单文本：集中编辑、接口覆盖/关闭继承，新计划与用例冻结，旧快照不漂移；共享认证支持单独继承/禁用并冻结快照，共享脚本采用明确作用域次序及统一预算，执行计划不自动继承。见 [范围与优先级](docs/ADR-GLOBAL-PARAMETERS.md)。

- 项目、接口、目录、搜索、复制、软删除恢复、环境变量与本地持久化
- HTTP/HTTPS 参数、认证、Cookie、JSON/raw/表单/文件/Base64 二进制/MessagePack 请求，真实响应、超时、取消、8 MiB 限制
- OpenAPI JSON/YAML / Postman / cURL 导入，项目/OpenAPI/cURL/Markdown 导出
- 接口说明、数据字典、JSON Schema 定义、响应示例与 loopback Mock
- 声明式前后置操作、断言和变量提取；固定快照执行计划、逐步结果、计划 hash 与最近 50 条运行记录
- 有界压测（最大 100 请求、10 并发），不用于未经授权的目标
- SQLite/PostgreSQL/MySQL/Redis/MongoDB/ClickHouse 默认只读查询、显式确认的 SQLite 单语句写入，MCP stdio 授权项目读写与计划执行
- 浅色/深色工作台；无 CDN、无遥测、无内置云模型

## MCP

```
node src/mcp.mjs --project <project-id>
```

默认只读；`--write` 允许项目变更；再加 `--execute` 才能执行保存的计划。项目 allowlist 必须显式给定。不要把这些参数配置给不信任的 Agent。MCP 本身不提供 AI 推理；可供用户已有 Agent 使用。按 MCP 2025-06-18 stdio JSON-RPC 协议实现。

## 固定验收

```
npm run check
npm test
node tests/ui-smoke.mjs
```

最后一个命令需要 Playwright/Chromium。CI 重复这些固定步骤，并保留截图证据。测试只访问临时本地 fixture，不访问第三方业务服务。计划与边界见 `docs/PLAN.md`。

## 当前差距（不隐藏）

- 无公开可操作的完整原版客户端；视觉仅依据官方截图，尚未完成像素级审查
- 本地沙箱无法启动浏览器，但已在 GitHub Actions 完成基础 UI smoke；涵盖保存竞争、脚本、导入、目录/文档持久化、OAuth、SSE 与 MCP 开关
- 已创建 PR #1，多个候选版本十项 CI 全绿；最新迭代以对应提交的 CI 结果为准
- 支持本地循环 OpenAPI 引用保留，外部 OpenAPI 引用不自动拉取；文档分享采用离线 HTML/Markdown 文件。Git 入口打开本地项目位置/终端，不自动推送或合并
- PostgreSQL/MySQL 仅提供只读查询；SQLite 可逐次明确允许单条 INSERT/UPDATE/DELETE，拒绝多语句/DDL/REPLACE。SSE/WebSocket/TCP 已实现有界采集与交互会话，最长 15 分钟、总计 8 MiB、最近 200 条消息
- 不包含付款、License 激活、在线团队/账号协同、商业 AI 服务

源文件和文档将通过一个固定开发分支的 PR 迭代；未经批准不合入 main、不部署。

## 脚本

前后置脚本运行在独立 QuickJS/WASM 工作线程中，不暴露 Node、文件或任意模块。支持变量作用域、pm.request/response、pm.test/Chai、CryptoJS、apt.assert与console.log。新增有界pm.sendRequest(config, callback)：最多10次、同时4次，仅HTTP(S)，单请求1500ms、请求64KiB、响应256KiB；支持回调（含async回调）或省略回调取得Promise，并支持顶层await。只有真实接口前后置脚本启用网络，纯函数预览/动态值/正则提取不启用。累计脚本运行预算250ms（墙钟时间，不含网络等待）、VM内存16MiB、整个工作线程仍限2秒。子请求及失败证据保留在计划记录中。

支持有界 setTimeout/clearTimeout（单次0–1000ms，累计100次/同时32次）及 done 回调断言；定时器与HTTP共同等待完成，不延长总截止时间。支持有限 $.ajax 的 success/error/complete 回调、JSON字符串和标量表单/查询数据，沿用同一HTTP代理。支持Promise断言和定时器async回调；未处理的Promise拒绝使执行失败。async:false、$.ajax的Promise返回/async回调及setInterval仍不支持。异步执行与引擎可复现构建见 docs/ADR-PROMISE-SCRIPTS.md。具体边界见 docs/ADR-CALLBACK-ASSERTIONS.md 和 docs/ADR-AJAX-CALLBACKS.md。

## OAuth2 与 Digest

支持 Digest MD5/SHA-256/SHA-512-256 与 auth/auth-int challenge；OAuth2 提供 client_credentials、refresh_token、授权码 PKCE S256。授权码回调地址在界面显示，需要在提供方登记。凭据只发往用户输入的 endpoint，优先使用 HTTPS；本地保存令牌前仍需用户点击保存。

HTTP MCP 可在项目配置中按需启用，默认关闭；可显式勾选跨重启保留授权、端口和密钥，不勾选时每次启动重新授权；提供单独的连接令牌、项目 allowlist 和读写/执行权限。关闭即撤销令牌。TLS 证书校验始终开启，支持自定义 CA、客户端 PEM 证书/私钥与 HTTP/HTTPS CONNECT 代理。

## Cookie管理器

请求的Cookie标签可管理当前项目/环境的本机Cookie。默认关闭；开启后自动保存和发送匹配Cookie，并覆盖手工Cookie输入。本机明文存储（界面遮蔽值），Cookie库文件不进入项目导出/备份，但请求响应历史可能含Cookie，分享前必须检查；请勿将数据目录公开。调试、计划、CLI及授权MCP共享所选环境的Cookie；压测每次迭代使用隔离副本且不写回。详见 docs/ADR-COOKIE-JAR.md。

## 常用内置动态变量

URL、Header、Body等字段支持 {{$guid}}、{{$randomUUID}}、{{$timestamp}}、{{$isoTimestamp}}、{{$randomInt}}、{{$randomBoolean}} 等89种基础及英文Faker目录占位符；同名显式变量优先。脚本中用 pm.variables.replaceIn 或 apt.variables.replaceIn，后置脚本可读取刚提取的变量。参数助手可选择并插入，未知变量仍报错；不是完整Faker API、历史版本或多语言目录。见 docs/ADR-BUILTIN-VARIABLES.md。

## 数据库查询与显式 SQLite 写入

支持 SQLite、PostgreSQL、MySQL、Redis有界命令和MongoDB find。Redis输入JSON命令数组；MongoDB输入collection/filter/projection/sort/limit等JSON查询对象，结果采用Extended JSON。均不自动保存连接凭据，不提供任意脚本执行。SQLite 另提供逐次勾选并确认的单语句 DML，带事务和结果限额；超时可能结果不确定，需先查询再决定是否重试。只操作可信数据库并先备份；详见 docs/ADR-SQLITE-WRITES.md。具体限额见 docs/ADR-REDIS-READS.md、docs/ADR-MONGODB-FIND.md。

## 参数化压测

一键压测可粘贴或导入 UTF-8 CSV。首行为变量名，数据行按执行序号循环，覆盖该次执行的运行时变量，用 {{变量名}} 或 apt.getVar 读取。限64 KiB/100行/50列，不改变100次主请求和10并发上限。数据仅存在当前页面会话，不写回项目；无效CSV在发请求前拒绝。详见 docs/ADR-LOAD-DATA.md。

## 现代 Apipost JSON 导入

完整现代 JSON 可通过“导入接口到当前项目”迁移受支持的 HTTP API/目录、环境与服务地址、全局变量、生命周期状态及平级数据模型（含受支持的引用重写）。选择导入环境后再发送；Mock开关和原版自动响应校验不自动启用，接口备注明确提示。嵌套模型/自定义模型组合、非空用例/自动化测试/前后置任务或其他未支持依赖整批拒绝，不执行导入内容、不访问源服务。依据公开导出格式和原版静态资料实现，不等同于Offline2原生目录完整迁移。边界与来源见 docs/ADR-MODERN-APIPOST-IMPORT.md。

## NTLMv2（有限旧服务兼容）

认证面板支持显式用户名/密码/域/工作站的 NTLMv2，仅HTTP/1.1直连，在同一隔离连接完成握手。沿用TLS证书校验、总超时、取消和响应大小限制；不使用系统凭据、不降级NTLMv1/LM、不跨连接重放。要求MIC/EPA/通道绑定或会话签名/封装的服务，以及代理/HTTP2会明确拒绝。NTLM本身属于旧协议，请优先使用HTTPS和现代认证。保存凭据为本地明文，历史可含认证响应，请勿公开。详见 docs/ADR-NTLMV2.md。

## 脚本工具库

隔离脚本可直接使用 lodash（_）、moment 和 uuid，并支持 require('lodash') / require('moment') / require('uuid')。Moment包含英文和中文locale，不含timezone数据库；不开放任意npm模块或外部locale加载。延迟/防抖使用已有有界定时器，模板执行仍在QuickJS内。保留VM及总时限，脚本输出上限按UTF-8字节计数。版本与许可证随本地bundle固定，详见 docs/ADR-SCRIPT-UTILITY-LIBRARIES.md。

### 响应可视化

后置脚本支持 apt.visualizer.set(template, data) / pm.visualizer.set 与 clear，采用固定 Handlebars 4.7.10，在现有 QuickJS 配额内执行。响应区“可视化”展示隔离的静态表格/列表；丢弃脚本、图片、链接、用户CSS和外部资源，只加载本工具内置样式。不支持完整动态图表或旧 Visualizing API。模板/数据/输出限制及验证入口见 docs/ADR-RESPONSE-VISUALIZER.md。

### 数据库前后置操作

数据库页可明确授权本项目的临时会话连接，再在前/后执行操作中添加只读查询、参数绑定和结果变量提取。连接凭据只存应用进程内存，不随项目保存；重启后重新配置并绑定。默认没有授权，MCP/CLI/压测不自动获得权限。支持范围、顺序、撤销和验证见 docs/ADR-DATABASE-OPERATIONS.md。

ClickHouse HTTP/HTTPS只读查询支持类型化参数：数组第0项使用 {p0:String}，命名对象可用 {name:String}。默认端口8123/TLS8443，证书校验不可关闭。GET URL会包含SQL与参数，请注意数据库/代理日志；凭据仅放认证头。限制与真实服务验证见 docs/ADR-CLICKHOUSE-READS.md。
