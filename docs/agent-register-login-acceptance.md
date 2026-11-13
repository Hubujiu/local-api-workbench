# 可复制验收：Agent 注册 → 返回值 → 登录

此例仅使用自动创建并销毁的本机 loopback 合成服务和临时项目，不连接真实账号服务、不导入用户项目。现有 MCP 写入和执行权限仍须由项目所有者授权；示例只给自己的临时项目授权。

从仓库根目录执行（Node 24 和已安装的项目依赖）：

```sh
node --test tests/agent-register-login.test.mjs
```

两个用例通过官方 MCP SDK 的 `localapi_save_plan` 保存计划，再调用 `localapi_run_plan`：

1. 注册返回 201 和合成 `userId`，JSON 提取器把 `$.userId` 写入 `createdUser`；登录请求使用 `x-created-user: {{createdUser}}`。真实服务端核对收到的值，返回 200。测试核对两步响应和已保存证据。
2. 注册返回 409。显式 `failurePolicy: "stop"` 要求整计划停止；服务端核对登录请求数为零。记录保留注册失败与停止位置。

计划明确设置 `statusPolicy: "assertions"`，注册步骤 `expectedStatus: 201` 并断言 201，登录断言 200。不能省略这一配置：MCP 保存计划的兼容默认是 `strict200`，单独的 201 断言不能豁免该默认。默认失败策略是继续，本例必须显式选择停止。

浏览器候选已接入 `tests/ui-smoke.mjs`，真实打开对应临时项目的执行计划及历史，核对 AI 来源标记、两个成功步骤或唯一失败步骤、快照 hash、实际导出文件与原始结果一致；浏览和导出不得重放业务请求。两个完成标记均为 `AGENT_REGISTER_LOGIN_BROWSER_PASS`，分别带 `returned-data-login` 和 `failure-stops-before-login`。这是运行后的人类可检查记录，不是原生 Electron 窗口或运行中观察的证明。浏览器用例是否通过须查看精确提交 CI；本地启动受限不能算通过。

停止不是回滚，成功 HTTP 响应也不证明任意真实业务恰好一次。此例不处理真实登录凭据、不自动重试注册或登录、不新增生产代码；完整产品交付、签名安装及三平台验收仍须单独成立。
