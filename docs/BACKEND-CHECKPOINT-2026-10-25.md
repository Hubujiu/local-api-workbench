# 后端检查点 · 2026-10-26 18:53 UTC

这是精确提交及已验证范围的检查点，不是完整产品交付声明。更早阶段的实现、RED 和修复证据保留在 Git 历史、各 ADR 与 PR 正文，不以旧绿灯替代新组合。

## 最新完整验证基线

- 组合：9194c19c3350fd025676ee4fe9c65899d7cba8a4。
- Tree：a4a4c75dcba4d6698c65b4abfaa6ff2b6e822b2c，与本地53e3d064e8eef8fb42a2a087aa9243fc6c61a46f一致。
- Push CI：[40378404104](https://github.com/Hubujiu/local-api-workbench/actions/runs/40378404104)，首轮全部10个job成功；全部实际checkout为该SHA。
- 覆盖原生混排任务定义导出/回读、真实HTTP/MCP/CLI执行、隔离/冻结/备份恢复；MCP两种原生格式导入导出、权限边界、真实journal未知提交恢复及stdio完整转义帧限制。
- 既有真实数据库/TLS、三平台production-only stdio、脚本累计预算仍通过。测试结果不是交付百分比。
- **该基线不包含下述PR30保存收据及原生MCP结果适配。**

## 最近功能PR与精确CI

所有下列PR仍为draft，未合入main/develop，未部署。PR CI默认检出test merge，下列tree对应从checkout和Git对象核实，不只依据关联head。

| PR                  | 功能head                                 | 已核实CI与实际测试提交                                                                                               |
| ------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| #1 基础             | 88f70bb515c48b93536b28b7fe3ec780f2e150f3 | CI40136832590；merge aca19f825ee65e923c20995d1340bba15ca8f7cc，tree与head一致                                        |
| #2 CLI数据库授权    | a3ffbcd00134d5846b2a8550a5d096cec9139b7f | CI40275759477；merge209ae2df120ac7888135e29f9afe97553a0a4cec，tree与head一致                                         |
| #19 stdio错误与取消 | f31bdc83b2cf923c857514a30d76a03c7f45673a | CI40378132408成功；merge91a0df05b3ab43348aa0e405a46992e24ad8daeb，tree e2f8de578f09ffddaf20b380f57c61ad0e14fdf6=head |
| #27 有界等待诊断    | 15c75beb47c536dbc06bff02c0114b4b94999432 | CI40377823350成功；merge30dedbb8e1748165659eb4ea414079ae73225a43，tree e134ef4845f37dab702ad16d9e620eab68218d7d=head |
| #28 原生任务往返    | f9753d9db4855679b74f7787eb974170df15de89 | CI40372605965成功；merge4efd8c03e4a113b5b1effaf23a9a2d147ef5c72c，tree d104c516587154c0a699487c90b5f74c6131c36b=head |
| #29 MCP项目往返     | c25897e7bb1c71f680c826502e26621799c4f4d5 | CI40377086009成功；merge535ae58c6d4d61b8e813e2ca212b930c14b2f1e7，tree270396551bba40355e8ef273c97464bc47beaf78=head  |
| #30 执行保存收据    | a47d40b8041e96238c117b9e20d3a3792752bdb7 | tree9a06aba5c49b99369f990f967dd1f78a299eb9a8；CI40381534716进行中，不能算通过                                        |

PR1/2最后重新读取于17:53 UTC，head/test merge未变化，未重复跑旧CI。PR28临时基线仅连接PR14与PR27依赖，PR29基于PR28，PR30基于PR17；功能差异隔离，没有把新功能累积到PR1。依赖可用后才适合改以develop为目标，不自行合并。

## PR30：真实执行完成与保存结果分开

真实回环POST已收到201或200，但历史保存可在journal发布前或发布后失败。旧manual HTTP会只返回错误并丢掉实际响应；部分已有计划/协议路径把typed保存状态压成可能含路径的字符串。本片复用原执行器和Store，只改证据保存与结果投影：

- 保留实际响应、断言、脚本诊断及执行passed/failed/cancelled，不因保存错误伪造网络失败。
- attemptedRecordId标识拟写记录；recordId只在保存确认后给出。recordSaved:false不证明回滚，未知提交恢复后可能已有相同记录。
- generic与真实typed unknown/recovery分开；固定脱敏文字，不回传磁盘路径、cause、凭据。外项目typed状态不误归当前记录。
- Socket.IO缓存同一finalSnapshot/finalRecord；恢复后只有整条canonical evidence一致才确认已保存，同ID不同内容拒绝且不覆盖。重复stop只重试保存/核对，不重放网络。
- 不扩展没有持久化历史的load/direct DB read，不改变协议网络、权限或预算。

功能final已在其独立分支保存；真实prejournal/postjournal、API/MCP/plan/TCP/SIO、冲突/隔离和scope提交定向验证通过。当前本地新组合保留原取消/数据库授权/原生MCP与环境状态；原生别名补充snake_case保存收据，manual HTTP单独保留scopeCommit，避免把变量提交未知与历史保存状态混同。

本地最终29项定向组合通过，包含实际SDK native API/flow、scope未知+历史确认/未知、stdio取消时抑制响应但journal可核对同ID，以及SIO恢复/并发/冲突。**新组合仍需自己的完整CI**，不能借9194的绿灯。

## 历史失败与仍需调查的风险

- 985b955f / CI40374549274为真实RED：Windows重启第二轮后置pm.sendRequest尚未完成即到2秒wall，后续wait120尚未调度。不能由此认定native wait计时器错误。
- 确定性持有Cookie锁可复现同一签名，只证明旧日志不足，不能证明该次Windows原因。PR27增加上游接收/完成/关闭、重启轮次和fixture锁存在性诊断；没有提高预算、删除marker或放宽断言。9194和独立PR27本次通过仍不等于历史根因已修复。
- 99122与35153最终cancelled不作完整绿灯；35153各平台观察到的非法ID错误回显已在PR19真实修复。旧失败与取消证据保留，不重跑碰绿。
- 短暂执行连接中断后已核对feature c48ccaa5与tree9a06aba5仍在，未发生工作区回退；只续存中断的GitHub对象上传，不把丢失前结果冒充恢复后验证。

## 明确剩余边界

- 原生task导出仅API-local非数据库混排声明；继承origin、冻结nativeTasks、纯脚本/空canonical管线及其他无法无损表达配置仍拒绝。没有完整反向导出全部原生资源。
- MCP仅在既有授权项目中对明确apipost/apipost-directory格式merge-only导入与只读导出；没有新增restore/newproject/扩权/隐式网络执行。
- 发送前4MiB文档/8MiB转义帧预检不保证传输送达。提交后断管或队列拥塞不能推断回滚或自动重试。
- 关闭数据库连接不能证明远端SQL回滚。保存定义、备份、显式发送正文和既有运行变量可能含敏感值，不承诺所有证据自动脱敏。
- 原版GUI重新打开/保存未验证；不运行未获许可的原版，不接受尚未确认的第三方许可。不宣称原版task ID稳定或其同步等待/执行安全语义与本实现完全相同。
- 更完整的协议/数据库高级配置、原生资源往返、分发签名和前端完整交付仍未完成；本轮没有新增前端或视觉工作。
