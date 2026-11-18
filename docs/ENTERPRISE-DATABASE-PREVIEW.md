# SQL Server、Oracle 和达梦只读接入

主机进程按数据库分别开启预览。设置变量后重启工作台，再从数据库页选择类型。项目的手动授权与设置页中的 MCP 授权各自独立，连接密码只保存在当前进程内存。MCP 授权还要求服务已开启，且当前项目已有写项目及执行计划权限。

| 数据库 | 主机变量和值 | 连接字段与读取范围 |
| --- | --- | --- |
| SQL Server | `LOCALAPI_SQLSERVER_PREVIEW=read-only` | 主机、数据库名、账号、验证 TLS，默认端口 1433，可指定 CA。使用 `@p0` 绑定。 |
| Oracle | `LOCALAPI_ORACLE_PREVIEW=read-only` | Thin 模式、TCPS、服务名、证书 DN，默认端口 2484。可为单个连接指定 PEM 信任证书，使用 `:p0` 绑定。 |
| 达梦 DM8 | `LOCALAPI_DAMENG_PREVIEW=read-only` | 已编译的原生助手、主机名、PEM 根证书，默认端口 5236。验证全会话 TLS。使用 `:p0` 绑定。 |

Oracle 和达梦每个会话授权 1 至 16 个 `SCHEMA.TABLE`，15 分钟后自动撤销。只读 SELECT 需列出字段和限定表名。两者都支持显式比较、AND 及 ORDER BY。达梦支持字符、整数、精确十进制、二进制与 NULL，超出 1,000 行或 1 MiB 时整次读取失败。CLI 的标准输入授权及 MCP stdio 的授权文件使用相同连接字段。Oracle 使用 `serverDN`，达梦使用 `ca`，两者都使用 `relations` 字符串数组。

仓库提供[一次性实库验收工作流](../.github/workflows/enterprise-database-acceptance.yml)。维护者明确接受开发测试条款后，可手动触发，或为本仓库 PR 加上 `run-enterprise-database-acceptance` 标签。SQL Server Developer 和 Oracle Database Free 使用固定摘要的官方镜像、仅绑定回环地址、每次生成的凭据和测试表。两个任务分别记录服务器版本和提交。

独立实库验收分别运行 `tests/sqlserver-real-service.test.mjs`、`tests/oracle-real-service.test.mjs` 和 `tests/dameng-real-service.test.mjs`。达梦验收使用 `LOCALAPI_DAMENG_REAL=1`、指向本机临时连接配置文件的 `LOCALAPI_DAMENG_REAL_CONFIG` 及上述读取开关。临时库中预置 `WORKBENCH.READ_FIXTURE` 的一条记录，ID 为 1、AMOUNT 为 DECIMAL(30,3) 值 12345678901234567890.125、PAYLOAD 为二进制 00 01 FF。账号仅需读取该表。当前本机已验证驱动构建、项目授权和查询限界。DM8 真实 TLS 套接字的协议夹具还验证了按出现顺序绑定、读回精确 BIGINT、回滚、错误 CA 和拒绝明文登录。三款真实服务的结果需按实际运行记录。
