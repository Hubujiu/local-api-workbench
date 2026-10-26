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

- 启用任务仅限后置 responseJson / responseHeader。responseJson 为严格 JSON 对象/数组根和 own-property 单值路径。
  保留选中值的 `0`、`false`、`null`；缺失与 null 不混同。
- 不执行 JSONPath wildcard/filter/function，不回退 XML，不插值路径；responseHeader 的有界契约见下节。
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


## responseHeader：有界的单字段登录令牌闭环

独立契约仍来自上述合法静态包，非原版运行结果。sender `index.js` SHA256 为
`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`。
按 Python `read_text` 通用换行后的 Unicode 字符偏移（不是字节）：
`responseHeader` 分支 33595020，trim(expression) → HeaderList.get → scope.set
33598468；HeaderList 大小写不敏感 26121132，get 26181997。
原版 transport 在 27940679 / 27942549 先按原始拼写分组，27964991 再展开，
随后交给 HeaderList。因此混合拼写交错重复不能推定为最后 wire 字段值。
本实现不复制原版代码，不运行原版 GUI，不宣称原版重复头或吞错行为等价。

- 数据为 `source:"responseHeader"`、`variables:[{name,expression,type}]`。
  expression trim 后必须是字面 HTTP token 字段名，匹配不区分大小写；
  没有模板插值、JSONPath 求值、XML 回退、cookie 提取或 header assert。
  类似 `$.token` 若本身符合字段名语法，也只是字面头名，不是选择器。
  禁用任务只验证已知来源、闭合字段和已有限额，不编译/激活其表达式。
- 必须有**完整、有界的真实传输证据**，选中字段按大小写折叠后恰有一次。
  HTTP/1 从 `IncomingMessage.rawHeaders` 计数；HTTP/2 仅从 `response` 事件
  第三个 rawHeaders 参数取证（排除伪头，不从已合并 headers 反推）。
  缺证据、畸形数组、重复或超限一律拒绝，绝不逗号拆分、数组取尾或猜测。
  单字段值 `one, literal` 与空字符串原样保留；当前值必须为 own primitive string，
  包括单个 set-cookie 仍为数组时也拒绝。原版缺失值可能继续传 undefined 并吞错，
  Workbench 为避免旧 token 流入后续请求而严格失败。
- HTTP/1 显式维持原生默认 `req.maxHeadersCount=1000`，在 request 返回后、
  socket/parser 的 nextTick 绑定之前设置；不降低普通响应可见头范围。
  独立 Node 24.22.1 loopback 证明小于 16KiB 的短字段也可触发 1000 对截断，
  所以不能仅凭头字节预算宣称完整。饱和前缀不得作为唯一性证明。
  native 证据另限 **256 个原始字段对**（HTTP/2 的伪头占原始对数），
  字段名合计最多 64KiB；超限只让 Header 提取失败，不影响普通响应或 JSON 提取。
  HTTP/2 现有 session 头限额、全部网络/脚本预算保持不变，不放宽其拒绝超限行为。
- 传输返回对象的身份通过主机私有 WeakMap 关联冻结的 count-only 证据。
  不重复保存敏感字段值，不增加公开响应字段；历史 JSON、克隆对象、导入对象或
  JS 伪造同名 metadata 都不能恢复证明。runScript 将证据单独传给 worker，
  bootstrap 在用户代码前捕获私有 JSON 数据和原归一化响应头 map、own-descriptor/
  hasOwn/字符读取器；不调用可替换的公开 `headers.get/has/all`。
  本阶段原 map 已有字段的直接字符串修改可被读取，但整体替换 map/facade 无效；
  新增无 wire 证据字段、删除字段、getter、非字符串、无效 Unicode 或超过 64KiB
  的 UTF-8 值拒绝。getter 不执行，也不能通过 Object.prototype.value 冒充数据属性。
- Header-only 任务不解析正文；HTML 登录响应可用。安全 body/status 修改不影响头证明，
  原始 wire response/记录保持不变。不新增响应 HeaderList 修改 API，不支持跨阶段
  header override；原生任务与共享脚本 sequence 仍按基线互斥，不扩展证明转移权限。
- 沿用本 ADR 的原子赋值、整后置阶段回滚、严格停止及完成性检查；捕获异常、return、
  伪造公开证据都不能把未完成提取当成功。已发生的网络或存储副作用不承诺回滚。

`tests/native-pick-header-workflow.test.mjs` 用独立合成 fixture 覆盖真实 HTTP/1 和
HTTP/2：原生 import → 冻结计划 → HTML 登录单头 → env/temp/global → 同阶段脚本 →
下一真实 Bearer → 保存/备份/重启、多环境/项目隔离，及取消/缺失/同拼写与混拼重复/
set-cookie/超过 256 对/1000 对截断、断言/网络/前后置失败时不发旧 token 后续请求。
`tests/native-pick-header-boundaries.test.mjs` 覆盖信任身份、冻结 count-only 数据、禁用
闭合形状、全部行验证后才写入、零 getter/正文读取、原型/公开函数/map 篡改与 UTF-8
值限额。测试没有原版 runtime parity 证据。原生反向导出与惰性来源仍由其独立模块
负责整合，完整 Workbench backup 往返不等于原版导出往返。
