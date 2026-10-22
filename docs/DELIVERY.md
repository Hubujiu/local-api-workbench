# Local API Workbench 0.1.0 交付候选验收

> 本文更新至2026-10-21。可运行候选不等于完整复刻；最新提交的验收结果见 [CURRENT-PARITY.md](CURRENT-PARITY.md) 与 [迭代记录](ITERATION-2026-10-18.md)。

## 范围

独立、免费、本地优先的 API 客户端，按 Apipost 单机版公开页面与操作文档实现常用工作流。使用原创品牌和前端代码，不包含付款、许可证激活、付费 AI、云账号或团队协作；不绕过原产品授权。原站没有独立免费功能版，因此“排除付费模块”按上述边界处理。

已下载官方Offline2 2.0.0安装包并完成静态互操作研究，但原版正常GUI启动被当前环境socket权限限制，尚无真实原生导出样本。本项目不能证明所有未公开行为或每个像素完全相同。当前属于可以安装、运行和验证的独立实现，不能表述成原版源代码、原生项目文件完全兼容版或完整兼容其脚本 SDK。

## 能力与固定证据

| 能力 | 实现 | 固定验证入口 |
| --- | --- | --- |
| 项目/接口/文件夹/搜索/标签/复制/回收站/归档/恢复 | JSON 本地持久化、自选目录、原子保存、配置版本冲突检查 | runtime.test.mjs、server.test.mjs、ui-smoke.mjs |
| HTTP/HTTPS | Query/Path/Header/Cookie，JSON/raw/form/file/binary/MessagePack，Basic/Bearer/API Key/Digest/OAuth2/OAuth1 HMAC/RSA-SHA1/AWS SigV4/Hawk/EdgeGrid | runtime.test.mjs、connection.test.mjs、digest.test.mjs、oauth.test.mjs |
| 网络边界 | 超时/取消、8 MiB 请求响应上限、压缩响应、自定义 CA、客户端 PEM、HTTP(S) CONNECT 代理 | runtime.test.mjs、connection.test.mjs |
| 导入/导出 | OpenAPI JSON/YAML、本地递归引用、Postman、cURL Bash、有限Apipost公开JSON、备份恢复、独立 HTML/Markdown 文档 | core.test.mjs、document-export.test.mjs、ui-smoke.mjs |
| API 设计 | 描述、请求 Schema、响应示例、数据字典、loopback Mock | core.test.mjs、server.test.mjs、ui-smoke.mjs |
| 断言/提取/脚本 | 可视化规则、全局/环境/运行时/本请求变量、隔离QuickJS脚本、受限HTTP回调与CryptoJS/Chai、子请求/断言/日志证据 | scripts.test.mjs、server.test.mjs、core.test.mjs、ui-smoke.mjs |
| 执行计划 | 独立请求快照、重复步骤、顺序执行、失败继续、hash、逐步证据、最近 50 次 | core.test.mjs、plan-snapshots.test.mjs、cli.test.mjs、server.test.mjs、ui-smoke.mjs |
| 用例与压测 | 独立接口用例与执行计划、最多 100 请求/10 并发的有界压测 | core.test.mjs、server.test.mjs |
| 协议 | WebSocket/TCP 交互、SSE 接收；最长 15 分钟、8 MiB、最近 200 消息 | protocols.test.mjs、protocol-sessions.test.mjs、ui-smoke.mjs |
| 数据库 | SQLite/PostgreSQL/MySQL/Redis/MongoDB/ClickHouse只读查询、SQLite显式DML、临时会话授权的只读前后置查询与变量联动 | database.test.mjs、remote-database.mjs、desktop-smoke.mjs |
| MCP | stdio 与可选 HTTP、显式项目 allowlist、独立读写/执行权限、同步 OpenAPI 稳定 ID | mcp.test.mjs、server.test.mjs、ui-smoke.mjs |
| 桌面与 Git 入口 | Windows x64/macOS arm64/Linux x64 Electron成品包、自选项目位置、打开目录/终端、关闭未保存提示 | desktop-smoke.mjs、terminal.test.mjs |
| 可视界面 | 浅色/深色、紧凑布局、编辑器行号/JSON 高亮、响应/日志/历史 | code-format.test.mjs、ui-smoke.mjs 的截图/视频/trace |

CI十项：Linux/macOS/Windows核心测试、真实Chromium测试、真实PostgreSQL/MySQL服务测试、格式/依赖/构建资源审计、三平台实际打包程序启动测试。测试访问本地临时fixture，不使用用户业务账号或压测第三方服务。macOS仅CI临时签名；未经Developer ID签名或公证。

## 安装与数据

