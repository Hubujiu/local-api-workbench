# 显式 PostgreSQL 单条写入

## 范围与授权

默认查询仍只读。只有手工数据库面板勾选“仅本次允许 PostgreSQL 写入”并确认目标主机、端口、数据库、用户及 SQL 后，才发送 allowWrite=true。取消不发送请求；切换提供方或 TLS 重置勾选；完成或失败后重置。服务端继续要求本机令牌、合法 Origin 和布尔授权标识，并要求显式主机、用户、数据库。凭据仅用于本次连接，不持久化。

只读会话、脚本前后置数据库操作、CLI 和 MCP 不因此获得数据库写权限。MySQL 和其他远程提供方仍只读，不能假设所有 MySQL 存储引擎都能回滚。

## 支持子集与边界

- 仅单条 INSERT / UPDATE / DELETE，可使用绑定参数；最多 50,000 字符 SQL、1,000 个参数及 1MiB 参数 JSON。
- 不支持 WITH 开头、DDL、CALL、自定义 RETURNING、SQL 注释、美元引号或反斜杠转义。后几项应改用绑定参数；普通引号与双写引号可用。该保守检查不是完整 PostgreSQL 语法解析器。
- SQL 引号和括号必须配对，括号最多 32 层；禁止尾部分号后还有内容，防止逃逸外层计数查询。
- 在 BEGIN READ WRITE 中执行计数 CTE：用户 DML 后接 RETURNING 1，仅返回服务端 count，不把任意行载荷拉入 Node 内存。驱动强制 extended 协议，参数为空也不允许多命令批次。
- 最多 1,000 个目标返回行；超过、计数无法验证或查询错误时回滚。仅收到 COMMIT 成功确认才返回 committed=true。查询和连接原时限保持，不自动重试。
- 这不是所有副作用的总行数限制：触发器额外修改不计入目标行数，序列增长与外部函数副作用不保证回滚。界面明确警告。提交响应丢失时结果可能不确定；回滚未确认也不宣称成功回滚，先核实数据，禁止盲目重放。
- TLS 开启时仍强制证书校验，允许提供 CA，不允许关闭验证。

## 同步修复只读批次边界

旧 PostgreSQL 查询在参数为空时可能进入 simple 协议。现将只读查询也固定为 extended 协议，避免手工 SQL 通过多命令结束 READ ONLY 事务再执行写入。保留只读事务和原查询预算；不把只读返回限制称为任意 SQL 的通用资源沙箱。

## 固定验证

- tests/postgres-write.test.mjs：显式授权与目标、引用/括号/批次逃逸、严格 TLS、计数边界、提交/回滚失败、无自动重试，以及只读协议的先失败回归。
- tests/remote-database.mjs：CI 专用 PostgreSQL 服务，经真实 HTTP 路由完成授权拒绝、参数化写入/更新/删除、1000 行边界、1001 行回滚和只读批次逃逸拒绝；专用表自动清理，不使用用户数据库。
- tests/ui-smoke.mjs：切换提供方清除授权，确认目标及风险提示，取消后零数据库请求，MySQL 不展示写入授权。浏览器本身不冒充真实 PostgreSQL 成功执行，成功执行证据来自独立真实服务测试。
- dde1ea720242bb9dda15eae985563fa05a7146b6 已通过402项核心回归及全部10项CI，包含真实数据库 HTTP 验证和浏览器取消路径：[Actions 39743195242](https://github.com/Hubujiu/local-api-workbench/actions/runs/39743195242)。
- 后续界面补充：切换提供方或 TLS 清空旧结果，避免把前一个数据库的成功结果当成当前结果；执行期间锁定提供方与 TLS 并防止重复触发。门控真实 SQLite 请求验证等待期间控件锁定，完成后恢复；PostgreSQL 面板另有截图。后续改动以其独立CI为准。

## 依据

PostgreSQL 17 官方文档：[数据修改 CTE](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-MODIFYING)、[BEGIN](https://www.postgresql.org/docs/17/sql-begin.html)。驱动 extended 分支另经已安装 pg 的 lib/query.js 检查与真实服务测试覆盖。
