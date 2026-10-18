# Local API Workbench 0.1.0 交付候选验收

> 本文更新至2026-10-18。可运行候选不等于完整复刻；最新提交的验收结果见 [CURRENT-PARITY.md](CURRENT-PARITY.md) 与 [迭代记录](ITERATION-2026-10-18.md)。

## 范围

独立、免费、本地优先的 API 客户端，按 Apipost 单机版公开页面与操作文档实现常用工作流。使用原创品牌和前端代码，不包含付款、许可证激活、付费 AI、云账号或团队协作；不绕过原产品授权。原站没有独立免费功能版，因此“排除付费模块”按上述边界处理。

原版未提供可直接操作的完整免费客户端，本项目不能证明所有未公开行为或每个像素完全相同。当前属于可以安装、运行和验证的独立实现，不能表述成原版源代码、原生项目文件完全兼容版或完整兼容其脚本 SDK。

## 能力与固定证据

| 能力 | 实现 | 固定验证入口 |
| --- | --- | --- |
| 项目/接口/文件夹/搜索/标签/复制/回收站/归档/恢复 | JSON 本地持久化、自选目录、原子保存、配置版本冲突检查 | runtime.test.mjs、server.test.mjs、ui-smoke.mjs |
| HTTP/HTTPS | Query/Path/Header/Cookie，JSON/raw/form/file/binary/MessagePack，Basic/Bearer/API Key/Digest/OAuth2/OAuth1 HMAC/AWS SigV4/Hawk/EdgeGrid | runtime.test.mjs、connection.test.mjs、digest.test.mjs、oauth.test.mjs |
| 网络边界 | 超时/取消、8 MiB 请求响应上限、压缩响应、自定义 CA、客户端 PEM、HTTP(S) CONNECT 代理 | runtime.test.mjs、connection.test.mjs |
| 导入/导出 | OpenAPI JSON/YAML、本地递归引用、Postman、cURL Bash、有限Apipost公开JSON、备份恢复、独立 HTML/Markdown 文档 | core.test.mjs、document-export.test.mjs、ui-smoke.mjs |
| API 设计 | 描述、请求 Schema、响应示例、数据字典、loopback Mock | core.test.mjs、server.test.mjs、ui-smoke.mjs |
| 断言/提取/脚本 | 可视化规则、全局/环境/运行时/本请求变量、隔离 QuickJS 同步脚本与CryptoJS/Chai、日志 | scripts.test.mjs、server.test.mjs、core.test.mjs、ui-smoke.mjs |
| 执行计划 | 独立请求快照、重复步骤、顺序执行、失败继续、hash、逐步证据、最近 50 次 | core.test.mjs、plan-snapshots.test.mjs、cli.test.mjs、server.test.mjs、ui-smoke.mjs |
| 用例与压测 | 独立接口用例与执行计划、最多 100 请求/10 并发的有界压测 | core.test.mjs、server.test.mjs |
| 协议 | WebSocket/TCP 交互、SSE 接收；最长 15 分钟、8 MiB、最近 200 消息 | protocols.test.mjs、protocol-sessions.test.mjs、ui-smoke.mjs |
| 数据库 | SQLite/PostgreSQL/MySQL 只读查询、参数化、行数/时间限制 | database.test.mjs、remote-database.mjs、desktop-smoke.mjs |
| MCP | stdio 与可选 HTTP、显式项目 allowlist、独立读写/执行权限、同步 OpenAPI 稳定 ID | mcp.test.mjs、server.test.mjs、ui-smoke.mjs |
| 桌面与 Git 入口 | Windows x64/macOS arm64/Linux x64 Electron成品包、自选项目位置、打开目录/终端、关闭未保存提示 | desktop-smoke.mjs、terminal.test.mjs |
| 可视界面 | 浅色/深色、紧凑布局、编辑器行号/JSON 高亮、响应/日志/历史 | code-format.test.mjs、ui-smoke.mjs 的截图/视频/trace |

CI九项：Linux/macOS/Windows核心测试、真实Chromium测试、真实PostgreSQL/MySQL服务测试、格式/依赖/构建资源审计、三平台实际打包程序启动测试。测试访问本地临时fixture，不使用用户业务账号或压测第三方服务。macOS仅CI临时签名；未经Developer ID签名或公证。

## 安装与数据

1. 打开PR #1已验证成功提交的Actions，根据平台下载LocalAPI-Windows-portable、LocalAPI-macOS-portable或LocalAPI-Linux-portable。必须核对运行关联的提交；不能以旧版本绿灯替代最新失败版本。
2. 完整解压：Windows运行LocalAPI.exe；macOS/Linux先解开内部tar.gz以保留执行权限和符号链接，再运行LocalAPI.app或LocalAPI。先核实仓库来源及build-manifest.json中的提交和SHA256。若系统阻止未签名程序，应由用户自行决定，自动操作不会绕过安全提示。
3. 默认桌面数据位于 Electron userData/projects；可以在项目界面选择单独目录。
4. 源码方式：Node.js 24，npm ci，npm start，使用终端打印的带一次启动令牌的本地链接。安装依赖需要联网，之后运行无需云服务。
5. 项目备份、历史、脚本输出和导出文件可能包含凭据或业务数据。发送、提交 Git 或分享前自行检查。恢复备份前建议导出当前项目。

## 明确限制

- 不解析或声称兼容 Apipost 专有原生目录格式；使用通用 OpenAPI/Postman/cURL 或本工具备份迁移。
- 原站脚本 SDK 的完整兼容未实现。支持范围见 README：同步 apt/pm 变量、response、test/expect、console；无任意 npm、文件或额外网络请求。
- cURL 导入不执行 shell、不自动读取 @file，也不支持 -L 自动重定向；不支持的选项显式报错。
- cURL 导出是 Bash 语法，非 cmd.exe/PowerShell 语法；会包含解析后的变量与凭据，不执行前后置脚本。二进制、MessagePack、文件上传或内联证书需单独组织文件，界面会明确拒绝不完整导出。
- 外部 OpenAPI 引用不自动联网下载；本地引用保留。远程文档分享采用用户自行分发 HTML/Markdown，不提供公共托管服务。
- 新建UI/MCP执行计划默认strict200，非200即失败；既有计划保留显式assertions策略，避免改写已保存的预期错误场景。
- Git 入口只打开项目位置与终端，用户执行自己的 Git 命令；不会自动提交/推送含密钥的项目。
- 数据库只读事务不能保证用户自定义数据库函数没有外部副作用；只连接可信数据库。
- TLS 证书验证不可关闭。MCP默认禁用；用户显式选择时可持久化本机配置及授权，端口冲突时关闭MCP。HTTP服务只监听loopback。
- 未完成签名、公证、商店发布、自动更新、跨机器同步和生产负载认证；不把 CI smoke 等同于所有人工边界验收。

## 验收状态

最近已全绿检查点eb2935b9e5031e44cbc7f91b416072a6a74b3a5e：175项核心测试、9项CI通过，Actions39113795792。此前Windows CLI偶发失败未重现但原因未确认，诊断保留。后续新增功能须独立验收。未合并main，未部署。
