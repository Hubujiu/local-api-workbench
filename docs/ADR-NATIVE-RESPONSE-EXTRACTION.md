# 原生 pickVars 响应提取

## 契约与证据

合法取得的 Offline2 静态 sender 模块 842216（Unicode 偏移
33593575–33600330）与 renderer 默认数据确认：`post_tasks` 中的
`{type:"pickVars", enabled:1, data:{source:"responseJson",variables:[{name,expression,type}]}}`。
`type` 为 `tempVars` / `envVars` / `globalVars`。空 expression 等于根 `$`。
项目、祖先目录与接口任务顺序拼接；路径读取当时的响应处理视图。
来源为 send.asar/index.js 模块 842216；renderer `9269.86937a8833e2.js`
Unicode 偏移 9913 为默认数据，work 主 bundle 模块 693291 偏移 1224434 为来源枚举。
来源包 SHA256 与合法来源记录见 `ORIGINAL-OFFLINE2-RESEARCH.md`。
本片使用独立编写 fixture；没有原版 pickVars 真实运行证据，不声称运行等价。

## 有界实现

- 仅启用后置 responseJson，严格 JSON 对象/数组根和 own-property 单值路径。
  保留选中值的 `0`、`false`、`null`；缺失与 null 不混同。
- 不执行 JSONPath wildcard/filter/function，不回退 XML，不读响应头，不插值路径。
  禁用任务保留闭合、限额内的来源字段，但不执行、不要求路径有效。
- 任务仍在同一 QuickJS 阶段，前后 customScript 共享词法作用域。
  提取读取当前处理响应（包括先前 setBody），原始响应/状态证据保持独立。
  私有编译数据和捕获的可信解析/属性操作不赋予新的主机权限。
- 每阶段最多 16 个任务；每项提取最多 100 行/64 KiB，提取描述合计 256 KiB；
  单次任务选中结果复制最多 10,000 节点/64 层。沿用脚本运行时间/内存限制。
- 含启用后置 pickVars 的请求任一失败（包括前置阶段或网络失败）停止后续计划步骤。
  收到响应后，原始 wire 状态与全部断言、响应提取及后置脚本须成功才尝试持久化后置变量；
  失败恢复执行器内存中此前已提交的完整变量上下文（包含 runtime/hidden）。策略仅由主机规范化的冻结任务派生，
  不读取用户异常属性。禁用-only 与没有 pickVars 的旧提交/继续执行策略不变。
  Worker 的可信成功出口还核对所有启用提取已完成，不能以早退或跨任务 catch 隐藏未完成提取。
  全部提取完成后的 return 仍允许；原版静态材料未证明具备这个完成性保证。
  此为 Workbench 更严格的安全策略，原版外层事务行为未经证实；不回滚已完成网络请求、
  同一 VM 阶段中用户已执行的 `pm.sendRequest` 副作用或已成功提交的前置阶段。
- 持久化错误必须停止后续计划步骤，不自动重放已完成的登录。前置乐观并发冲突发生在写入前，
  不提交本次变量；发布 journal 后的磁盘 I/O 错误可能已部分应用，重新读取可能恢复并向前提交。
  因此内存恢复不代表磁盘回滚，`recordSaved:false` 也不证明变量未写入。
  本片不改变 Store 事务模型、不承诺网络或磁盘回滚。现有存储结果分类由对应存储模块负责。
  仅主机持久化回调的确切 `PROJECT_COMMIT_UNCERTAIN` 被投影为
  `scopeCommit:{outcome:"unknown",retrySafe:false}` 与固定提示，不传播路径、cause 或任意错误码；
  VM 伪造字段不生成该标记。独立 PR9 基线没有此存储类型，真实 journal 分类仍需组合存储层验收。

## 检查点与组合边界

`node --test tests/native-pick-vars.test.mjs` 覆盖真实登录 HTTP→提取→同阶段脚本→
后续 Bearer HTTP、并发项目/环境隔离、冻结后编辑、原响应/处理视图区分、完整备份恢复和重启。
错误矩阵含真实第二个 Store 并发写入导致的变量冲突，确认无后续计划 HTTP、磁盘保留并发写者值，
冲突时不提交本次后置变量，已成功的前置变量保留。另有真实目录 I/O 故障测试，确认
`recordSaved:false`、无后续请求且不重放登录，恢复后允许已发布 journal 的变量向前提交。
另覆盖 strict JSON/路径、标量根、断言/脚本异常、
原 wire 500 不被 setCode200 掩盖、前置/网络失败、禁用-only 旧行为、不能伪造主机策略及限额。
首个 WIP 提交中已记录的断言/持久化 fail-stop 缺口由该批次修复；CI 与组合入口验收另行记录。

不扩展原生反向导出。基线没有 PR7 惰性原生 flow 来源或 PR2 CLI DB grant collector；
组合时须显式识别/验证新类型或原子拒绝，不能把 flow API 快照惰性任务提升为执行。
完整 Workbench backup 保留来源/冻结计划，与原版导出往返不同。
