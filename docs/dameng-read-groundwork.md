# 达梦只读适配基础与驱动阻塞

这是独立实现的 DM 只读方言编译器、严格结果合同和执行边界，不是可用的达梦 provider。
没有注册 HTTP、会话、CLI、MCP、GUI，没有默认 driver factory，没有引入或重新分发 dmdb。
未连接真实达梦数据库、未接受数据库引擎条款，未执行厂商驱动。

## 已实现

- `compileDamengRead` 接受一个显式 schema.table、明确列和别名、AND 参数比较、ORDER BY，
  重建 `SELECT TOP 1001`；值使用命名绑定，禁止函数、数据库链接、多语句和用户 SQL 片段。
- 输入为普通数据快照；连接 host、port、user、password、CA、匹配 host 的 serverName 和 TLS
  均明确提供。不接受 URL、模块、连接串、factory、重试、身份替代或额外参数。
- `runDamengRead` 默认报 verified transport unavailable；只有内部代码注入的独立已审查
  transport 可驱动执行。首先核对 transport 的证书/对端/协议回执，再取得只读事务回执，
  最后派发 SQL。回执只是适配器内部合同，并不是任意对象声称 true 就取得实际权限。
- 支持 text、exact int64、decimal text、binary 四种结果合同。拒绝 Number 数值、未知类型、
  重复/不匹配列、超过 1000 行或 1 MiB，失败不返回部分数据。
- 阶段 deadline 与撤销只要求 transport 关闭，不制造关闭回执。结果等待真正的 closed；
  未确认关闭会保持等待。独立 runner 在固定进程及其工作线程内运行，父进程将 2 秒超时
  与撤销转为进程终止，并在操作系统报告进程关闭之前不发布结果。子监督进程在父 IPC
  断开或超时时也自行终止；它不执行调用方指定的模块。该 runner 默认仍没有驱动。

## 当前官方 npm 包核验

核验日期 2026-11-18，官方文档指向 `dmdb`，当时 npm 版本 `1.0.52452`。
只在仓库外下载归档用于许可和安全审查，未安装、导入、运行或复制驱动代码。
归档 SHA-256：`1ecf5a865cd388e4ac07c27a09727d38061a8ee230c5a927fc509731d0f2d0bb`。

包内 LICENSE 标示商业、保留权利；条款 3.3 限制修改和向第三方分发。
本项目不能仅因 npm 可下载就将该归档并入 MIT 发布。需要单独确认适用的再分发许可；
本记录是工程依赖准入判断，不代替法律意见。package.json / lockfile 没有加入该包。

同一归档的 `src/driver/connection.js` 中，TLS 建连配置关闭了证书拒绝选项，
并提供空的服务器身份检查函数；安全上下文允许 TLSv1。因此当前 sslPath 配置本身不能
作为本项目要求的服务端证书和主机身份校验证据。没有通过修改该专有驱动、全局 monkey
patch 或关闭安全检查来绕过问题；本项目默认 transport 继续关闭。

## 官方 JDBC 候选核验

[Maven Central 固定版本](https://central.sonatype.com/artifact/com.dameng/DmJdbcDriver18/8.1.3.140)
的发布 POM 声明 Apache-2.0。检查的原始 JAR SHA-256 为
`9af4ff4d6ed15948507f528a18ab9b7196b3600d9169ad7998c19869031a3c6f`。
JAR manifest 标明 DAMENG 8.1.3.140，归档中未找到 LICENSE 或 NOTICE。
该 JAR 的 SSL 相关类引用 JSSE trust store 和协议选择。这是候选证据，不证明
服务器主机名校验、无明文降级或可再分发。没有执行或引入该 JAR，也没有把 Java
加入默认安装条件。实机验证须使用 [达梦官方通信加密文档](https://eco.dameng.com/document/dm/zh-cn/pm/communication-encryption.html)
配置的独立测试实例，并包含错名/非受信证书、禁用加密的负向测试。

## 后续必须实际完成

1. 选择许可可用且验证 CA/hostname/协议版本的 transport，实现无静默直连/身份替代。
   可另行评估官方 JDBC 可选 sidecar，但需核对实际 JAR 许可证、TLS 与依赖，不凭 Maven POM
   标签认定许可或安全通过，也不将 Java 运行时强加为默认安装条件。
2. 将可信驱动接入已实现的进程隔离，验证实际驱动取消时的资源关闭并完成平台分发，
   不能把进程及 factory 测试当真实网络证据。
3. 在批准的隔离 DM 实例上验证登录、对端身份、READ ONLY、参数编码、精确结果及取消。
   只读事务与语法约束不能保证触发器/视图/外部函数没有副作用，仍须最小权限和对象审查。
4. 通过上述门禁后才接授权界面、查询入口、迁移和格式往返。

测试包括惰性端口合成交换、纯编译和实际 Node 子进程取消与终止；没有真实数据库、TLS 或 Windows 验收。

来源：[官方 Node.js 编程指南](https://eco.dameng.com/document/dm/zh-cn/pm/nodejs-rogramming-guide)、
[官方事务文档](https://eco.dameng.com/document/dm/zh-cn/pm/management-affairs.html)、
[npm 固定版本归档](https://registry.npmjs.org/dmdb/-/dmdb-1.0.52452.tgz)。
