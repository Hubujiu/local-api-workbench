# ClickHouse Decimal JSON 精度合同

## 原因与修复

在 develop `88f70bb515c48b93536b28b7fe3ec780f2e150f3` 上，本地小型 HTTP 模拟服务器返回 `meta.type=Decimal(38, 19)`、原始 JSON 数值 `0.1234567890123456789`，旧 adapter 成功返回 `0.12345678901234568`。这是模拟协议缺陷复现，不是真实数据库验收。安全整数 reviver 不能防止小数舍入。

请求现在同时强制 `output_format_json_quote_decimals=1` 和已有 64 位整数字符串设置。服务器不支持该设置即返回错误，不重试为未引用数字格式。Decimal 值保持字符串，不做 Number 转换。

依据：[ClickHouse 官方格式设置](https://clickhouse.com/docs/reference/settings/formats/output-format#output_format_json_quote_decimals) 明确该选项默认关闭。已有真实 CI 镜像固定 `clickhouse/clickhouse-server:26.8.3.105-alpine`。未复制原版专有代码、引入新依赖或扩大数据库权限。

## 接受与拒绝

- 每列必须提供类型；重复列名拒绝，防止同名数据覆盖混淆类型校验。
- 支持 Decimal(P,S)、Decimal32/64/128/256(S)，以及 Nullable、Array、LowCardinality 包装，递归最多 16 层、类型文本最多 4096 字符。
- Decimal 叶子必须是普通十进制字符串（含负数、零）；精度最多 76 位，小数位不得超过声明 scale。允许少于 scale 的尾零规范化，不承诺保留原 SQL 字面量表示。
- LowCardinality 包装的验证仅有模拟协议覆盖；不据此宣称固定 CI 服务器默认接受 LowCardinality(Decimal)。真实 CI 矩阵验证 Decimal、Nullable 和 Array。
- 非 Nullable 的 null、未引用数字（包括 0）、科学计数法、缺失列、错误数组形状拒绝。
- Tuple、Map、其他复杂包装中含 Decimal 暂明确拒绝，包括空结果。不会对非 Decimal Tuple 内整数做笼统拒绝。需要将 Decimal 单独投影成支持类型；不宣称复杂类型已完整支持。
- Dynamic/JSON/Object 及含它们的包装无法从 meta 证明实际 Decimal 叶子类型，因此明确拒绝，须投影为显式类型。其他非 Decimal 类型维持原处理；有界词法扫描跳过带转义的引号文本/标识符，区分构造器、裸类型与字段名；名为 Decimal/Dynamic/JSON/Object 的普通枚举标签或 Tuple 字段不会因此被拒绝。此扫描不是完整 ClickHouse 类型解析器。
- GET 只读、SETTINGS 禁止、TLS 校验、参数转义、原响应大小和时间上限不变。

## 验证边界

`tests/clickhouse-decimal.test.mjs` 是有界 HTTP 协议模拟，覆盖精确字符串、失败路径、无回退与非 Decimal 数字隔离。`tests/clickhouse.test.mjs` 保留原 GET/TLS/参数等协议检查。

`tests/clickhouse-integration.mjs` 在现有数据库 CI 运行真实服务验收，新增 Decimal32/64/128/256 及授权、前置数据库变量、真实 HTTP、计划结果、备份/恢复/重启重新授权闭环，并验证真实只读查询错误后同阶段提取回滚、初始变量不覆盖、HTTP未发送，以及显式撤销连接后原计划拒绝且HTTP未发送。未在本地执行真实数据库或 VM 脚本测试；以新提交对应正常 CI 结果为准，不以模拟通过代替整链验收。
