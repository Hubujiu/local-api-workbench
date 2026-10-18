# Local API Workbench

开发中，尚未通过完整复刻验收。当前差异与最新核验版本见 [CURRENT-PARITY](docs/CURRENT-PARITY.md)，逐轮实现与 CI 证据见 [迭代记录](docs/ITERATION-2026-10-18.md)。

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

- 项目、接口、目录、搜索、复制、软删除恢复、环境变量与本地持久化
- HTTP/HTTPS 参数、认证、Cookie、JSON/raw/表单/文件/Base64 二进制/MessagePack 请求，真实响应、超时、取消、8 MiB 限制
- OpenAPI JSON/YAML / Postman / cURL 导入，项目/OpenAPI/cURL/Markdown 导出
- 接口说明、数据字典、JSON Schema 定义、响应示例与 loopback Mock
- 声明式前后置操作、断言和变量提取；固定快照执行计划、逐步结果、计划 hash 与最近 50 条运行记录
- 有界压测（最大 100 请求、10 并发），不用于未经授权的目标
- SQLite/PostgreSQL/MySQL 只读查询，MCP stdio 授权项目读写与计划执行
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
- 已创建 PR #1，多个候选版本七项 CI 全绿；最新迭代以对应提交的 CI 结果为准
- 支持本地循环 OpenAPI 引用保留，外部 OpenAPI 引用不自动拉取；文档分享采用离线 HTML/Markdown 文件。Git 入口打开本地项目位置/终端，不自动推送或合并
- SQLite/PostgreSQL/MySQL 仅提供只读查询；未提供数据库写操作。SSE/WebSocket/TCP 已实现有界采集与交互会话，最长 15 分钟、总计 8 MiB、最近 200 条消息
- 不包含付款、License 激活、在线团队/账号协同、商业 AI 服务

源文件和文档将通过一个固定开发分支的 PR 迭代；未经批准不合入 main、不部署。

## 脚本

前后置脚本运行在独立 QuickJS/WASM 工作线程中，无 Node、网络或文件 API。支持 apt.setVar/getVar、pm.environment.set/get/unset、pm.response.json/text/code、pm.test 与 pm.expect(...).to.equal(...)，以及 console.log。同步脚本 CPU 截止 250ms、VM 内存限额 16MiB、工作线程总超时 2 秒；不支持任意 npm 包或脚本内额外网络请求。

## OAuth2 与 Digest

支持 Digest MD5/SHA-256/SHA-512-256 与 auth/auth-int challenge；OAuth2 提供 client_credentials、refresh_token、授权码 PKCE S256。授权码回调地址在界面显示，需要在提供方登记。凭据只发往用户输入的 endpoint，优先使用 HTTPS；本地保存令牌前仍需用户点击保存。

HTTP MCP 可在项目配置中按需启用，默认关闭；可显式勾选跨重启保留授权、端口和密钥，不勾选时每次启动重新授权；提供单独的连接令牌、项目 allowlist 和读写/执行权限。关闭即撤销令牌。TLS 证书校验始终开启，支持自定义 CA、客户端 PEM 证书/私钥与 HTTP/HTTPS CONNECT 代理。
