# 原生 request wait

## 静态契约及差异

合法 Offline2 sender `send.asar/index.js` 模块 842216、LF 归一 Unicode 偏移
33582811 显示混排任务 `type:'wait'` 的 data 是毫秒标量；pre/post 均支持，项目→目录→接口继承。
原版对启用数据调用 lodash.toInteger，正值执行同步 sleep；UI `9269.86937a8833e2.js`
模块 693453 偏移 7266 编辑毫秒，默认 1000、清空归零。完整来源记录见
`ORIGINAL-OFFLINE2-RESEARCH.md`。本片只有静态契约及独立 fixture，不声称原版运行等价。

本片仅实现 request 任务，不是采用 data.sleep/变量替换的 flow controller。
启用 data 须为 0..1000 的整数，继承合并后每阶段启用 wait 总和≤1000ms；
不转换字符串/boolean/null、不截断小数或钳制负数。禁用 data 必需且仅限 null、boolean、
有限 number、≤1000 合法 Unicode 字符串；惰性保留，不插值、不计等待量、不安排 timer。

## 执行与权限

- 零值同步标记完成，不安排 timer、不消耗 timerLimit，也不引入 await/microtask 让步。
- 正值使用既有 raw \_\_scheduleTimer，bootstrap 在删除桥前私有捕获；不调用可覆写
  setTimeout 或其动态 Number 转换。沿用总 timer≤100/同时≤32、250ms active/2s wall 与 AbortSignal。
- 捕获 Promise/intrinsics，等待对象带不可改写 own constructor/then，避免 prototype 被修改后
  await 早于真实 timer 回调恢复。只有真实 callback 标记完成，不向源码返回 timer ID。
- 私有 consumed/completed/active/sticky failure 与可信 worker 成功出口检查保证声明全部完成；
  用户早退、吞调度错误或猜 timer ID 取消，不能伪造完成。
- 异步等待与原版同步 sleep 有明确差异：等待期间同阶段其他已授权回调可运行。
  不新增网络/数据库权限，不做 Atomics/busy-loop，不扩大预算，不承诺任意异步脚本完全等价。
- wait-only 阶段错误沿用普通计划继续策略；取消停止计划；有启用 pickVars 的请求仍保留既有严格策略。
  同 VM 词法作用域/来源与冻结快照保持不变，原 wire 与处理视图保持独立。

## 本地验收

最终七个 focused 测试文件 103/103 通过：native-wait-tasks、native-response-assertions、
native-pick-vars、native-task-phase、native-task-plan、apipost-modern、dynamic-values。
语法/format/diff 检查通过；exact-head CI 与组合入口另行验收，focused 不是全产品通过。

覆盖严格/惰性输入、零值无 timer/无 microtask 让步、真实 loopback entered→继承 wait80ms→
主 HTTP / post-entered→wait120ms→后续 Bearer HTTP，变量/run 落盘、冻结后编辑、重启、完整备份恢复。
Number/Promise/timer/Date 篡改测试中的后一个 HTTP 也由同一 VM 在 wait 后发送；
服务端 monotonic 时间证明未提前发送，不靠脚本时钟或仅等待最终 completion 掩盖过早副作用。
另验证两项目/两环境并发隔离、外项目环境拒绝、1000ms inclusive、合计超限、100次/32并行 timer、
700ms wall deadline 在等待期间仍生效、异步重入 sticky failure、早退/吞调度错误/猜 clear ID 不伪装成功。

真实 HTTP 取消测试在 wait 期间由另一个已授权定时回调发送 wait-active 标记后取消：
前置取消不发送主请求、不提交该 VM 变量；后置取消保留已成功提交的前置变量与原 wire 响应，
不提交本次 VM 后置变量、不发送后续计划请求。另一项目继续成功，cancelled run 落盘后重启不重放。
这些是本地 Workbench 的验证，不是原版同步 sleep/外层取消保证。

旧 modern 未知任务负例曾使用现在合法的 wait10；已保留真正 unsupported-task 原子拒绝，
同时覆盖 wait 字符串强制转换/合计超限拒绝与整数 wait10 的实际 timer 正例，未删除未知类型覆盖。

PR2 CLI 与 PR7 惰性 flow 来源类型适配属于组合验收；不复制整分支、不激活 flow API 来源任务。
