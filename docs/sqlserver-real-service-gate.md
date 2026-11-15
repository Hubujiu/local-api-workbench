# SQL Server 真实服务验收入口（未执行）

本入口只补内部准备路径的真实服务门禁，不注册 provider，不代表 GUI/MCP 已支持。
不安装/下载 SQL Server、不接受厂商条款、不创建服务/账号/数据库，不自动运行 DDL 或清理。
没有合法的隔离服务与配置时保持未验，不能用合成 TDS peer 或跳过替代真实验收。

## 操作员准备

仅在已获授权、许可条件已处理的独立可丢弃 SQL Server 实例上准备。勿指向用户现有业务数据库。

1. 管理员预先创建 `localapi_gate_ro` 与 `localapi_gate_rw` 两个隔离空库。在各库执行
   `tests/fixtures/sqlserver-real-service.sql`，建立同一合成表及一行固定数据；脚本遇已有对象会拒绝，不覆盖。
2. 管理员建立专用 SQL 登录和两个库中对应用户，仅授权该表 SELECT；不要使用 sa、sysadmin、
   db_owner 或业务登录。无需提供管理员凭据给测试。先配置用户权限，再把 ro 库设为 READ_ONLY，
   rw 库保持 READ_WRITE；此状态操作由有权管理员执行，测试不执行 ALTER DATABASE。
   参考官方 [ALTER DATABASE SET](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-set-options)。
3. 服务端配置有效 TLS 证书，连接 host 必须匹配证书身份；提供对应 CA PEM。不允许关闭证书校验、
   trustServerCertificate 或明文回退。使用显式 SQL 用户密码，不使用环境身份或 Azure 自动凭据。
4. 在仓库外创建权限受限 JSON 配置文件，结构如下。字段必须换成该合成实例的实际值；不要提交该文件，
   不把凭据放入命令行或日志。两个连接必须使用相同 host 和端口（省略端口视为 1433），可使用不同受限登录：

   ```json
   {
     "disposable": true,
     "readOnly": {
       "host": "localhost",
       "port": 1433,
       "user": "gate_reader",
       "password": "REPLACE",
       "database": "localapi_gate_ro",
       "ssl": true,
       "ca": "PEM CA CONTENT"
     },
     "readWrite": {
       "host": "localhost",
       "port": 1433,
       "user": "gate_reader",
       "password": "REPLACE",
       "database": "localapi_gate_rw",
       "ssl": true,
       "ca": "PEM CA CONTENT"
     }
   }
   ```

## 显式运行

```sh
LOCALAPI_SQLSERVER_REAL=1 LOCALAPI_SQLSERVER_REAL_CONFIG=/absolute/private/gate.json node --test tests/sqlserver-real-service.test.mjs
```

默认不连接并明确 skip；显式启用但缺路径、文件不可读、配置无效或服务不可用必须失败，不能 skip。
现有连接/查询/进程预算不变，不自动重试。凭据不进入子进程 argv，内部进程路径仍使用原 IPC 合同。
测试错误只含固定阶段标签（config、permissions、read-only-direct/process、read-write），不打印服务器返回的原始错误、配置、密码或查询结果。

门禁先以真实连接核对 SELECT 权限及已列举的高权限/表写权限为零，再执行：

- READ_ONLY：真实内部编译→Tedious→查询，匹配固定列与合成行；另验证原隔离进程准备入口返回一致结果。
- READ_WRITE：真实服务必须返回 READ_WRITE。包裹真实 factory 的只观察记录器确认仅调用一次导出的
  `SQLSERVER_READONLY_PROBE`，不调用提交的 SELECT，且不发布结果、无重连。

负例是**真实适配器调用边界的应用派发证据，不是服务器审计/抓包证明**。权限检查也不是所有可能权限的
全面安全审计，操作员必须实际保持最小权限。该门禁不证明服务端取消、所有类型、跨平台、授权撤销或 provider 集成。
测试使用无 UDF/触发器的固定表，不概括为任意只读查询都没有外部副作用。

当前环境没有 SQL Server 服务/配置；本新增真实服务分支未执行。只有显式运行成功的
`SQLSERVER_REAL_READ_GATE_PASS` 才可记录这项证据；默认 skip 和配置单测不算通过真实服务验收。
