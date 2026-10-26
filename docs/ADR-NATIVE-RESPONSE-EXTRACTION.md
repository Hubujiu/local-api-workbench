# 原生 pickVars 响应提取（开发检查点）

## 契约与证据

合法取得的 Offline2 静态 sender 模块 842216（Unicode 偏移
33593575–33600330）与 renderer 默认数据确认：`post_tasks` 中的
`{type:"pickVars", enabled:1, data:{source:"responseJson",variables:[{name,expression,type}]}}`。
`type` 为 `tempVars` / `envVars` / `globalVars`。空 expression 等于根 `$`。
项目、祖先目录与接口任务顺序拼接；路径读取当时的响应处理视图。
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
- 目标策略是：含启用 pickVars 的后置阶段失败，不提交该阶段变量并停止后续计划请求。
  此为 Workbench 更严格的安全策略，原版外层事务行为未经证实；不回滚已完成网络请求
  或已成功提交的前置阶段。禁用-only 与没有 pickVars 的旧继续执行策略不变。

## 检查点与组合边界

首批本地 3 项测试通过，含真实登录 HTTP→提取→同阶段脚本→后续 Bearer HTTP、
环境隔离、冻结后编辑、原响应/处理视图区分、完整备份恢复和重启。
本检查点仍待修复/验收后置断言失败及持久化失败的 fail-stop 边界；尚非完成交付。

不扩展原生反向导出。基线没有 PR7 惰性原生 flow 来源或 PR2 CLI DB grant collector；
组合时须显式识别/验证新类型或原子拒绝，不能把 flow API 快照惰性任务提升为执行。
完整 Workbench backup 保留来源/冻结计划，与原版导出往返不同。
