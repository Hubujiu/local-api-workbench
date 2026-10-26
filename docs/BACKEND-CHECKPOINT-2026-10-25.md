# 后端检查点 · 2026-10-26 14:22 UTC

本文只记录下列已核实的提交及范围，不是完整交付声明。此前更长的历史说明保留在 Git 历史和对应 ADR/PR 中，不再把历史阶段的“最新”状态混列为当前结果。

## 本轮读取的 PR 状态

PR1、PR2、PR13、PR23 均为 open draft，未合并。

| PR | 已读取的 head | 目标 |
|---|---|---|
| #1 | 88f70bb515c48b93536b28b7fe3ec780f2e150f3 | main |
| #2 | a3ffbcd00134d5846b2a8550a5d096cec9139b7f | develop |
| #13 | f075e07fcb158f7dff639292cf7babfa931547d8 | feat/protocol-text-templates |
| #23 | 2dbe12c868aa383850117a33528542e58c4972eb | feat/protocol-request-semantics |

本轮没有执行 main/develop 合并、部署、前端功能开发或原版程序运行。

## 已核实的 CI 证据

- PR1：CI40136832590，10个job成功；实际检出的测试合并提交 aca19f825ee65e923c20995d1340bba15ca8f7cc 的 tree 与 head 同为107767d4d92f69fc0b5a048d41371267fea5a568。
- PR2：CI40275759477，10个job成功；实际测试合并提交209ae2df120ac7888135e29f9afe97553a0a4cec的tree与head同为75064180086a76d80e085f8226b568f946ff310f。
- PR23：CI40333840510，10个job成功；实际测试合并提交dcc72d4da5df4c86654dda18e27ccdfef09c7ab6的tree与head同为d14e902cf978dbc8e84d4a165745a82e6609e504。
- PR13：CI40334434565，10个job成功；实际测试合并提交0e7e08665b30425943b0b56c38829b6ff24775a6的tree与head同为c325a27cb85295b2b6319de2f8516ffc0a7855a8。

CI链接格式：https://github.com/Hubujiu/local-api-workbench/actions/runs/ 后接上述编号。PR CI默认检出测试合并提交；以上源码判断来自checkout日志和Git对象tree，不能仅凭关联head或BUILD_HEAD字段推断。

上一份已核实的完整组合为3dacf4efebd645e2b8fb99ed316384a150dccb86：push CI40324535036的10个job成功，实际检出该SHA，tree9d534b5785b6f63f682fe7739bafeca6784bb2c9。它验证了此前AWS/native认证及既有后端回归，**不包含本次新增的协议模板组合，不能替代新组合验收**。

## 本次协议模板范围

PR23增加可选templateMode:variables/literal。缺省保留旧行为，只在固定端点的WS/TCP纯文本消息和SSE POST正文启用；URL、Query、Header、认证、host/port不自动替换。变量采用own标量、非递归解析，展开前执行UTF-8预算。live open固定项目环境/global私有快照，关闭后释放；不把整份私有变量表写进session GET或证据。

PR13只在原生三个raw文本入口映射上述模式。字段来源、输入与惰性档案保持；运行时握手凭据仍须显式提供。函数/表达式和未支持的协议配置拒绝。独立PR CI覆盖实际WS/TCP/SSE、HTTP/SDK冻结计划、live隔离、错误路径、记录保存及备份恢复/重启。

初始实现的空WS文本帧遗漏和环境ID迟校验已有修复及回归。组合中更严格的存储保护会拒绝旧测试构造的非法ID，因此只将该测试改为受控legacy-read故障注入；仍验证真实HTTP零连接、磁盘不变和恢复后正常执行，没有放宽生产Store。

## 新组合尚未验收

本次本地组合验证包含上述runtime/native入口与已有握手、扩展协议和MCP取消回归。另增加真实CLI子进程：临时stdin绑定→冻结执行→退出码和新落盘结果→无绑定重启拒绝→备份恢复后重新授权执行。该CLI检查不是用HTTP或SDK结果代替。

这些本地检查已通过，但新增组合仍须发布后核对自己的CI及实际代码树。此处不宣称它已经通过远端组合CI。

## 明确剩余边界

- 不新增Socket.IO/gRPC、端点或握手模板支持；不执行原版内置/自定义表达式。
- 原版WS只有静态替换链证据，TCP没有原版模板wire对照；独立fixture不是原版GUI往返证明。
- sourceDefinitionHash标识默认定义，不代表每条live send的原始模板来源；事件hash核对实际记录的数据。
- 显式发送的正文、peer echo和既有计划变量可能进入历史。项目、备份和执行证据应按敏感数据处理，不作全面脱敏保证。
- 原版目录重新打开/保存、其他协议/数据库高级配置、完整反向导出、分发签名及前端完整交付等未因此完成。没有交付百分比或全产品验收声明。
