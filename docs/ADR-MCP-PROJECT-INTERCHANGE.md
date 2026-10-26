# MCP 项目定义导入导出（首个有界切片）

## 决策与权限

新增两个 **Workbench canonical MCP 工具**，不是原版 Apipost MCP 工具映射：

- `localapi_export_project({ projectId, format })`：读权限。
- `localapi_import_project({ projectId, format, document })`：写权限。

两者必须操作已经明确授权、存在且未归档的项目；沿用统一 allowlist 和 Store，不新增令牌权限、项目授权、`sessionProjects` 或 `remember` 语义。`execute: false` 不阻止定义导入，但导入导出不会执行 HTTP、脚本、等待任务、数据库或协议调用。后续执行仍须另有写入与执行授权。

`format` 必填且仅允许 `apipost`、`apipost-directory`，代码实际校验枚举与文档信封，不依赖仅用于发现的 JSON Schema；不接受 `auto`、OpenAPI、Postman、工作台备份或格式猜测。`document` 必须为内联普通 JSON **对象**，不接受字符串、文件路径或远端 URL。顶层参数闭合，额外的 `path`、`url`、`sync`、`clear`、`grants`、`credentials` 等字段都拒绝。目录 manifest 内的路径只是既有白名单虚拟相对键，绝不读取宿主文件。

不提供新建项目、备份恢复或清空工具；这里没有增加或变更既有 `localapi_create_project` 等工具的行为。

## 复用与结果

- 导入复用 `apipostDocument` / `isApipostDirectoryDocument` 判别和 `importIntoProject(draft, document, { sync: false })`；不复制原生格式解析器。
- 先在显式 detached draft 转换，经过现有 Store 的校验与乐观并发控制，再保存。
- merge-only 表示不清空、不按 URL 覆盖请求。再次导入可追加请求，也可能因既有环境、用例或来源 ID 冲突而拒绝；不是幂等同步。元数据合并沿用成熟导入器，不额外重定义同名冲突规则。
- 导入只返回 `{ projectId, format, imported }`。`imported` 含本次新增的 `requestIds`、`planIds`、`environmentIds`、`caseIds`、`protocolIds`、`documentIds` 数组，不回显完整项目或文档。这是资源 ID 摘要，不是所有元数据变化的差异报告。
- 导出直接复用 `exportApipost` / `exportApipostDirectory`，返回 `{ projectId, format, document }`；已有不可无损表达项仍拒绝，不降级或静默剥除。原生 JSON 的计划限制与目录的冻结 HTTP 计划规则保持原样。

**导出不是去密后的数据。** 已保存的认证字段、请求头、变量、正文、脚本等定义可能含凭据或其他敏感数据，授权读工具的 Agent 可以读到；分享前必须检查。这里不提供临时凭据参数，但不会借此更改既有文档内认证定义的校验与往返行为。

## 预算与错误

- `document` 按实际 `JSON.stringify` 后 UTF-8 字节计，最多 **4 MiB**；目录 manifest 的外层 JSON 转义也计入，而不仅是各虚拟文件的原文总量。
- 普通 JSON 图最多 **64 层、200000 个值**；拒绝非有限数、环、访问器、隐藏属性、自定义对象/数组原型和稀疏数组。目录 JSON 文本先做有界深度/结构扫描，再由既有解析器解析；不解释路径或执行代码。既有格式内部更严格限制仍生效。
- 结果按 `content[0].text` 再封装完整 JSON-RPC 后的实际 UTF-8 字节计，含 stdio 换行，最多 **8 MiB**。在 `Store.save` **之前**完成导入成功响应预算检查；导出同样在返回前检查，而不是交给后置 writer 截断。
- 为使错误响应同样有界，仅这两个工具要求 JSON-RPC ID 为有限数字或最多 **256 UTF-8 字节**的字符串；不合规 ID 返回省略 `id` 的 `-32600` 错误（符合 MCP SDK 的可选错误 ID schema，避免反射超长 ID）。字符串 ID 的 JSON 转义仍纳入完整帧预算。
- 这两个工具的工具错误文本最多 2048 UTF-16 代码单元；不让巨型未知参数名或校验消息产生超限错误帧。权限、格式、预算和验证失败后不保存。
- 不自动重试 Store 失败。提交开始前的验证失败不会修改持久项目；**磁盘提交故障不等于已回滚**。helper 原样传播 Store 错误，不吞掉类型或声称未提交。

本功能独立分支基于 native-task-export，未捎带项目提交状态（PR #17）或有界 stdio writer（PR #19）。组合时由既有 `publicProjectCommitOutcome` 投影真实 `PROJECT_COMMIT_UNCERTAIN`，必须另验 `commit_outcome: unknown`、`retry_safe: false`、恢复读取与不重试；也须另验已有 writer 的预算/队列/取消。独立 helper 的帧预检不是已完成这些组合验收的声明。

## 验证

`tests/mcp-project-interchange.test.mjs` 覆盖闭合参数与枚举、授权/归档、原子拒绝、深层及多字节超限、描述符/原型零执行、重复导入不清空、完整双层转义帧、Store 错误身份与不重试、真实 Store 并发冲突。

`tests/mcp-project-roundtrip-sdk.test.mjs` 通过官方 SDK 的真实 HTTP 和 stdio 子进程覆盖两种格式往返、读写权限、错误后状态不变、持久化/重启、其他项目隔离、导入导出零上游请求、后续单独授权的冻结计划真实执行。它不运行原版 GUI，也不扩大既有导入器支持范围。
