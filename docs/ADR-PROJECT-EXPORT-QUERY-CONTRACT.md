# 项目导出查询参数的封闭契约

## 问题与兼容边界

GET `/api/projects/:id/export` 原先将不认识的 `format` 当成完整项目备份。
这不是 owner 认证绕过，但调用方误写格式或尝试单环境导出时，可能获得并误分享完整项目，包括其他环境和请求凭据。

本次只收紧该 owner HTTP 入口的查询参数，不增加 Postman 导出能力，也不改变导出文档结构、MCP、选择导出或权限。

- 不传 `format` 和显式 `format=native` 保持原有完整项目备份，包括凭据。它们不是脱敏或可公开分享的定义文件。
- 历史格式 `apipost`、`apipost-directory`、`openapi` 保持原有导出器及其拒绝边界。
- 显式空、未知或重复的 `format` 拒绝，即使重复值相同。按 URLSearchParams 解码后的名称判断重复。
- 查询参数仅允许 `format`、`modelNameMode`、`databaseMode`，每个最多一次。未知参数（包括环境、目录或资源选择范围）拒绝，不静默忽略。
- `modelNameMode=namespaced|preserve` 和 `databaseMode=rebind` 仅适用于两个 Apipost 格式。省略仍保留既有默认及数据库授权重绑定边界。
- 错误为固定文字的 HTTP 400，不回显输入名称、值或项目数据。owner 认证仍先执行，无凭据请求为 403。
- 此处未实现单环境导出；现有资源选择出口仍使用独立的 POST `export-preview` / `export-selection` 契约。

## 验证

`tests/project-export-query-contract.test.mjs` 使用真实 HTTP owner 服务，覆盖：
非法/重复/编码重复参数、范围误用、固定错误无 fixture 私有值、所有历史格式与选项、
缺省/native 完整备份、无 owner 认证拒绝以及项目状态不变。

测试中的所有私有值均为合成 fixture，未使用真实用户数据。
