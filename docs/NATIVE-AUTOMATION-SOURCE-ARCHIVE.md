# 非空原生自动化：惰性来源档案与静态清单

这是开发中的**来源保管工具**，不是原生自动化执行、导入兼容或同版本原厂往返验收。
它比复制文件多做格式识别、完整性检查和有界静态清单，但不填补 runner 语义缺口。
现代 JSON 的 `automated_testings` 与目录 `executions/flows v2` 是两个不同合同；本工具只接受前者的完整项目外壳及非空字段。

## 使用

在仓库目录中使用 Node.js 24；这些命令不需要启动服务、原厂程序或连接网络：

```sh
node scripts/native-automation-source.mjs pack original.json source-archive.json
node scripts/native-automation-source.mjs inspect source-archive.json
node scripts/native-automation-source.mjs unpack source-archive.json restored-original.json
```

输出必须是新文件。`pack` 和 `unpack` 不覆盖已有文件，创建时请求权限 0600；实际权限仍受操作系统约束。
输入是至多 4 MiB 的有效 UTF-8 JSON（可有 UTF-8 BOM），档案至多 6 MiB；结构检查上限为 100,000 个值、64 层。
`pack` 保留完整原始文件字节，而不是从解析后的对象重新生成 JSON。因此字段和数组顺序、空白、换行、BOM、未知字段、数字原始拼写、脚本和引用原值都保留。
`unpack` 先校验明确的不可执行标记、字节数、规范 base64 和 SHA-256，再写原字节。校验和检测意外损坏，**不是签名、加密或可信来源证明**。

档案包含原始项目的全部内容，可能含令牌、认证、脚本、请求与环境私密值。它和原文件同样敏感；base64 不会隐藏这些数据。不要上传、提交到版本库或分享给未获授权的人。
CLI 的标准输出只含固定字段、计数、摘要值和固定问题码，不打印来源名称、标识、地址、设置值或脚本。没有项目写入、计划创建、定时器、源文件脚本执行、数据库绑定或网络请求。

## 静态清单与限制

清单报告 automation/event 数量、根/非根父引用数量、非 API 类型数量，及以下结构观察：

- 缺失/重复 testing 与 event 标识，project/testing 所有者不一致；
- 缺少 settings 对象、非数组 event_list、非对象条目；
- API target 未出现在顶层 API 目录、父引用缺失、父链成环；
- 非数字 sort，以及同父事件按保存数组顺序观察到的 sort 非严格递增。

这些是**问题观察而非修复或合法性判定**。清单不排序、不重编号、不补父引用、不改 enabled，不把 live API 变成冻结请求，也不映射 settings 或 frequency。
有问题的源文件仍可保管并逐字节恢复，便于未来带证据迁移。没有问题也始终显示 `execution: unsupported`、`sourceVersion: unverified`、`semantics: not-validated`。
清单使用标准 JSON 解析视图；重复对象键按 JSON.parse 的末项视图观察，但原始字节仍完整保留。这不是全 JSON 唯一键校验或原厂版本识别。

本档案有独立 `workbench-native-automation-source-v1` 标记，普通导入与手动预览明确拒绝它，即使混入 API 项目标记；恢复出的非空原始 JSON 仍被普通导入拒绝。只有将来独立证实并实现对应语义，才可另行引入迁移能力，不能把解包当作执行授权。

## 依据和本次验证范围

参见 [现有静态证据](NATIVE-AUTOMATION-STATIC-GAPS.md) 和 [语义验收边界](native-automation-semantic-acceptance.md)。已有公开非空项目记录有 1 项、7 个根 API 事件，但没有已证同版本原厂运行、排序冲突、设置/调度和父依赖装配合同。本工具不复制第三方原始 fixture 或实现，不据此猜 runner 行为。

`tests/native-automation-source-archive.test.mjs` 使用独立编写的虚构 fixture，覆盖未知字段、BOM/CRLF 精确保留、静态身份/引用/环/顺序诊断、校验损坏、大小和深度限制、访问器/Proxy 拒绝、真实 CLI 三步、拒绝覆盖及普通导入/手动预览仍关闭。
原有非空 automation 拒绝套件仍是 owner/MCP 行为门禁；本工具的成功不能抵消该功能未实现。

本轮重新核对公开固定提交的树：第三方 `transcription-service` 的既有 fixture blob
仍为 `6eb1e120cfc2cba9b6cd1a40f8a999f439357018`（55,447 字节），没有复制其文件。
重新只读 EchoAPI 固定提交的 `src/extension/utils.ts:587–622`，仍是文件夹 API 展平为根事件，
不能证明 saved `automated_testings` 的构图。
官方[单机 AI 执行计划说明](https://offline.apipost.net/help/executions/)描述 HTTP 快照、串行继续执行、仅步骤脚本；
官方[8.2.7 更新日志](https://wiki.apipost.cn/docs/changelog/)则声明用例和测试场景导入。
这进一步要求区分产品线和版本；两页都不提供此来源档案的原厂格式认证，不能据功能描述推定磁盘序列化合同。
