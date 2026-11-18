# SQL Server、Oracle 和达梦只读接入

主机进程按数据库分别开启预览。设置变量后重启工作台，再从数据库页选择类型。项目的手动授权与设置页中的 MCP 授权各自独立，连接密码只保存在当前进程内存。MCP 授权还要求服务已开启，且当前项目已有写项目及执行计划权限。

| 数据库 | 主机变量和值 | 连接字段与读取范围 |
| --- | --- | --- |
| SQL Server | `LOCALAPI_SQLSERVER_PREVIEW=read-only` | 主机、数据库名、账号、验证 TLS，默认端口 1433，可指定 CA。使用 `@p0` 绑定。 |
| Oracle | `LOCALAPI_ORACLE_PREVIEW=read-only` | Thin 模式、TCPS、服务名、证书 DN，默认端口 2484。可为单个连接指定 PEM 信任证书，使用 `:p0` 绑定。 |
| 达梦 DM8 | `LOCALAPI_DAMENG_PREVIEW=read-only` | 已编译的原生助手、主机名、PEM 根证书，默认端口 5236。验证全会话 TLS。双向 TLS 同时填写客户端证书链和对应私钥。使用 `:p0` 绑定。 |

Oracle 和达梦每个会话授权 1 至 16 个 `SCHEMA.TABLE`，15 分钟后自动撤销。只读 SELECT 需列出字段和限定表名。两者都支持显式比较、AND 及 ORDER BY。达梦支持字符、整数、精确十进制、二进制与 NULL，超出 1,000 行或 1 MiB 时整次读取失败。CLI 的标准输入授权及 MCP stdio 的授权文件使用相同连接字段。Oracle 使用 `serverDN`，达梦使用 `ca`，两者都使用 `relations` 字符串数组。

仓库提供[一次性实库验收工作流](../.github/workflows/enterprise-database-acceptance.yml)。维护者接受相应的开发测试条款后可手动运行，或在本仓库 PR 加上对应标签。SQL Server Developer 与 Oracle Database Free 使用 `run-enterprise-database-acceptance`，达梦开发版使用 `run-dameng-database-acceptance`。每种服务都按摘要校验厂商镜像、仅发布到回环地址，使用本次生成的凭据和测试表。结果按服务器版本和源码提交记录。

在 DM8 的双向 TLS 配置中，手动连接和 MCP 授权分别接收 `clientCert` 与 `clientKey`。证书链第一张证书须匹配未加密的 PEM 私钥。工作台校验匹配关系，通过当前原生进程的标准输入传递身份。授权列表只显示名称、连接 ID、授权表和有效期。

本机隔离环境使用厂商 2025-02-06 的 x86_64 开发镜像与独立 Docker 守护进程，DM 服务报告版本 `03134284336-20250117-257733-20132`、协议版本 32。服务启用 `ENABLE_ENCRYPT=1`，最低 TLS 为 1.2。厂商 DISQL 与工作台的只读账号都读到同一条数据，含十进制 `12345678901234567890.125` 和二进制 `00 01 FF`。归档 SHA-256 为 `d11acaca7097631675f63875d3438c7c7c28647c64329998c80eaabbd0952b37`。[达梦官方下载](https://eco.dameng.com/download/)

在一次性 Linux x86_64 环境复现时，先安装项目依赖并运行 `npm run build:dameng`。将 `DOCKER_HOST` 指向该环境的临时 Docker 守护进程，准备好厂商 tar 包，接受厂商开发测试条款后运行以下命令。脚本在回环端口 5236 启动服务，生成本次专用证书及账号，结束后移除实例和数据。

```sh
WORKBENCH_DB_TERMS=accepted bash tests/enterprise-services/run.sh --local-dameng /path/to/dm8_20250206_x86_rh6_rq_single.tar
```

已有隔离实库时也可设置 `LOCALAPI_DAMENG_REAL=1`、`LOCALAPI_DAMENG_REAL_CONFIG` 和上表的主机开关，运行 `node --test tests/dameng-real-service.test.mjs`。临时配置指向只读账号。测试表 `WORKBENCH.READ_FIXTURE` 的 ID 为 1，AMOUNT 为上述 DECIMAL(30,3)，PAYLOAD 为上述二进制。SQL Server 与 Oracle 的独立入口分别为 `tests/sqlserver-real-service.test.mjs` 和 `tests/oracle-real-service.test.mjs`。