1. 打开PR #1已验证成功提交的Actions，根据平台下载LocalAPI-Windows-portable、LocalAPI-macOS-portable或LocalAPI-Linux-portable。必须核对运行关联的提交；不能以旧版本绿灯替代最新失败版本。
2. 完整解压：Windows运行LocalAPI.exe；macOS/Linux先解开内部tar.gz以保留执行权限和符号链接，再运行LocalAPI.app或LocalAPI。先核实仓库来源及build-manifest.json中的提交和SHA256。若系统阻止未签名程序，应由用户自行决定，自动操作不会绕过安全提示。
3. 默认桌面数据位于 Electron userData/projects；可以在项目界面选择单独目录。
4. 源码方式：Node.js 24，npm ci，npm start，使用终端打印的带一次启动令牌的本地链接。安装依赖需要联网，之后运行无需云服务。
5. 项目备份、历史、脚本输出和导出文件可能包含凭据或业务数据。发送、提交 Git 或分享前自行检查。恢复备份前建议导出当前项目。

## 明确限制

- 不解析或声称兼容 Apipost 专有原生目录格式；使用通用 OpenAPI/Postman/cURL 或本工具备份迁移。
- 原站脚本 SDK 的完整兼容未实现。支持范围见 README：同步 apt/pm 变量、response、test/expect、console；支持有界HTTP/定时器/$.ajax回调，无任意npm或文件访问，有界Promise/await已验证，完整SDK仍未实现。
- cURL 导入不执行 shell、不自动读取 @file，也不支持 -L 自动重定向；不支持的选项显式报错。
- cURL 导出是 Bash 语法，非 cmd.exe/PowerShell 语法；会包含解析后的变量与凭据，不执行前后置脚本。二进制、MessagePack、文件上传或内联证书需单独组织文件，界面会明确拒绝不完整导出。
- 外部 OpenAPI 引用不自动联网下载；本地引用保留。远程文档分享采用用户自行分发 HTML/Markdown，不提供公共托管服务。
- 新建UI/MCP执行计划默认strict200，非200即失败；既有计划保留显式assertions策略，避免改写已保存的预期错误场景。
- Git 入口只打开项目位置与终端，用户执行自己的 Git 命令；不会自动提交/推送含密钥的项目。
- 数据库只读事务不能保证用户自定义数据库函数没有外部副作用；只连接可信数据库。
- TLS 证书验证不可关闭。MCP默认禁用；用户显式选择时可持久化本机配置及授权，端口冲突时关闭MCP。HTTP服务只监听loopback。
- 未完成签名、公证、商店发布、自动更新、跨机器同步和生产负载认证；不把 CI smoke 等同于所有人工边界验收。

## 验收状态

已核验功能提交e2b81352592a4847f48cb7abdce30893ed36aed5：367项核心测试、10项CI首轮通过，Actions39707152176。涵盖三平台核心与成品包、真实浏览器、数据库服务、生成资源与QuickJS可复现构建。后续提交须检查其独立CI，不能自动沿用此结论。未合并main、未部署。

本轮新增已验证：有界XML、嵌套目录及子树原子操作、显式开启的递归作用域、awaitable ajax与异步回调、保守allOf与引用交集样例、离线PNG/JPEG文档图片、OAuth1 OOB/PIN假服务流程。具体边界见对应ADR。OAuth未连接真实账户；图片不开放远程加载；生成器不是通用Schema求解器。

## 剩余交付缺口分类

- 实际功能缺口：完整脚本SDK和数据库高级操作/任意顺序联动、完整Faker/Mock目录、部分高级Schema和压测配置、NTLM高级部署、非OOB OAuth1流程、更多数据库与远程写操作等。SQLite 单语句显式写入的范围与验证见 ADR-SQLITE-WRITES，不等同数据库全功能。
- 互操作证据缺口：Offline2真实原生项目样本和全部隐含操作顺序尚未取得，不能声称原生迁移或所有历史格式兼容。
- 环境/分发缺口：原版正常GUI启动受限；未运行真实外部AI客户端；macOS仅临时签名，正式签名/公证未提供。
- 界面差距：保持原创品牌，主布局已按参考截图调整并验证，但没有逐像素等价结论。

以上明确区分已实现、已验证与尚未完成。测试通过说明指定契约的证据，不替代完整复刻验收。



2026-10-21 17:11 已核验：d0abac93 / Actions39707152176，363核心与10项CI通过。ClickHouse真实服务只读/精度、固定Faker别名与mockExp、数据库编辑及显式重绑定、脚本info与只读CSV迭代数据均有对应证据。保留之前ClickHouse两次差异与弹窗观测时序失败记录；后续修复没有放宽原断言或预算。
