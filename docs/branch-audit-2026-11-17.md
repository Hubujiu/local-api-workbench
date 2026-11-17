# local-api-workbench：336 个分支逐项审查与 main 收敛方案

审查日期：2026-11-17。此文件记录固定快照与整合决定；最终是否已合并、整合 PR / main 的实际 CI 状态以 GitHub 对应记录为准。

## 核心结论

仓库不是 336 套互相独立的功能：大量分支是依赖基线、检查点、已被后续堆栈包含的增量或等价移植。原 `main` 为 `5af2f63913e097efd6fb3325103bd5fd2ee0f6a1`，只有初始化内容；263 个 PR 全部 open + draft，合并数为零。原候选 `2532d67136fbc89000ecaf079f826ed229600e86` 已直接包含 236 个分支头；另 100 个需要补丁和语义核对。

整合代码固定提交为 [`59463aa2dea720f1b817cf69720d4a0e76992002`](https://github.com/Hubujiu/local-api-workbench/commit/59463aa2dea720f1b817cf69720d4a0e76992002)，tree 为 `88b283f35cc45641ad89c0c04cece0f99ffcc748`。该提交以最新候选为第一父，保留 #128、#129、#106 的分支历史；本报告和 README 作为后续文档提交加入。整合分支是 `review/consolidate-main-20261117`，目标 `main`。

| 处置 | 分支数 |
| --- | ---: |
| 提交历史已纳入 | 236 |
| 补丁等价已纳入 | 13 |
| 语义已整合或由后续实现替代 | 76 |
| 隔离保留，不并入主线 | 5 |
| 旧文档已被替代 | 1 |
| 本轮补回遗漏回归和历史 | 1 |
| 旧实现已被准备层替代 | 1 |
| 本轮补回遗漏功能和历史 | 2 |
| 业务已整合，本轮补回SDK回归 | 1 |

### 本轮确认并修复的漏项

1. **空 JSON 导出（#129，P2）**：运行时发送 `{}`，原候选导出空正文。本轮复现失败，补回共享导出副本的归一化及跨语言线缆/进程清理回归。
2. **空 multipart cURL（#128，P2）**：原候选未生成 multipart 结束帧。补回固定安全边界、完整 framing headers、冲突拒绝和实际 cURL 回归。
3. **缺失回归覆盖（#106、#17）**：补回预取消 live MCP 的零网络/可保存取消证据；补回官方 SDK HTTP/stdio 的缺失文件保存拒绝、恢复、重启和隔离验证。#17 测试按当前摘要投影/完整导出与授予权限合同适配，不改变产品行为。
4. **完整包遍历漏检（P2）**：`os.walk` 默认静默跳过扫描错误。以 `scandir` 抛 `PermissionError` 的确定性回归确认，原逻辑会接受包含不可遍历额外子目录的包。本轮令默认遍历错误失败；所有当前调用者均覆盖。
5. **main CI 没有 push 触发**：增加 `main` push，保留原整合分支触发；新增稳定 `required` job，等待全部 7 类任务，failure/cancelled/skipped/缺项都失败。

### 本轮没有强行并入的内容

- Oracle readonly、Lite capability probe、Lite inventory 共 3 个分支：真实服务门槛未闭合、未注册 provider；probe 有确定失败，inventory 修订头无运行。
- QuickJS trusted-bytecode 实验：仍保留 guest OOM 导致引擎断言的证据，不属于可直接并入的生产优化。
- 一次性 macOS gRPC diagnostic：旧父限制和硬编码触发的诊断分支，无生产增量，未复现不是已修复。
- 旧 SQL Server WIP 已由异步准备层替代；旧后端下载索引已由较新文档替代。还原它们会恢复旧合同或旧入口。

## 验证证据与限制

| 检查 | 实际结果 |
| --- | --- |
| 原候选 #263 固定同树 CI | [run 44092428921](https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921)：46/46 jobs success；checkout merge tree 与 2532d67 相同 |
| 原生/协议/计划重点回归 | 20 文件，165 通过、0 失败/取消/跳过；固定原候选 |
| 补回空 multipart 回归 | 修复前失败；修复后 2/2 通过 |
| 补回空 JSON 与进程清理回归 | 修复前失败；38 通过、0 失败、8 Go 跳过 |
| live-plan 工作流含预取消 | 6/6 通过 |
| SDK/Git/文件历史/Digest/代码导出组合 | 40 通过、0 失败、1 Go 跳过；包含官方 SDK 的 4 条恢复旅程 |
| portable Python 全部相关测试 | 71 通过、0 失败/跳过；新遍历错误回归先 RED 后 GREEN |
| 原生自动化拒绝/SQL Server gate/分片约束 | 23 通过、0 失败、1 真实 SQL Server 跳过 |
| 当前整合代码检查 | npm run check、全仓 format:check、git diff --check 通过 |

各组测试有重叠，不相加声称总覆盖。Go 工具链、真实 SQL Server、Windows 清洁机器安装/升级/卸载/签名的未执行项单独保留。最终整合树必须重新通过自身 CI；原候选绿色不能替代新增合并树。

历史全部 1489 次 workflow run 做了分页核查。按每个分支精确 head、每种 workflow 最新运行分别汇总：260 success、41 failure、4 cancelled、31 无精确 head run。该统计用于保留历史事实，不能把旧失败的分支内容自动判为当前候选失败，也不能用一个 workflow 的绿色遮盖另一个 workflow 的红色。

逐项记录中的“原分支精确 head 的 CI”表示 workflow run 的 head_sha 与该分支固定 SHA 相符；pull_request 事件实际 checkout 可能是测试合并提交。除明确标注已核对同树的原候选外，本报告没有声称每次历史运行的 checkout tree 都与分支 head tree 相同。

### 整合 PR #264 首轮发现与诊断补充

[首轮 run 44104118453](https://github.com/Hubujiu/local-api-workbench/actions/runs/44104118453) 检出 `2fa863e20b9d35b85efd7eff0fc44d8ee172babd`，其 tree `fd2b571f2b8cb28fb20c4376e1b02d401aed8827` 与发布头 `f0f4bed9df5028fcee20c6cc94360678bf7bb560` 完全一致。最终 47 jobs 中 44 成功、3 失败、0 取消/跳过；其中两项是以下 Windows 核心测试失败，第三项是 required 正确汇总拒绝 core=failure，不是第三个独立缺陷。首轮失败保留为本次整合证据，不用后续运行覆盖。

- Windows shard 1：[job 134111717662](https://github.com/Hubujiu/local-api-workbench/actions/runs/44104118453/job/134111717662) 的 native XML 边界测试耗尽 250ms 活动预算。取整诊断为 compatibility 96ms、userScript 154ms、promiseState 1ms；host settle 664ms，未触及约 2s 总期限。原日志无法在四个应成功边界中定位具体案例。
- Windows shard 4：[job 134111717717](https://github.com/Hubujiu/local-api-workbench/actions/runs/44104118453/job/134111717717) 的 SQLite 超时恢复测试，在后续独立 UPDATE 阶段收到 SQLITE_WRITE_OUTCOME_UNKNOWN。worker ready 85ms，最后前置观察为 commit/98ms，总 elapsed 2334ms 后 SIGKILL、receivedResult=false；不能据此推断已提交、已回滚或某个具体锁泄漏。

相关生产实现、原测试和预算与原候选逐 blob 一致；原候选同 Node 24.22.2、Windows 镜像 20261103.298.1 的同名测试曾成功。新增测试改变了分片分配，但这些对照不足以证明宿主调度、CPU 或磁盘争用就是根因。新补回测试本身未出现失败；导出与进程清理回归所在的三平台分片均已通过，SDK 回归所在 Windows shard 4 则由另一个旧用例失败导致整体未通过。Windows 的 POSIX cURL 子例仍按平台限制跳过，由 Linux/macOS 执行，不声称所有子测试零 skip。

后续只补充针对性测试诊断：XML 四个成功边界失败时输出固定案例标签，原 Error 与全部调用/断言不变；SQLite 独立写发生未知结果时，仅用既有有界只读查询记录 before/after/unexpected/read-failed，再原样抛出原失败。没有重放写入、放宽 250ms/2s/12s 预算或把失败当成功。诊断改进与后续绿色运行均不等于已修复上述根因。首轮结果与失败摘录见 [integration-ci-initial.json](branch-audit-2026-11-17/evidence/integration-ci-initial.json)。

### 继续排查并修复活动预算根因

[第二轮 run 44107589801](https://github.com/Hubujiu/local-api-workbench/actions/runs/44107589801) 的 47 jobs 为 45 成功、2 失败；唯一实际失败是 macOS script-sequence 的跨阶段 timer 配额测试，另一个是 required 汇总拒绝。Windows 首轮 XML/SQLite 用例在此轮通过，但不能因此抹去旧失败。第二轮完整记录见 [integration-ci-second.json](branch-audit-2026-11-17/evidence/integration-ci-second.json)。

后续定点故障注入确认了确定性的计费缺陷：兼容层的长 deadline 区间包含可信 CPU 诊断采样，序列化最终 activityMs 也会计入结束后的诊断采样。只延迟诊断、不增加 guest 工作，就能使正确的 60+60 timer 共享配额检查变成提前超时，也能使合法输出被误拒。原生断言证据的 getString/JSON.parse 又存在反向漏计，300ms 的真实宿主转换曾被报告成约 18–25ms 活动并成功返回。

修复将兼容安装、源码构建、求值、序列化和原生断言证据转换的实际工作分别放入同一个共享剩余预算的 bounded 计费段；诊断采样置于计费段外。真实 VM 执行、Mock 读取与完整性校验、宿主 JSON 转换和证据处理仍按墙钟时间扣费。250ms 共享活动预算、2s 整体期限、100 次 timer 配额、内存和并发限制均不变。阻塞诊断仍会被父线程 2s 整体期限终止。

修复的 6 项故障注入/安全回归及相关 11 文件共 72/72 通过、0 skip，原 quota/XML 断言保留；两个诊断误拒回归在原代码 0/2 通过，先 RED 后 GREEN。预算修复通过第二位审阅者的独立复核。方法和归因边界见 [ADR-SCRIPT-SEQUENCE-BUDGETS.md](ADR-SCRIPT-SEQUENCE-BUDGETS.md)，原始输出见 evidence/script-accounting-red.tap 和 evidence/script-accounting-green.tap。此因果实验确认代码中的诊断计费耦合，不声称已从历史 CI 日志识别出某一次具体 OS 停顿来源。

另已发现两轮 macOS 使用不同的 Node patch/runner image：24.22.3 与 24.22.2。全部七处 setup-node 现固定为已发布的 24.22.3，以消除补丁版本漂移；这不是性能根因证明。版本证据见 [CI-NODE-RUNTIME-PIN-20261117.md](CI-NODE-RUNTIME-PIN-20261117.md)。SQLite 旧 unknown 事件的具体底层 I/O/调度来源仍未确认；不重放该写入、不降低持久性或放宽期限。修复后的整合头仍须通过其自身完整 CI。

## 合并与后续分支管理

先将最新候选与确认漏项组合在隔离 review 分支，保持旧分支不动；以正常 PR 面向 main 验证最终 merge tree。全部 required 条件满足后再合并，并核对 main push CI。不得对 main 使用强制推送，不得用 squash 丢掉本次需要追溯的历史关系。

首次审查保留原有分支，随后清理目标明确为只保留 main。执行顺序是：整合 PR 通过并合入 main、确认 main push CI、对所有待清理头建立可找回的 archive tag 并逐 SHA 核验、保存恢复清单/备份，再以每个 ref 的预期 SHA lease 做原子删除。main 永远排除；分支移头、归档冲突或平台保护拒绝均停止删除。祖先已包含、补丁等价、语义移植和未完成实验仍保留不同处置记录；仅凭 `git branch --merged` 或旧 PR 关闭不能证明没有丢改动。

后续普通功能从 main 创建一个短期分支，PR 直接回 main；确有依赖时在 PR 写清依赖，优先合入前置 PR 后更新后续分支。集成分支只是临时验收，不继续无限堆叠替代主线。每次新增 CI job 时同步 required.needs 与期望任务集。

**平台保护仍需区分**：审查时 main protected=false、rulesets=[]。新增 required workflow 本身不等于 GitHub 已强制要求该检查；本次未修改平台规则。建议在 GitHub Rulesets 对 main 要求 PR、required 成功、禁止 force push/删除，并在新规则启用后核对实际生效。

## 仍然存在的产品边界

Socket.IO 与 gRPC stream 的未知启动状态会被持久保存；当前只读核对/停止不会结束这一未知创建事件，而新启动又受此标记阻断。这是保守防重放合同，可能让同项目长期无法新建会话。后续应加入绑定服务实例和创建操作 ID 的人工核对/结束流程，不能简单清标记或自动重发。本次列为 P2 恢复体验缺口，未伪装成合并已修复。

SQL Server 尚未产品注册，Oracle/达梦未完成；非空原生 automated_testings 仍拒绝；签名和完整安装发行生命周期仍缺实际验收。历史 macOS XML/预算/HTTP2 间歇失败的旧证据保留，新绿灯不代表已找出所有历史根因。收敛 main 是开发主线整合，不等于正式发布或全部 Apipost 功能交付。

## 审查方法

每个分支都固定 SHA、对应 PR/比较基线、差异文件与统计，核对祖先关系；对非祖先头继续做 stable patch-id、逐文件 blob 和当前实现/接线比对。对同一实现的依赖快照继承关联功能审查，不重复声称重新实现。下面每条记录保留手工检查的实现、重要路径和证据边界。

本报告不声称逐行审完每个累计历史树的所有文件，也没有将 336 个历史头分别 checkout 运行全部测试；实际运行与固定 CI 引用在每组记录中区分。机器可读完整记录见 [branches.json](branch-audit-2026-11-17/branches.json)，本机回归原始输出在同目录 evidence 中。

## 全部分支逐项记录

### 001. `checkpoint/backend-before-definition-history-81398a4`

**结论：提交历史已纳入。** SHA：[`81398a4fc23d`](https://github.com/Hubujiu/local-api-workbench/tree/81398a4fc23df5409e27b2aa12d2a72ae322d1c2)；PR：无独立 PR。

**范围：** WIP: add raw media root owner and late-variable contracts

实际审查比较基线 `81398a4fc23d`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 1032 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41792894153)

**实际审查：**

接口定义历史之前的后端检查点；固定 SHA 已是候选祖先，不存在独立增量。

**整合判断：** 作为历史取证锚点即可，不将旧检查点还原为产品主线。

**验证及限制：**

作为历史取证锚点即可，不将旧检查点还原为产品主线。

### 002. `checkpoint/runtime-rows-core-20261104`

**结论：提交历史已纳入。** SHA：[`de09a8a7349e`](https://github.com/Hubujiu/local-api-workbench/tree/de09a8a7349e1318529b81d256164ca2d5850010)；PR：[#116](https://github.com/Hubujiu/local-api-workbench/pull/116)。

**范围：** Checkpoint runtime data rows core (incomplete, default off)

实际审查比较基线 `ee47529c052a`；比较增量：36 files changed, 5646 insertions(+), 142 deletions(-)。原 main 领先 1099 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41897351947)

**实际审查：**

核对实际头提交的 36 文件而非 PR 早期“core-only”说明：运行时行已接通 owner API、CLI、canonical MCP/stdio、存储读取/恢复和实时引用冻结；库级默认仍拒绝，原生写入与原生 MCP 保持单独拒绝，阶段压测最初拒绝、由后续 #117 有边界地开放。

检查了有界控制程序、全部行一次验证后深冻结、仅 runtime 精确键取值、maxRows/maxRowBytes/4MiB/200 控制预算、动态上下文恢复及 unknown commit 停止；静态潜在数据库需求不因空行/false IF 缩减，所有授权批次绑定 grant 身份并在异步等待后复核撤销，实际查询仍再验授权，测试明确验证授权前没有 HTTP/脚本/提交副作用。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 003. `ci/core-test-sharding`

**结论：补丁等价已纳入。** SHA：[`c974cb1bb02f`](https://github.com/Hubujiu/local-api-workbench/tree/c974cb1bb02fed98120897ed4eab14b2e4b8750f)；PR：[#35](https://github.com/Hubujiu/local-api-workbench/pull/35)。

**范围：** 完整文件分片、冻结权重LPT调度和保真诊断基础设施。最后一次独有提交更新688个完整文件的权重与36个历史流来源，保持十分钟任务预算、原测试集合和失败传播。

实际审查比较基线 `88f70bb515c4`；比较增量：13 files changed, 4082 insertions(+), 3 deletions(-)。原 main 领先 405 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41825828029)

**实际审查：**

scripts/core-test-allocation.mjs 的权重文件SHA256、256KiB限制、来源run/file校验、最坏已知fallback、无重复文件LPT分配；当前候选使用同一7b600545权重摘要。

scripts/run-core-tests.mjs 明确枚举tests/*.test.mjs、每片非空、fileConcurrency=1，测试进程异常/取消/nonzero保持失败。

tests/core-test-sharding.test.mjs 用独立glob对照1至12片并集与唯一性，真实子进程验证失败信号；不是只比较实现自身。

**整合判断：** 已等效纳入；合并整合候选即可，不要再重放旧分支

**发现/保留边界：**

git cherry候选对该分支返回 - c974cb1；对应已纳入提交c7a06402727ed48437604b2905a736bcfc775340。

冻结耗时用于分配，不保证十分钟内完成，也不是脚本250ms预算波动的根因修复。

**验证及限制：**

低；旧6片中间态已被12片版本替代。

### 004. `ci/seven-core-shards`

**结论：补丁等价已纳入。** SHA：[`5bdbf759036b`](https://github.com/Hubujiu/local-api-workbench/tree/5bdbf759036be0ddc7613f0e3226cc549a5da55c)；PR：无独立 PR。

**范围：** 将完整core矩阵从6片调整为7片，统一名称、命令和诊断工件路径，同时为gRPC断言增加受限错误观测。

实际审查比较基线 `ff7cff175964`；比较增量：4 files changed, 36 insertions(+), 15 deletions(-)。原 main 领先 1062 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41847150004)

**实际审查：**

逐行核对workflow矩阵、--shard分母及json/tap/jsonl路径同步修改。

真实分片fixture增加第7文件及多文件片，保留nested concurrency和完整集合检查。

gRPC root workflow断言仍验证相同条件，withExecutionResultDiagnostics只补诊断。

**整合判断：** 已等效纳入并被12片方案替代；不要把workflow回退到7片

**发现/保留边界：**

git cherry返回 - 5bdbf75；候选中的等效提交为531abac并随后扩至12片。

同SHA的成功验证来自wip/grpc-code-examples-integration run41847150004；不能误说本分支单独建了PR。

**验证及限制：**

低；重复合并会制造不必要历史与旧分片冲突。

### 005. `ci/twelve-core-shards`

**结论：提交历史已纳入。** SHA：[`2118b96814b7`](https://github.com/Hubujiu/local-api-workbench/tree/2118b96814b79718b47c66aa42b004e1f78d0498)；PR：[#112](https://github.com/Hubujiu/local-api-workbench/pull/112)。

**范围：** 三平台每平台12个完整文件分片，原10分钟限制、单文件顺序运行、fail-fast=false均保留。

实际审查比较基线 `bfa5a74b845d`；比较增量：2 files changed, 15 insertions(+), 13 deletions(-)。原 main 领先 1085 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/41875058919)

**实际审查：**

唯一产品外修改是ci.yml与分片合约测试，矩阵/命令/工件名称一致。

分片测试覆盖1至12片并集无缺项/重复，也运行真实12片fixture且至少一片含多个文件。

**整合判断：** 候选祖先，保留当前12片实现，由整合PR纳入main

**发现/保留边界：**

原head2118b96 run41875058919实际失败：Windows脚本序列、Base64启动超时及restore用例，不能把该历史run改写成成功。

该提交是候选祖先；候选2532d67的46任务成功与同树证明为当前整合提供证据。

扩大分片能缩短任务长度，不自动修复应用脚本wall-clock预算与macOS调度敏感性。

**验证及限制：**

低（当前功能），中（CI执行成本及历史预算敏感性）。

### 006. `ci/verify-downloaded-portable`

**结论：提交历史已纳入。** SHA：[`aadb49896579`](https://github.com/Hubujiu/local-api-workbench/tree/aadb49896579084e91c628e17be21f9c98c85e8e)；PR：[#213](https://github.com/Hubujiu/local-api-workbench/pull/213)。

**范围：** desktop成功后，三平台下载本次运行portable，独立校验head/platform、完整SHA256文件表、符号链接、入口文件及Unix执行位。

实际审查比较基线 `ab41891679e6`；比较增量：4 files changed, 486 insertions(+)。原 main 领先 1220 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43174780392)

**实际审查：**

verify_portable_download.py流式读取tar+gzip，解压总字节与扩展头分配双重上限，不解压/执行被验包；Windows拒绝reparse root/entry。

manifest顺序采用JS UTF16顺序；Unix外内manifest字节一致；链接解析限制循环、目录越界和悬空目标。

实际CI run43174780392在该head通过；当前候选下载任务也全绿。

**整合判断：** 候选祖先；整合时补目录遍历错误回归与fail-closed默认后保留

**发现/保留边界：**

P2（本次已修）：inventory_directory默认忽略os.walk遍历错误；Windows包新增不可读目录含未登记文件时仍可PASS，破坏完整内容校验。通过真实os.walk+scandir PermissionError注入确定复现。

修复将默认fail_on_walk_error改True，调用者显式True仍兼容；仓库没有显式False调用。唯一回归要求verify_download拒绝不可遍历的额外子树。

下载校验不证明签名、公证、干净机器安装/卸载或真实SQLServer支持；当前Windows安装脚本仍有相应未验边界。

**验证及限制：**

P2已在工作树修复，需合并新提交后CI验证。

### 007. `deps/api-definition-history-base`

**结论：提交历史已纳入。** SHA：[`8f42653300e2`](https://github.com/Hubujiu/local-api-workbench/tree/8f42653300e25cad795c51dcb4d7f755e5148f34)；PR：无独立 PR。

**范围：** 纯依赖基线：api-definition-history-base

实际审查比较基线 `8f42653300e2`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 1030 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41784383391)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 257 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 008. `deps/bounded-plan-repeat-base`

**结论：提交历史已纳入。** SHA：[`f540b5246f03`](https://github.com/Hubujiu/local-api-workbench/tree/f540b5246f037c6e666ca5199acbe92bc41c50d4)；PR：无独立 PR。

**范围：** 纯依赖基线：bounded-plan-repeat-base

实际审查比较基线 `f540b5246f03`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 568 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享控制图使用当前 plan-step-types/plan-repeat/core；旧依赖选择性测试文件的等价断言位于 tests/plan-step-types-root.test.mjs，另保留生命周期测试。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 719 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 009. `deps/canonical-if-base`

**结论：语义已整合或由后续实现替代。** SHA：[`2e9d8fdbdeca`](https://github.com/Hubujiu/local-api-workbench/tree/2e9d8fdbdecaee7a59ad218b729ccef6025433c8)；PR：无独立 PR。

**范围：** 纯依赖基线：canonical-if-base

实际审查比较基线 `3625fe7aafb3`；比较增量：36 files changed, 7454 insertions(+), 372 deletions(-)。原 main 领先 602 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享控制图使用当前 plan-step-types/plan-repeat/core；旧依赖选择性测试文件的等价断言位于 tests/plan-step-types-root.test.mjs，另保留生命周期测试。

**整合判断：** 非祖先且有 27 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 36 个变化路径中 15 个与候选文件完全同 blob。 缺少的旧依赖选择性测试并非丢失：已逐条核对root套件有相同未知类型/disabled后代/Proxy/accessor/深度与工作预算断言。

**重点路径：** `src/plan-step-identities.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/plan-repeat-nested-snapshot.test.mjs

**available_branch_tests**：tests/mcp-activity.test.mjs

tests/plan-repeat-consumers.test.mjs

tests/plan-repeat-evidence-limit.test.mjs

tests/plan-repeat-grpc-model.test.mjs

tests/plan-repeat-grpc-workflow.test.mjs

tests/plan-repeat-nested-model.test.mjs

tests/plan-repeat-nested-snapshot.test.mjs

tests/plan-repeat-socketio-model.test.mjs

tests/plan-repeat-socketio-workflow.test.mjs

tests/plan-repeat-tcp-model.test.mjs

tests/plan-repeat-tcp-workflow.test.mjs

tests/plan-repeat-wire-model.test.mjs

tests/plan-repeat-wire-workflow.test.mjs

tests/plan-repeat-workflow.test.mjs

tests/plan-repeat.test.mjs

tests/plan-step-identities-workflow.test.mjs

tests/plan-step-identities.test.mjs

tests/plan-step-types-repeat-dependency.test.mjs

tests/plan-step-types.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 010. `deps/database-session-revoke-base`

**结论：补丁等价已纳入。** SHA：[`f147a3b0f318`](https://github.com/Hubujiu/local-api-workbench/tree/f147a3b0f3183f3af08d3b0393c00b2674c0b997)；PR：无独立 PR。

**范围：** 纯依赖基线：database-session-revoke-base

实际审查比较基线 `d28127c0a88f`；比较增量：70 files changed, 9332 insertions(+), 207 deletions(-)。原 main 领先 450 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 存储及SQLite独立审查由storage组补充；本条确认该依赖基线无需重新合并整棵旧树。

**整合判断：** 虽非祖先，分支非合并提交均找到候选中的稳定 patch-id 等价提交（0 项）；不按 SHA 不同判定功能遗漏。 对照的 70 个变化路径中 28 个与候选文件完全同 blob。

**重点路径：** `src/cli-runtime-credentials.mjs`、`src/database-read-cancellation.mjs`、`src/postgres-client.mjs`、`src/postgres-values.mjs`、`src/resources.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/apipost-database-import.test.mjs

tests/cli-database-grants.test.mjs

tests/database-cancellation-tls.test.mjs

tests/database-cancellation.test.mjs

tests/database-ssh.test.mjs

tests/mcp-database-grants.test.mjs

tests/mcp-ssh-policy.test.mjs

tests/mcp-stdio-database-grants.test.mjs

tests/mcp-stdio-database-workflow.test.mjs

tests/mongodb-cancellation.test.mjs

tests/native-mongodb-tasks.test.mjs

tests/native-redis-tasks.test.mjs

tests/native-ssh-policy.test.mjs

tests/native-task-mcp.test.mjs

tests/native-task-phase.test.mjs

tests/native-task-plan.test.mjs

tests/postgres-explicit-credentials.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 011. `deps/file-lock-recovery-base`

**结论：语义已整合或由后续实现替代。** SHA：[`1f4598253ced`](https://github.com/Hubujiu/local-api-workbench/tree/1f4598253ced5d0ee8fad42335f96724910428b9)；PR：无独立 PR。

**范围：** 纯依赖基线：file-lock-recovery-base

实际审查比较基线 `88f70bb515c4`；比较增量：12 files changed, 1747 insertions(+), 46 deletions(-)。原 main 领先 397 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40649580395)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 存储及SQLite独立审查由storage组补充；本条确认该依赖基线无需重新合并整棵旧树。

**整合判断：** 非祖先且有 2 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 12 个变化路径中 6 个与候选文件完全同 blob。

**重点路径：** `src/cookie-jar.mjs`、`src/http-finalization.mjs`、`src/request-control.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/cookie-publication-boundary.test.mjs

tests/cookie-request-cancellation.test.mjs

tests/cookie-request-entrypoints.test.mjs

tests/file-lock.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 012. `deps/grpc-live-sessions-base`

**结论：提交历史已纳入。** SHA：[`5bec1b033c91`](https://github.com/Hubujiu/local-api-workbench/tree/5bec1b033c91df6ff169ccbb2907070ee1efd70e)；PR：无独立 PR。

**范围：** 纯依赖基线：grpc-live-sessions-base

实际审查比较基线 `5bec1b033c91`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 416 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 871 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 013. `deps/grpc-plan-scripts-base`

**结论：提交历史已纳入。** SHA：[`ecb8dc59c566`](https://github.com/Hubujiu/local-api-workbench/tree/ecb8dc59c566619feb7d9a062d2fc7055113e801)；PR：无独立 PR。

**范围：** 纯依赖基线：grpc-plan-scripts-base

实际审查比较基线 `ecb8dc59c566`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 424 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享控制图使用当前 plan-step-types/plan-repeat/core；旧依赖选择性测试文件的等价断言位于 tests/plan-step-types-root.test.mjs，另保留生命周期测试。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 863 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 014. `deps/manual-resource-import-base`

**结论：提交历史已纳入。** SHA：[`991e6158d70f`](https://github.com/Hubujiu/local-api-workbench/tree/991e6158d70f94a0fdc255486de4d1837ad2bb43)；PR：无独立 PR。

**范围：** 纯依赖基线：manual-resource-import-base

实际审查比较基线 `991e6158d70f`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 1039 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41806823972)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 248 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 015. `deps/mcp-project-model-name-base`

**结论：提交历史已纳入。** SHA：[`9e033cd3a0b8`](https://github.com/Hubujiu/local-api-workbench/tree/9e033cd3a0b89cd31a7e751c3f5c90bc7abc68bf)；PR：无独立 PR。

**范围：** 纯依赖基线：mcp-project-model-name-base

实际审查比较基线 `9e033cd3a0b8`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 542 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 745 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 016. `deps/native-assertions-runtime-base`

**结论：提交历史已纳入。** SHA：[`4a79927b16f7`](https://github.com/Hubujiu/local-api-workbench/tree/4a79927b16f7691bb85f5dbf124b1e6a8af4f4f1)；PR：无独立 PR。

**范围：** 纯依赖基线：native-assertions-runtime-base

实际审查比较基线 `4a79927b16f7`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 441 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 846 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 017. `deps/native-binary-import-base`

**结论：补丁等价已纳入。** SHA：[`ee13e2b5fdd6`](https://github.com/Hubujiu/local-api-workbench/tree/ee13e2b5fdd6ac3c3520b873058b07a8888c3eb9)；PR：无独立 PR。

**范围：** 纯依赖基线：native-binary-import-base

实际审查比较基线 `2dbe12c868aa`；比较增量：4 files changed, 321 insertions(+)。原 main 领先 401 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 虽非祖先，分支非合并提交均找到候选中的稳定 patch-id 等价提交（1 项）；不按 SHA 不同判定功能遗漏。 对照的 4 个变化路径中 1 个与候选文件完全同 blob。

**重点路径：** `src/base64-encoding-preflight.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/base64-encoding-preflight.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 018. `deps/native-code-export-base`

**结论：语义已整合或由后续实现替代。** SHA：[`79bf5f54cb4a`](https://github.com/Hubujiu/local-api-workbench/tree/79bf5f54cb4a877fb1576ce595790e6f6df592cb)；PR：无独立 PR。

**范围：** 纯依赖基线：native-code-export-base

实际审查比较基线 `3bbbbdd0d9b8`；比较增量：239 files changed, 56768 insertions(+), 9326 deletions(-)。原 main 领先 565 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41205699415)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 34 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 239 个变化路径中 151 个与候选文件完全同 blob。

**重点路径：** `src/apipost-asap-auth.mjs`、`src/apipost-auth-import.mjs`、`src/apipost-digest-auth.mjs`、`src/apipost-directory-artifacts.mjs`、`src/apipost-directory.mjs`、`src/apipost-document-export.mjs`、`src/apipost-documents.mjs`、`src/apipost-execution-files.mjs`、`src/apipost-execution-plans.mjs`、`src/apipost-extended-protocol-export.mjs`、`src/apipost-extended-protocols.mjs`、`src/apipost-grpc-metadata.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/native-oauth2-wire.test.mjs

**available_branch_tests**：tests/apipost-auth-export.test.mjs

tests/apipost-auth-import.test.mjs

tests/apipost-directory-export.test.mjs

tests/apipost-document-export.test.mjs

tests/apipost-export.test.mjs

tests/apipost-extended-protocol-export.test.mjs

tests/apipost-extended-protocols.test.mjs

tests/apipost-mock-export.test.mjs

tests/apipost-mock-media-export.test.mjs

tests/apipost-model-export.test.mjs

tests/apipost-native-protocols.test.mjs

tests/apipost-noauth-import.test.mjs

tests/apipost-protocol-export.test.mjs

tests/apipost-sample-export.test.mjs

tests/apipost-websocket-export.test.mjs

tests/aws-query-signature.test.mjs

tests/builtin-variables.test.mjs

tests/core-test-sharding.test.mjs

tests/digest-policy-owner.test.mjs

tests/digest-policy.test.mjs

tests/digest-shared-policy.test.mjs

tests/extended-protocol-export-entrypoints.test.mjs

tests/faker-variables.test.mjs

tests/imported-execution-history.test.mjs

tests/imported-native-flow-source.test.mjs

tests/imported-native-task-source.test.mjs

tests/interchange-noauth-import.test.mjs

tests/mcp-expanded.test.mjs

tests/mcp-request-input.test.mjs

tests/native-asap-definition-roundtrip.test.mjs

tests/native-asap-owner-roundtrip.test.mjs

tests/native-digest-bootstrap.test.mjs

tests/native-digest-owner-roundtrip.test.mjs

tests/native-document-lifecycle.test.mjs

tests/native-extended-protocol-integration.test.mjs

tests/native-flow-task-boundary.test.mjs

tests/native-grpc-metadata.test.mjs

tests/native-grpc-tls.test.mjs

tests/native-jwt-definition-export.test.mjs

tests/native-jwt-owner-roundtrip.test.mjs

tests/native-mcp-api.test.mjs

tests/native-mcp-environments.test.mjs

tests/native-mcp-history.test.mjs

tests/native-mcp-project-sync.test.mjs

tests/native-mcp-workflows.test.mjs

tests/native-mock-media.test.mjs

tests/native-mock-route.test.mjs

tests/native-mock.test.mjs

tests/native-ntlm-credentials.test.mjs

tests/native-ntlm-owner-roundtrip.test.mjs

tests/native-oauth1-owner-roundtrip.test.mjs

tests/native-oauth1-policy.test.mjs

tests/native-oauth2-admission.test.mjs

tests/native-oauth2-definition-owner.test.mjs

tests/native-oauth2-definition.test.mjs

tests/native-oauth2-model.test.mjs

tests/native-oauth2-owner.test.mjs

tests/native-oauth2-token.test.mjs

tests/native-oauth2-wire.test.mjs

tests/native-protocol-identity-isolation.test.mjs

tests/native-protocol-integration.test.mjs

tests/native-protocol-templates.test.mjs

tests/native-socketio-handshake.test.mjs

tests/native-websocket-fidelity.test.mjs

tests/oauth1-policy-admission.test.mjs

tests/oauth1-policy-model.test.mjs

tests/oauth1-policy-owner.test.mjs

tests/oauth1-policy-wire.test.mjs

tests/oauth1-request-policy.test.mjs

tests/original-directory-artifacts.test.mjs

tests/original-execution-import.test.mjs

tests/original-mcp-flow-import.test.mjs

tests/original-offline2-import.test.mjs

tests/protocol-handshake.test.mjs

tests/protocol-request-semantics.test.mjs

tests/protocol-text-templates.test.mjs

tests/quickjs-heap-accounting.test.mjs

tests/quickjs-heap-workflow.test.mjs

tests/quickjs-regexp-interrupt.test.mjs

tests/quickjs-regexp-workflow.test.mjs

tests/quickjs-unicode-oom.test.mjs

tests/script-cpu-diagnostics.test.mjs

tests/script-diagnostics.test.mjs

tests/script-final-budget.test.mjs

tests/script-sequence-budgets.test.mjs

tests/script-sequence.test.mjs

tests/websocket-export-entrypoints.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 019. `deps/native-cookie-evidence`

**结论：提交历史已纳入。** SHA：[`875943c81e77`](https://github.com/Hubujiu/local-api-workbench/tree/875943c81e777ec79cadbeeff77b9aabc2998186)；PR：无独立 PR。

**范围：** 纯依赖基线：native-cookie-evidence

实际审查比较基线 `875943c81e77`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 396 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 891 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 020. `deps/native-description-export-base`

**结论：语义已整合或由后续实现替代。** SHA：[`79bf5f54cb4a`](https://github.com/Hubujiu/local-api-workbench/tree/79bf5f54cb4a877fb1576ce595790e6f6df592cb)；PR：无独立 PR。

**范围：** 纯依赖基线：native-description-export-base

实际审查比较基线 `3bbbbdd0d9b8`；比较增量：239 files changed, 56768 insertions(+), 9326 deletions(-)。原 main 领先 565 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41205699415)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 34 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 239 个变化路径中 151 个与候选文件完全同 blob。

**重点路径：** `src/apipost-asap-auth.mjs`、`src/apipost-auth-import.mjs`、`src/apipost-digest-auth.mjs`、`src/apipost-directory-artifacts.mjs`、`src/apipost-directory.mjs`、`src/apipost-document-export.mjs`、`src/apipost-documents.mjs`、`src/apipost-execution-files.mjs`、`src/apipost-execution-plans.mjs`、`src/apipost-extended-protocol-export.mjs`、`src/apipost-extended-protocols.mjs`、`src/apipost-grpc-metadata.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/native-oauth2-wire.test.mjs

**available_branch_tests**：tests/apipost-auth-export.test.mjs

tests/apipost-auth-import.test.mjs

tests/apipost-directory-export.test.mjs

tests/apipost-document-export.test.mjs

tests/apipost-export.test.mjs

tests/apipost-extended-protocol-export.test.mjs

tests/apipost-extended-protocols.test.mjs

tests/apipost-mock-export.test.mjs

tests/apipost-mock-media-export.test.mjs

tests/apipost-model-export.test.mjs

tests/apipost-native-protocols.test.mjs

tests/apipost-noauth-import.test.mjs

tests/apipost-protocol-export.test.mjs

tests/apipost-sample-export.test.mjs

tests/apipost-websocket-export.test.mjs

tests/aws-query-signature.test.mjs

tests/builtin-variables.test.mjs

tests/core-test-sharding.test.mjs

tests/digest-policy-owner.test.mjs

tests/digest-policy.test.mjs

tests/digest-shared-policy.test.mjs

tests/extended-protocol-export-entrypoints.test.mjs

tests/faker-variables.test.mjs

tests/imported-execution-history.test.mjs

tests/imported-native-flow-source.test.mjs

tests/imported-native-task-source.test.mjs

tests/interchange-noauth-import.test.mjs

tests/mcp-expanded.test.mjs

tests/mcp-request-input.test.mjs

tests/native-asap-definition-roundtrip.test.mjs

tests/native-asap-owner-roundtrip.test.mjs

tests/native-digest-bootstrap.test.mjs

tests/native-digest-owner-roundtrip.test.mjs

tests/native-document-lifecycle.test.mjs

tests/native-extended-protocol-integration.test.mjs

tests/native-flow-task-boundary.test.mjs

tests/native-grpc-metadata.test.mjs

tests/native-grpc-tls.test.mjs

tests/native-jwt-definition-export.test.mjs

tests/native-jwt-owner-roundtrip.test.mjs

tests/native-mcp-api.test.mjs

tests/native-mcp-environments.test.mjs

tests/native-mcp-history.test.mjs

tests/native-mcp-project-sync.test.mjs

tests/native-mcp-workflows.test.mjs

tests/native-mock-media.test.mjs

tests/native-mock-route.test.mjs

tests/native-mock.test.mjs

tests/native-ntlm-credentials.test.mjs

tests/native-ntlm-owner-roundtrip.test.mjs

tests/native-oauth1-owner-roundtrip.test.mjs

tests/native-oauth1-policy.test.mjs

tests/native-oauth2-admission.test.mjs

tests/native-oauth2-definition-owner.test.mjs

tests/native-oauth2-definition.test.mjs

tests/native-oauth2-model.test.mjs

tests/native-oauth2-owner.test.mjs

tests/native-oauth2-token.test.mjs

tests/native-oauth2-wire.test.mjs

tests/native-protocol-identity-isolation.test.mjs

tests/native-protocol-integration.test.mjs

tests/native-protocol-templates.test.mjs

tests/native-socketio-handshake.test.mjs

tests/native-websocket-fidelity.test.mjs

tests/oauth1-policy-admission.test.mjs

tests/oauth1-policy-model.test.mjs

tests/oauth1-policy-owner.test.mjs

tests/oauth1-policy-wire.test.mjs

tests/oauth1-request-policy.test.mjs

tests/original-directory-artifacts.test.mjs

tests/original-execution-import.test.mjs

tests/original-mcp-flow-import.test.mjs

tests/original-offline2-import.test.mjs

tests/protocol-handshake.test.mjs

tests/protocol-request-semantics.test.mjs

tests/protocol-text-templates.test.mjs

tests/quickjs-heap-accounting.test.mjs

tests/quickjs-heap-workflow.test.mjs

tests/quickjs-regexp-interrupt.test.mjs

tests/quickjs-regexp-workflow.test.mjs

tests/quickjs-unicode-oom.test.mjs

tests/script-cpu-diagnostics.test.mjs

tests/script-diagnostics.test.mjs

tests/script-final-budget.test.mjs

tests/script-sequence-budgets.test.mjs

tests/script-sequence.test.mjs

tests/websocket-export-entrypoints.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 021. `deps/native-digest-export-base`

**结论：语义已整合或由后续实现替代。** SHA：[`0b99b0c37876`](https://github.com/Hubujiu/local-api-workbench/tree/0b99b0c37876e503f6b7b5f3215f1a1e403ba395)；PR：无独立 PR。

**范围：** 纯依赖基线：native-digest-export-base

实际审查比较基线 `3bbbbdd0d9b8`；比较增量：160 files changed, 37436 insertions(+), 9272 deletions(-)。原 main 领先 486 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 160 个变化路径中 91 个与候选文件完全同 blob。

**重点路径：** `src/apipost-directory-artifacts.mjs`、`src/apipost-directory.mjs`、`src/apipost-documents.mjs`、`src/apipost-execution-files.mjs`、`src/apipost-extended-protocols.mjs`、`src/apipost-grpc-metadata.mjs`、`src/apipost-native-mock.mjs`、`src/apipost-protocol-handshake.mjs`、`src/apipost-protocol-identities.mjs`、`src/aws-signature.mjs`、`src/digest.mjs`、`src/grpc-metadata-requirements.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/apipost-auth-import.test.mjs

tests/apipost-extended-protocols.test.mjs

tests/apipost-native-protocols.test.mjs

tests/apipost-noauth-import.test.mjs

tests/aws-query-signature.test.mjs

tests/builtin-variables.test.mjs

tests/core-test-sharding.test.mjs

tests/digest-policy-owner.test.mjs

tests/digest-policy.test.mjs

tests/faker-variables.test.mjs

tests/imported-execution-history.test.mjs

tests/imported-native-flow-source.test.mjs

tests/imported-native-task-source.test.mjs

tests/interchange-noauth-import.test.mjs

tests/mcp-expanded.test.mjs

tests/mcp-request-input.test.mjs

tests/native-document-lifecycle.test.mjs

tests/native-extended-protocol-integration.test.mjs

tests/native-flow-task-boundary.test.mjs

tests/native-grpc-metadata.test.mjs

tests/native-grpc-tls.test.mjs

tests/native-mcp-api.test.mjs

tests/native-mcp-environments.test.mjs

tests/native-mcp-history.test.mjs

tests/native-mcp-project-sync.test.mjs

tests/native-mcp-workflows.test.mjs

tests/native-mock-media.test.mjs

tests/native-mock-route.test.mjs

tests/native-mock.test.mjs

tests/native-protocol-identity-isolation.test.mjs

tests/native-protocol-integration.test.mjs

tests/native-protocol-templates.test.mjs

tests/native-socketio-handshake.test.mjs

tests/native-websocket-fidelity.test.mjs

tests/original-directory-artifacts.test.mjs

tests/original-execution-import.test.mjs

tests/original-mcp-flow-import.test.mjs

tests/original-offline2-import.test.mjs

tests/protocol-handshake.test.mjs

tests/protocol-request-semantics.test.mjs

tests/protocol-text-templates.test.mjs

tests/quickjs-heap-accounting.test.mjs

tests/quickjs-heap-workflow.test.mjs

tests/quickjs-regexp-interrupt.test.mjs

tests/quickjs-regexp-workflow.test.mjs

tests/quickjs-unicode-oom.test.mjs

tests/script-cpu-diagnostics.test.mjs

tests/script-diagnostics.test.mjs

tests/script-final-budget.test.mjs

tests/script-sequence-budgets.test.mjs

tests/script-sequence.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 022. `deps/native-inheritance-export-base`

**结论：提交历史已纳入。** SHA：[`9c66155ceeff`](https://github.com/Hubujiu/local-api-workbench/tree/9c66155ceeff7f57afda1b2368004cb3cf355f02)；PR：无独立 PR。

**范围：** 纯依赖基线：native-inheritance-export-base

实际审查比较基线 `9c66155ceeff`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 504 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40500490883)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 783 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 023. `deps/native-mock-export-base`

**结论：提交历史已纳入。** SHA：[`03b3e52bd5e3`](https://github.com/Hubujiu/local-api-workbench/tree/03b3e52bd5e3e26b389611939e862e67b1c80b52)；PR：无独立 PR。

**范围：** 纯依赖基线：native-mock-export-base

实际审查比较基线 `03b3e52bd5e3`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 478 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 809 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 024. `deps/native-oauth1-export-base`

**结论：语义已整合或由后续实现替代。** SHA：[`129a4a67fb58`](https://github.com/Hubujiu/local-api-workbench/tree/129a4a67fb58af3d7b65a3d003e8380fc5b1a4bc)；PR：无独立 PR。

**范围：** 纯依赖基线：native-oauth1-export-base

实际审查比较基线 `3bbbbdd0d9b8`；比较增量：175 files changed, 40072 insertions(+), 9309 deletions(-)。原 main 领先 494 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 9 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 175 个变化路径中 103 个与候选文件完全同 blob。

**重点路径：** `src/apipost-directory-artifacts.mjs`、`src/apipost-directory.mjs`、`src/apipost-documents.mjs`、`src/apipost-execution-files.mjs`、`src/apipost-extended-protocols.mjs`、`src/apipost-grpc-metadata.mjs`、`src/apipost-native-mock.mjs`、`src/apipost-protocol-handshake.mjs`、`src/apipost-protocol-identities.mjs`、`src/aws-signature.mjs`、`src/digest.mjs`、`src/grpc-metadata-requirements.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/apipost-auth-import.test.mjs

tests/apipost-extended-protocols.test.mjs

tests/apipost-native-protocols.test.mjs

tests/apipost-noauth-import.test.mjs

tests/aws-query-signature.test.mjs

tests/builtin-variables.test.mjs

tests/core-test-sharding.test.mjs

tests/digest-policy-owner.test.mjs

tests/digest-policy.test.mjs

tests/digest-shared-policy.test.mjs

tests/faker-variables.test.mjs

tests/imported-execution-history.test.mjs

tests/imported-native-flow-source.test.mjs

tests/imported-native-task-source.test.mjs

tests/interchange-noauth-import.test.mjs

tests/mcp-expanded.test.mjs

tests/mcp-request-input.test.mjs

tests/native-document-lifecycle.test.mjs

tests/native-extended-protocol-integration.test.mjs

tests/native-flow-task-boundary.test.mjs

tests/native-grpc-metadata.test.mjs

tests/native-grpc-tls.test.mjs

tests/native-mcp-api.test.mjs

tests/native-mcp-environments.test.mjs

tests/native-mcp-history.test.mjs

tests/native-mcp-project-sync.test.mjs

tests/native-mcp-workflows.test.mjs

tests/native-mock-media.test.mjs

tests/native-mock-route.test.mjs

tests/native-mock.test.mjs

tests/native-protocol-identity-isolation.test.mjs

tests/native-protocol-integration.test.mjs

tests/native-protocol-templates.test.mjs

tests/native-socketio-handshake.test.mjs

tests/native-websocket-fidelity.test.mjs

tests/oauth1-policy-admission.test.mjs

tests/oauth1-policy-model.test.mjs

tests/oauth1-policy-owner.test.mjs

tests/oauth1-policy-wire.test.mjs

tests/oauth1-request-policy.test.mjs

tests/original-directory-artifacts.test.mjs

tests/original-execution-import.test.mjs

tests/original-mcp-flow-import.test.mjs

tests/original-offline2-import.test.mjs

tests/protocol-handshake.test.mjs

tests/protocol-request-semantics.test.mjs

tests/protocol-text-templates.test.mjs

tests/quickjs-heap-accounting.test.mjs

tests/quickjs-heap-workflow.test.mjs

tests/quickjs-regexp-interrupt.test.mjs

tests/quickjs-regexp-workflow.test.mjs

tests/quickjs-unicode-oom.test.mjs

tests/script-cpu-diagnostics.test.mjs

tests/script-diagnostics.test.mjs

tests/script-final-budget.test.mjs

tests/script-sequence-budgets.test.mjs

tests/script-sequence.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 025. `deps/native-oauth2-acquisition-base`

**结论：提交历史已纳入。** SHA：[`6350e7ef07b1`](https://github.com/Hubujiu/local-api-workbench/tree/6350e7ef07b18ccef2956bdf793b2bde91419821)；PR：无独立 PR。

**范围：** 纯依赖基线：native-oauth2-acquisition-base

实际审查比较基线 `6350e7ef07b1`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 399 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40604083282)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 888 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 026. `deps/native-oauth2-export-base`

**结论：语义已整合或由后续实现替代。** SHA：[`77a0dcbfd914`](https://github.com/Hubujiu/local-api-workbench/tree/77a0dcbfd9149a567b58366152fa09ab48f90075)；PR：无独立 PR。

**范围：** 纯依赖基线：native-oauth2-export-base

实际审查比较基线 `3bbbbdd0d9b8`；比较增量：185 files changed, 41613 insertions(+), 9314 deletions(-)。原 main 领先 501 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 14 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 185 个变化路径中 110 个与候选文件完全同 blob。

**重点路径：** `src/apipost-directory-artifacts.mjs`、`src/apipost-directory.mjs`、`src/apipost-documents.mjs`、`src/apipost-execution-files.mjs`、`src/apipost-extended-protocols.mjs`、`src/apipost-grpc-metadata.mjs`、`src/apipost-native-mock.mjs`、`src/apipost-protocol-handshake.mjs`、`src/apipost-protocol-identities.mjs`、`src/aws-signature.mjs`、`src/digest.mjs`、`src/grpc-metadata-requirements.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/native-oauth2-wire.test.mjs

**available_branch_tests**：tests/apipost-auth-import.test.mjs

tests/apipost-extended-protocols.test.mjs

tests/apipost-native-protocols.test.mjs

tests/apipost-noauth-import.test.mjs

tests/aws-query-signature.test.mjs

tests/builtin-variables.test.mjs

tests/core-test-sharding.test.mjs

tests/digest-policy-owner.test.mjs

tests/digest-policy.test.mjs

tests/digest-shared-policy.test.mjs

tests/faker-variables.test.mjs

tests/imported-execution-history.test.mjs

tests/imported-native-flow-source.test.mjs

tests/imported-native-task-source.test.mjs

tests/interchange-noauth-import.test.mjs

tests/mcp-expanded.test.mjs

tests/mcp-request-input.test.mjs

tests/native-document-lifecycle.test.mjs

tests/native-extended-protocol-integration.test.mjs

tests/native-flow-task-boundary.test.mjs

tests/native-grpc-metadata.test.mjs

tests/native-grpc-tls.test.mjs

tests/native-mcp-api.test.mjs

tests/native-mcp-environments.test.mjs

tests/native-mcp-history.test.mjs

tests/native-mcp-project-sync.test.mjs

tests/native-mcp-workflows.test.mjs

tests/native-mock-media.test.mjs

tests/native-mock-route.test.mjs

tests/native-mock.test.mjs

tests/native-oauth2-admission.test.mjs

tests/native-oauth2-model.test.mjs

tests/native-oauth2-owner.test.mjs

tests/native-oauth2-token.test.mjs

tests/native-oauth2-wire.test.mjs

tests/native-protocol-identity-isolation.test.mjs

tests/native-protocol-integration.test.mjs

tests/native-protocol-templates.test.mjs

tests/native-socketio-handshake.test.mjs

tests/native-websocket-fidelity.test.mjs

tests/oauth1-policy-admission.test.mjs

tests/oauth1-policy-model.test.mjs

tests/oauth1-policy-owner.test.mjs

tests/oauth1-policy-wire.test.mjs

tests/oauth1-request-policy.test.mjs

tests/original-directory-artifacts.test.mjs

tests/original-execution-import.test.mjs

tests/original-mcp-flow-import.test.mjs

tests/original-offline2-import.test.mjs

tests/protocol-handshake.test.mjs

tests/protocol-request-semantics.test.mjs

tests/protocol-text-templates.test.mjs

tests/quickjs-heap-accounting.test.mjs

tests/quickjs-heap-workflow.test.mjs

tests/quickjs-regexp-interrupt.test.mjs

tests/quickjs-regexp-workflow.test.mjs

tests/quickjs-unicode-oom.test.mjs

tests/script-cpu-diagnostics.test.mjs

tests/script-diagnostics.test.mjs

tests/script-final-budget.test.mjs

tests/script-sequence-budgets.test.mjs

tests/script-sequence.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 027. `deps/native-pick-runtime-base`

**结论：提交历史已纳入。** SHA：[`f8965e98d46a`](https://github.com/Hubujiu/local-api-workbench/tree/f8965e98d46a12386d259a94bdd4caaf51191efe)；PR：无独立 PR。

**范围：** 纯依赖基线：native-pick-runtime-base

实际审查比较基线 `f8965e98d46a`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 432 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 855 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 028. `deps/native-redis-set-owner-base`

**结论：语义已整合或由后续实现替代。** SHA：[`b07afdbfcf29`](https://github.com/Hubujiu/local-api-workbench/tree/b07afdbfcf296d9dd1245202a073eebf9cca4e12)；PR：无独立 PR。

**范围：** 纯依赖基线：native-redis-set-owner-base

实际审查比较基线 `00fd43ddab93`；比较增量：99 files changed, 13570 insertions(+), 500 deletions(-)。原 main 领先 454 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 99 个变化路径中 46 个与候选文件完全同 blob。

**重点路径：** `src/database-read-cancellation.mjs`、`src/execution-evidence.mjs`、`src/plan-evidence.mjs`、`src/postgres-client.mjs`、`src/postgres-values.mjs`、`src/project-commit-outcome.mjs`、`src/resources.mjs`、`src/socketio-evidence.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/apipost-database-import.test.mjs

tests/database-cancellation-tls.test.mjs

tests/database-cancellation.test.mjs

tests/database-ssh.test.mjs

tests/execution-evidence.test.mjs

tests/execution-save-receipts.test.mjs

tests/grpc-plan.test.mjs

tests/grpc.test.mjs

tests/mcp-activity.test.mjs

tests/mcp-http-cancellation.test.mjs

tests/mcp-http-sessions.test.mjs

tests/mcp-progress-failure-evidence.test.mjs

tests/mcp-stdio-cancellation.test.mjs

tests/mcp-stdio-errors-sdk.test.mjs

tests/mcp-stdio-errors.test.mjs

tests/mcp-stdio-transport.test.mjs

tests/mongodb-cancellation.test.mjs

tests/native-mongodb-tasks.test.mjs

tests/native-redis-tasks.test.mjs

tests/native-ssh-policy.test.mjs

tests/native-task-mcp.test.mjs

tests/native-task-phase.test.mjs

tests/native-task-plan.test.mjs

tests/plan-environment-evidence.test.mjs

tests/postgres-explicit-credentials.test.mjs

tests/project-commit-outcome.test.mjs

tests/project-creation.test.mjs

tests/project-record-ids.test.mjs

tests/redis-write-lifecycle.test.mjs

tests/restore-execution-identity.test.mjs

tests/scope-cancellation-workflow.test.mjs

tests/scope-cancellation.test.mjs

tests/socketio-plan.test.mjs

tests/socketio-save-receipts.test.mjs

tests/socketio.test.mjs

tests/wire-evidence.test.mjs

tests/wire-session-evidence.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 029. `deps/native-resource-lifecycle-base`

**结论：语义已整合或由后续实现替代。** SHA：[`d87da10d0be3`](https://github.com/Hubujiu/local-api-workbench/tree/d87da10d0be32912b4e9bc36f5f62340b6221666)；PR：无独立 PR。

**范围：** 纯依赖基线：native-resource-lifecycle-base

实际审查比较基线 `ead0932daef9`；比较增量：31 files changed, 3342 insertions(+), 29 deletions(-)。原 main 领先 413 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41208833136)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 8 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 31 个变化路径中 22 个与候选文件完全同 blob。

**重点路径：** `src/execution-result-chunk.mjs`、`src/native-mcp-environments.mjs`、`src/openapi-operation-admission.mjs`、`src/openapi-reference-context.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/execution-result-chunk.test.mjs

tests/import-document-parser.test.mjs

tests/import-document-routing.test.mjs

tests/mcp-expanded.test.mjs

tests/mcp-openapi-sync.test.mjs

tests/mcp-openapi-yaml-workflow.test.mjs

tests/mcp-result-chunk-sdk.test.mjs

tests/mcp-sdk-interop.test.mjs

tests/native-mcp-environments.test.mjs

tests/native-mcp-http-projection-sdk.test.mjs

tests/native-mcp-http-shape.test.mjs

tests/native-mcp-variable-values.test.mjs

tests/openapi-operation-admission.test.mjs

tests/sdk-flow-failure-context.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 030. `deps/native-task-export-base`

**结论：提交历史已纳入。** SHA：[`2eded2761576`](https://github.com/Hubujiu/local-api-workbench/tree/2eded2761576222049651b31eda9f53b5ea2be9a)；PR：无独立 PR。

**范围：** 纯依赖基线：native-task-export-base

实际审查比较基线 `2eded2761576`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 452 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 835 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 031. `deps/native-task-export-runtime-base`

**结论：补丁等价已纳入。** SHA：[`70f49d2bc5d0`](https://github.com/Hubujiu/local-api-workbench/tree/70f49d2bc5d089c44da01225a1852dcfe65b2f7f)；PR：无独立 PR。

**范围：** 纯依赖基线：native-task-export-runtime-base

实际审查比较基线 `d28127c0a88f`；比较增量：97 files changed, 16907 insertions(+), 93 deletions(-)。原 main 领先 464 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 虽非祖先，分支非合并提交均找到候选中的稳定 patch-id 等价提交（0 项）；不按 SHA 不同判定功能遗漏。 对照的 97 个变化路径中 43 个与候选文件完全同 blob。

**重点路径：** `src/apipost-directory-artifacts.mjs`、`src/apipost-execution-files.mjs`、`src/native-wait-tasks.mjs`、`src/postgres-client.mjs`、`src/postgres-values.mjs`、`src/resources.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/apipost-database-import.test.mjs

tests/apipost-directory-export.test.mjs

tests/apipost-export.test.mjs

tests/apipost-modern.test.mjs

tests/database-ssh.test.mjs

tests/imported-execution-history.test.mjs

tests/imported-native-task-source.test.mjs

tests/mcp-expanded.test.mjs

tests/mongodb-cancellation.test.mjs

tests/native-flow-task-boundary.test.mjs

tests/native-mongodb-tasks.test.mjs

tests/native-pick-vars.test.mjs

tests/native-redis-tasks.test.mjs

tests/native-response-assertions.test.mjs

tests/native-ssh-policy.test.mjs

tests/native-task-mcp.test.mjs

tests/native-task-phase.test.mjs

tests/native-task-plan.test.mjs

tests/native-wait-tasks.test.mjs

tests/original-directory-artifacts.test.mjs

tests/original-execution-import.test.mjs

tests/original-offline2-import.test.mjs

tests/postgres-explicit-credentials.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 032. `deps/native-ws-binary-export-base`

**结论：语义已整合或由后续实现替代。** SHA：[`0a34519d5506`](https://github.com/Hubujiu/local-api-workbench/tree/0a34519d55062f7f17aab70273e6e805a3ee3e1d)；PR：无独立 PR。

**范围：** 纯依赖基线：native-ws-binary-export-base

实际审查比较基线 `3bbbbdd0d9b8`；比较增量：185 files changed, 41630 insertions(+), 9314 deletions(-)。原 main 领先 502 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 15 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 185 个变化路径中 111 个与候选文件完全同 blob。

**重点路径：** `src/apipost-directory-artifacts.mjs`、`src/apipost-directory.mjs`、`src/apipost-documents.mjs`、`src/apipost-execution-files.mjs`、`src/apipost-extended-protocols.mjs`、`src/apipost-grpc-metadata.mjs`、`src/apipost-native-mock.mjs`、`src/apipost-native-protocols.mjs`、`src/apipost-protocol-handshake.mjs`、`src/apipost-protocol-identities.mjs`、`src/aws-signature.mjs`、`src/digest.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/native-oauth2-wire.test.mjs

**available_branch_tests**：tests/apipost-auth-import.test.mjs

tests/apipost-extended-protocols.test.mjs

tests/apipost-native-protocols.test.mjs

tests/apipost-noauth-import.test.mjs

tests/aws-query-signature.test.mjs

tests/builtin-variables.test.mjs

tests/core-test-sharding.test.mjs

tests/digest-policy-owner.test.mjs

tests/digest-policy.test.mjs

tests/digest-shared-policy.test.mjs

tests/faker-variables.test.mjs

tests/imported-execution-history.test.mjs

tests/imported-native-flow-source.test.mjs

tests/imported-native-task-source.test.mjs

tests/interchange-noauth-import.test.mjs

tests/mcp-expanded.test.mjs

tests/mcp-request-input.test.mjs

tests/native-document-lifecycle.test.mjs

tests/native-extended-protocol-integration.test.mjs

tests/native-flow-task-boundary.test.mjs

tests/native-grpc-metadata.test.mjs

tests/native-grpc-tls.test.mjs

tests/native-mcp-api.test.mjs

tests/native-mcp-environments.test.mjs

tests/native-mcp-history.test.mjs

tests/native-mcp-project-sync.test.mjs

tests/native-mcp-workflows.test.mjs

tests/native-mock-media.test.mjs

tests/native-mock-route.test.mjs

tests/native-mock.test.mjs

tests/native-oauth2-admission.test.mjs

tests/native-oauth2-model.test.mjs

tests/native-oauth2-owner.test.mjs

tests/native-oauth2-token.test.mjs

tests/native-oauth2-wire.test.mjs

tests/native-protocol-identity-isolation.test.mjs

tests/native-protocol-integration.test.mjs

tests/native-protocol-templates.test.mjs

tests/native-socketio-handshake.test.mjs

tests/native-websocket-fidelity.test.mjs

tests/oauth1-policy-admission.test.mjs

tests/oauth1-policy-model.test.mjs

tests/oauth1-policy-owner.test.mjs

tests/oauth1-policy-wire.test.mjs

tests/oauth1-request-policy.test.mjs

tests/original-directory-artifacts.test.mjs

tests/original-execution-import.test.mjs

tests/original-mcp-flow-import.test.mjs

tests/original-offline2-import.test.mjs

tests/protocol-handshake.test.mjs

tests/protocol-request-semantics.test.mjs

tests/protocol-text-templates.test.mjs

tests/quickjs-heap-accounting.test.mjs

tests/quickjs-heap-workflow.test.mjs

tests/quickjs-regexp-interrupt.test.mjs

tests/quickjs-regexp-workflow.test.mjs

tests/quickjs-unicode-oom.test.mjs

tests/script-cpu-diagnostics.test.mjs

tests/script-diagnostics.test.mjs

tests/script-final-budget.test.mjs

tests/script-sequence-budgets.test.mjs

tests/script-sequence.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 033. `deps/plan-failure-policy-base`

**结论：语义已整合或由后续实现替代。** SHA：[`b839507e7bdf`](https://github.com/Hubujiu/local-api-workbench/tree/b839507e7bdf9aa93f6eae1b2be919126eed256f)；PR：无独立 PR。

**范围：** 纯依赖基线：plan-failure-policy-base

实际审查比较基线 `3625fe7aafb3`；比较增量：48 files changed, 10712 insertions(+), 401 deletions(-)。原 main 领先 609 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41770183933)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享控制图使用当前 plan-step-types/plan-repeat/core；旧依赖选择性测试文件的等价断言位于 tests/plan-step-types-root.test.mjs，另保留生命周期测试。

**整合判断：** 非祖先且有 33 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 48 个变化路径中 21 个与候选文件完全同 blob。 缺少的旧依赖选择性测试并非丢失：已逐条核对root套件有相同未知类型/disabled后代/Proxy/accessor/深度与工作预算断言。

**重点路径：** `src/mcp-activity.mjs`、`src/plan-step-identities.mjs`、`src/plan-step-types.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/plan-if-owner.test.mjs

tests/plan-repeat-nested-snapshot.test.mjs

**available_branch_tests**：tests/mcp-activity.test.mjs

tests/plan-if-boundaries.test.mjs

tests/plan-if-cli.test.mjs

tests/plan-if-mcp.test.mjs

tests/plan-if-owner.test.mjs

tests/plan-if-progress-failure.test.mjs

tests/plan-if.test.mjs

tests/plan-repeat-consumers.test.mjs

tests/plan-repeat-evidence-limit.test.mjs

tests/plan-repeat-grpc-model.test.mjs

tests/plan-repeat-grpc-workflow.test.mjs

tests/plan-repeat-nested-model.test.mjs

tests/plan-repeat-nested-snapshot.test.mjs

tests/plan-repeat-socketio-model.test.mjs

tests/plan-repeat-socketio-workflow.test.mjs

tests/plan-repeat-tcp-model.test.mjs

tests/plan-repeat-tcp-workflow.test.mjs

tests/plan-repeat-wire-model.test.mjs

tests/plan-repeat-wire-workflow.test.mjs

tests/plan-repeat-workflow.test.mjs

tests/plan-repeat.test.mjs

tests/plan-step-identities-workflow.test.mjs

tests/plan-step-identities.test.mjs

tests/plan-step-types-repeat-dependency.test.mjs

tests/plan-step-types.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 034. `deps/postman-collection-scopes`

**结论：语义已整合或由后续实现替代。** SHA：[`b58d3bf131cd`](https://github.com/Hubujiu/local-api-workbench/tree/b58d3bf131cdcd7e3aad038d3f359fdde31f04bc)；PR：无独立 PR。

**范围：** 纯依赖基线：postman-collection-scopes

实际审查比较基线 `f6ea4ac96547`；比较增量：14 files changed, 1504 insertions(+), 38 deletions(-)。原 main 领先 412 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 对应 Postman OAuth1/GraphQL/raw/scopes 能力已在候选的导入分发和统一请求执行链中继续使用。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 14 个变化路径中 6 个与候选文件完全同 blob。

**重点路径：** `src/debug-publication.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/debug-publication-workflows.test.mjs

tests/debug-publication.test.mjs

tests/scope-cancellation-workflow.test.mjs

tests/scope-cancellation.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 035. `deps/postman-oauth1-pr73`

**结论：语义已整合或由后续实现替代。** SHA：[`27ed173c9614`](https://github.com/Hubujiu/local-api-workbench/tree/27ed173c9614b261ca28f3033f1d9c93f54701af)；PR：无独立 PR。

**范围：** 纯依赖基线：postman-oauth1-pr73

实际审查比较基线 `88f70bb515c4`；比较增量：16 files changed, 2374 insertions(+), 41 deletions(-)。原 main 领先 400 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41078547444)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 对应 Postman OAuth1/GraphQL/raw/scopes 能力已在候选的导入分发和统一请求执行链中继续使用。

**整合判断：** 非祖先且有 5 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 16 个变化路径中 9 个与候选文件完全同 blob。

**重点路径：** `src/licenses/node-oauth1.txt`、`src/oauth1.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/oauth1-policy-admission.test.mjs

tests/oauth1-policy-model.test.mjs

tests/oauth1-policy-owner.test.mjs

tests/oauth1-policy-wire.test.mjs

tests/oauth1-request-policy.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 036. `deps/postman-raw-media-pr51`

**结论：语义已整合或由后续实现替代。** SHA：[`0118e16c1f0b`](https://github.com/Hubujiu/local-api-workbench/tree/0118e16c1f0b2f949d7801d9590a8f878581d480)；PR：无独立 PR。

**范围：** 纯依赖基线：postman-raw-media-pr51

实际审查比较基线 `88f70bb515c4`；比较增量：8 files changed, 1663 insertions(+), 5 deletions(-)。原 main 领先 398 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40666158938)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 对应 Postman OAuth1/GraphQL/raw/scopes 能力已在候选的导入分发和统一请求执行链中继续使用。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 8 个变化路径中 4 个与候选文件完全同 blob。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/postman-graphql-workflow.test.mjs

**available_branch_tests**：tests/postman-body-modes-workflow.test.mjs

tests/postman-body-modes.test.mjs

tests/postman-graphql-body.test.mjs

tests/postman-graphql-sdk.test.mjs

tests/postman-graphql-workflow.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 037. `deps/read-database-runtime-base`

**结论：补丁等价已纳入。** SHA：[`295cccb5b9ab`](https://github.com/Hubujiu/local-api-workbench/tree/295cccb5b9ab8b5f2e9b6f457946eb3197dd2de0)；PR：无独立 PR。

**范围：** 纯依赖基线：read-database-runtime-base

实际审查比较基线 `d28127c0a88f`；比较增量：10 files changed, 612 insertions(+), 18 deletions(-)。原 main 领先 409 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 存储及SQLite独立审查由storage组补充；本条确认该依赖基线无需重新合并整棵旧树。

**整合判断：** 虽非祖先，分支非合并提交均找到候选中的稳定 patch-id 等价提交（0 项）；不按 SHA 不同判定功能遗漏。 对照的 10 个变化路径中 6 个与候选文件完全同 blob。

**重点路径：** `src/postgres-client.mjs`、`src/postgres-values.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/database-ssh.test.mjs

tests/postgres-explicit-credentials.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 038. `deps/scoped-definition-export-base`

**结论：提交历史已纳入。** SHA：[`c7fbe040adba`](https://github.com/Hubujiu/local-api-workbench/tree/c7fbe040adba48830fca4c704a5a0ecd99fa07c7)；PR：无独立 PR。

**范围：** 纯依赖基线：scoped-definition-export-base

实际审查比较基线 `c7fbe040adba`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 1035 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41807661278)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 252 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 039. `deps/script-mock-templates-base`

**结论：提交历史已纳入。** SHA：[`4f50dea63efd`](https://github.com/Hubujiu/local-api-workbench/tree/4f50dea63efdfcfec1bf2c2bfcd7b7f2ae0dd6e0)；PR：无独立 PR。

**范围：** 纯依赖基线：script-mock-templates-base

实际审查比较基线 `4f50dea63efd`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 414 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 873 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 040. `deps/sqlite-diagnostics-ci-base`

**结论：提交历史已纳入。** SHA：[`5e1354b1b5a4`](https://github.com/Hubujiu/local-api-workbench/tree/5e1354b1b5a4885a7c66a734a8a67f044412a572)；PR：无独立 PR。

**范围：** 纯依赖基线：sqlite-diagnostics-ci-base

实际审查比较基线 `5e1354b1b5a4`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 404 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41265438413)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 存储及SQLite独立审查由storage组补充；本条确认该依赖基线无需重新合并整棵旧树。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 883 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 041. `deps/wire-plan-scripts-base`

**结论：提交历史已纳入。** SHA：[`d898e4b059fd`](https://github.com/Hubujiu/local-api-workbench/tree/d898e4b059fdbac37b7e89caf6379ce3b815126d)；PR：无独立 PR。

**范围：** 纯依赖基线：wire-plan-scripts-base

实际审查比较基线 `d898e4b059fd`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 436 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享控制图使用当前 plan-step-types/plan-repeat/core；旧依赖选择性测试文件的等价断言位于 tests/plan-step-types-root.test.mjs，另保留生命周期测试。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 851 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 042. `develop`

**结论：提交历史已纳入。** SHA：[`88f70bb515c4`](https://github.com/Hubujiu/local-api-workbench/tree/88f70bb515c48b93536b28b7fe3ec780f2e150f3)；PR：[#1](https://github.com/Hubujiu/local-api-workbench/pull/1)。

**范围：** feat: local API workbench — parity gaps tracked, implementation ongoing

实际审查比较基线 `5af2f63913e0`；比较增量：707 files changed, 115766 insertions(+), 1 deletion(-)。原 main 领先 395 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40136832590)

**实际审查：**

PR #1 的早期完整应用基线，是当前候选的祖先。其累计 707 个文件变化已随后续堆栈纳入。

**整合判断：** 直接合并这一旧基线只能获得早期版本；应纳入最终候选并保留本分支历史。

**重点路径：** `src/server.mjs`、`src/core.mjs`、`src/runtime.mjs`、`.github/workflows/ci.yml`

**验证及限制：**

直接合并这一旧基线只能获得早期版本；应纳入最终候选并保留本分支历史。

### 043. `diagnostic/macos-grpc-counter-20261104`

**结论：隔离保留，不并入主线。** SHA：[`d3669c7da260`](https://github.com/Hubujiu/local-api-workbench/tree/d3669c7da260d8d79fe1f4a08317f84d00746b75)；PR：无独立 PR。

**范围：** 仅新增一份一次性macOS诊断workflow，对固定gRPC父测试最多20轮采样，严格检查每轮完整性。

实际审查比较基线 `22efe52c618e`；比较增量：1 file changed, 153 insertions(+)。原 main 领先 1102 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [One-off macOS gRPC counter diagnosis / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41918773244)

**实际审查：**

trigger只匹配本诊断分支；第一步要求唯一父commit22efe52及workflow-only delta，直接搬到main不能成为通用任务。

统计只接受预期三个测试、无skip/todo/cancelled且完整summary；失败即停止，无通过重试掩盖。

输出仅安全标签/计数/有限诊断，限定单轮60秒、总采样300秒、7天工件。

**整合判断：** 保留历史证据或归档标签；不作为产品/通用CI合入main

**发现/保留边界：**

run41918773244 success表示20轮not-reproduced，不是原计数缺陷已修复。

该分支没有生产代码增量；并入main会保留死触发和硬编码旧父限制，不改善当前验证。

**验证及限制：**

低；保存代码与原失败出处，不用其绿灯替代实际修复。

### 044. `docs/clean-machine-installer-acceptance`

**结论：提交历史已纳入。** SHA：[`a2a084904694`](https://github.com/Hubujiu/local-api-workbench/tree/a2a084904694442cf2a736a90d7086ba24610538)；PR：[#253](https://github.com/Hubujiu/local-api-workbench/pull/253)。

**范围：** docs: define clean-machine installer and signature acceptance

实际审查比较基线 `afefbef328c7`；比较增量：2 files changed, 134 insertions(+), 9 deletions(-)。原 main 领先 1275 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43702335044)

**实际审查：**

把安装介质、签名、首装、升级、卸载保留数据、重装区分为独立交付证据。文档不修改产品权限或新增安装行为。

**整合判断：** 便携包 CI、文件清单和安装器编译不证明清洁机器的真实生命周期已验收。保留文档门槛但不让其扩大本次开发主线合并的范围。

**重点路径：** `docs/INSTALLER-RELEASE-ACCEPTANCE.md`、`docs/DELIVERY-STATUS.md`

**验证及限制：**

便携包 CI、文件清单和安装器编译不证明清洁机器的真实生命周期已验收。保留文档门槛但不让其扩大本次开发主线合并的范围。

### 045. `docs/current-backend-candidate`

**结论：旧文档已被替代。** SHA：[`365af86b43be`](https://github.com/Hubujiu/local-api-workbench/tree/365af86b43be180311580d88b01db4432e8832b8)；PR：[#94](https://github.com/Hubujiu/local-api-workbench/pull/94)。

**范围：** docs: pin audited backend candidate downloads and limits

实际审查比较基线 `88f70bb515c4`；比较增量：3 files changed, 117 insertions(+), 28 deletions(-)。原 main 领先 396 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41777221170)

**实际审查：**

旧 README/DELIVERY/DESKTOP-VALIDATION 将下载入口固定到早期后端候选。当前有更晚的 DELIVERY-STATUS 与 PORTABLE-QUICKSTART。

**整合判断：** 独有文档提交不应覆盖当前索引；原分支与记录保留，当前入口改为本次整合审查。

**重点路径：** `README.md`、`docs/DELIVERY.md`、`docs/DESKTOP-VALIDATION.md`、`docs/DELIVERY-STATUS.md`

**验证及限制：**

独有文档提交不应覆盖当前索引；原分支与记录保留，当前入口改为本次整合审查。

### 046. `docs/delivery-status-235`

**结论：提交历史已纳入。** SHA：[`74762c5c4a28`](https://github.com/Hubujiu/local-api-workbench/tree/74762c5c4a282f147ce4efec35de87922a5348e0)；PR：[#236](https://github.com/Hubujiu/local-api-workbench/pull/236)。

**范围：** 实现状态与历史证据文档归并

实际审查比较基线 `ad2182e95824`；比较增量：4 files changed, 73 insertions(+), 6 deletions(-)。原 main 领先 1258 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43435024473)

**实际审查：**

把已实现、精确候选验证和仍缺证据的完整交付项分开；SQL Server 未注册、Oracle/达梦缺口、非空原生自动化、安装器/签名与完整 GUI 验收保持显式未完成。

会话至多一次启动尝试保证限定 #226 支持入口；历史 pending/旧流程标为历史，不继承为现行授权。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `README.md`、`docs/DELIVERY-STATUS.md`、`docs/PLAN.md`、`docs/BACKEND-CHECKPOINT-2026-10-25.md`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：仅文档变更；旧 run 的通过/失败只属于原 head，不能用该文档证明本轮合并后验证。

### 047. `docs/desktop-ci-checkpoint-2026-11-12`

**结论：提交历史已纳入。** SHA：[`adc150c481b0`](https://github.com/Hubujiu/local-api-workbench/tree/adc150c481b05e34b043e8e90781c57e7d7591d6)；PR：[#211](https://github.com/Hubujiu/local-api-workbench/pull/211)。

**范围：** docs: reconcile verified desktop journey checkpoint and preserve prior CI results

实际审查比较基线 `adf8dbbf2efc`；比较增量：3 files changed, 45 insertions(+), 6 deletions(-)。原 main 领先 1217 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43166478906)

**实际审查：**

更新桌面重启验收检查点，明确#210具体head/tree和43/43任务成功，并将#209三平台备份下载失败保留为历史失败。

文档区分浏览器/服务重启、真实打包Electron旅程与安装器/签名/崩溃恢复范围；未把上传成功当ZIP完整验证，也未宣布SQLServer/Oracle产品化。需与本次整合报告并列作为有日期历史。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：桌面生命周期和三平台差异依赖完整打包 CI；测试范围及正常退出/强制终止证据不得混淆。

### 048. `docs/standalone-parity-delivery-20261117`

**结论：提交历史已纳入。** SHA：[`65819ce3b937`](https://github.com/Hubujiu/local-api-workbench/tree/65819ce3b9379ca41c6738ac58e2ec3fffa183e6)；PR：[#260](https://github.com/Hubujiu/local-api-workbench/pull/260)。

**范围：** docs: reconcile current Apipost standalone parity and delivery gates

实际审查比较基线 `19bd7cbd57c9`；比较增量：2 files changed, 38 insertions(+), 3 deletions(-)。原 main 领先 1282 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/44074994191)

**实际审查：**

按单机任务重新整理功能与交付矩阵，区分本地 AI 执行计划和传统团队自动化、SQLite 附加能力和目标数据库缺口。

**整合判断：** 此分支只整理文档，本轮引用其既有范围，不把所链接厂商材料当重新调研或实现证明。

**重点路径：** `docs/STANDALONE-PARITY.md`、`docs/DELIVERY-STATUS.md`

**验证及限制：**

此分支只整理文档，本轮引用其既有范围，不把所链接厂商材料当重新调研或实现证明。

### 049. `docs/verified-portable-candidate-247`

**结论：提交历史已纳入。** SHA：[`b5e4899b27e3`](https://github.com/Hubujiu/local-api-workbench/tree/b5e4899b27e3986c8044ed31a0e624eac8654a0c)；PR：[#248](https://github.com/Hubujiu/local-api-workbench/pull/248)。

**范围：** 精确 #247 便携包验收文档更新

实际审查比较基线 `794cff388991`；比较增量：2 files changed, 55 insertions(+), 31 deletions(-)。原 main 领先 1270 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43678634064)

**实际审查：**

将 quickstart/交付矩阵更新到精确候选的三平台下载后正常与崩溃重启证据，并保留 #235 历史记录。

仍明确安装器/签名、完整 GUI、Oracle/达梦及非空原生自动化未完成；历史 macOS 间歇失败不因新绿灯被追溯改判。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `docs/DELIVERY-STATUS.md`、`docs/PORTABLE-QUICKSTART.md`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：docs-only；本次最终合并 head 必须以自己的验证结果为准。

### 050. `docs/verified-portable-quickstart`

**结论：提交历史已纳入。** SHA：[`c1048acd527c`](https://github.com/Hubujiu/local-api-workbench/tree/c1048acd527cd94a3f7543b6977ca03f5a8a2c1e)；PR：[#240](https://github.com/Hubujiu/local-api-workbench/pull/240)。

**范围：** 已验证便携包快速开始与下载验证边界

实际审查比较基线 `3a8d9ee8e66b`；比较增量：2 files changed, 76 insertions(+), 3 deletions(-)。原 main 领先 1261 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43475866730)

**实际审查：**

文档说明精确 commit/platform、manifest 全文件/hash/符号链接验证和下载后启动，区分字节验证与真实运行。

标注 Python 为验证 job 依赖，未变成产品运行前提；便携包不冒充正式签名安装器。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `docs/PORTABLE-DOWNLOAD-VERIFICATION.md`、`docs/PORTABLE-QUICKSTART.md`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：docs-only；文档中的历史候选验收不能直接迁移为本次新 head 的验收。

### 051. `feat/active-project-import`

**结论：提交历史已纳入。** SHA：[`07a86468726e`](https://github.com/Hubujiu/local-api-workbench/tree/07a86468726ef1bf5aaa47070890b0abf19f8330)；PR：[#4](https://github.com/Hubujiu/local-api-workbench/pull/4)。

**范围：** 活动项目自动导入

实际审查比较基线 `88f70bb515c4`；比较增量：11 files changed, 2629 insertions(+), 10 deletions(-)。原 main 领先 405 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41430628296)

**实际审查：**

数据源 URL、间隔和覆盖模式有独立校验，源凭据为进程内激活授权；复用 mcp-openapi-sync。已包含的功能历史需要随候选整合，不能据分支数量重复应用导入改动。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 882 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 11 个变化路径中 5 个与候选文件完全同 blob。

**重点路径：** `src/active-project-import.mjs`、`src/server.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/active-project-import.test.mjs

tests/auto-import-session-ownership.test.mjs

tests/openapi-server-variables.test.mjs

tests/openapi-url-query.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 052. `feat/api-definition-history`

**结论：提交历史已纳入。** SHA：[`991e6158d70f`](https://github.com/Hubujiu/local-api-workbench/tree/991e6158d70f94a0fdc255486de4d1837ad2bb43)；PR：[#97](https://github.com/Hubujiu/local-api-workbench/pull/97)。

**范围：** API 定义历史

实际审查比较基线 `8f42653300e2`；比较增量：27 files changed, 6295 insertions(+), 100 deletions(-)。原 main 领先 1039 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41806823972)

**实际审查：**

定义版本是项目本地历史，独立于运行证据和Git项目公开manifest。该祖先分支功能已在候选；最新#261对Git clone私有历史隔离的修复必须继续保留，根agent负责该新修复的专审。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 248 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 27 个变化路径中 15 个与候选文件完全同 blob。

**重点路径：** `src/request-definition-history.mjs`、`src/project-owner-projection.mjs`、`src/project-files.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/mcp-expanded.test.mjs

tests/mcp-stdio-cancellation.test.mjs

tests/native-folder-lifecycle-commit-outcome.test.mjs

tests/native-folder-lifecycle-sdk.test.mjs

tests/native-wait-tasks.test.mjs

tests/openapi-server-variables.test.mjs

tests/plan-failure-policy-root-owner.test.mjs

tests/project-missing-file-http.test.mjs

tests/project-owner-projection.test.mjs

tests/request-definition-history-files.test.mjs

tests/request-definition-history-model.test.mjs

tests/request-definition-history-process-files.test.mjs

tests/request-definition-history-stdio-transport.test.mjs

tests/request-definition-history-store.test.mjs

tests/request-definition-history-transports.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 053. `feat/apipost-auth-import`

**结论：提交历史已纳入。** SHA：[`426d423fbbfa`](https://github.com/Hubujiu/local-api-workbench/tree/426d423fbbfaf09fbba541d3a3330a494efd8bc9)；PR：[#8](https://github.com/Hubujiu/local-api-workbench/pull/8)。

**范围：** Apipost 认证导入

实际审查比较基线 `7e1f5b78f00f`；比较增量：12 files changed, 1290 insertions(+), 8 deletions(-)。原 main 领先 404 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40465267461)

**实际审查：**

认证来源与 noauth 覆盖是数据合同的一部分；候选保留原生认证映射并由共享运行时处理。与 #14 导出及 #74 OAuth2 回归联合核对，未发现把导入标记静默丢弃的整合缺口。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 883 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 12 个变化路径中 3 个与候选文件完全同 blob。

**重点路径：** `src/apipost-auth-import.mjs`、`src/apipost-modern.mjs`、`src/runtime.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/apipost-auth-import.test.mjs

tests/apipost-noauth-import.test.mjs

tests/aws-query-signature.test.mjs

tests/interchange-noauth-import.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 054. `feat/apipost-database-tasks`

**结论：提交历史已纳入。** SHA：[`23871b56ff21`](https://github.com/Hubujiu/local-api-workbench/tree/23871b56ff21905ab1f9c75dfef5bdbf6b365edd)；PR：[#9](https://github.com/Hubujiu/local-api-workbench/pull/9)。

**范围：** 原生数据库任务与脚本前后置阶段

实际审查比较基线 `9a99f763159e`；比较增量：35 files changed, 4111 insertions(+), 54 deletions(-)。原 main 领先 416 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40311061527)

**实际审查：**

原生数据库任务进入既有 native phase，core 在 before/after 显式调用；数据库授权按项目和来源绑定。Redis SET 使用另一个 owner 授权通道，普通 Agent/CLI 路径不能凭导入任务得到写权限。真实外部数据库验收依赖 CI 专项，不由本地 loopback 测试替代。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 871 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 35 个变化路径中 10 个与候选文件完全同 blob。

**重点路径：** `src/apipost-database-import.mjs`、`src/native-task-phase.mjs`、`src/script-database-tasks.mjs`、`src/core.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/apipost-database-import.test.mjs

tests/mongodb-cancellation.test.mjs

tests/native-mongodb-tasks.test.mjs

tests/native-redis-tasks.test.mjs

tests/native-ssh-policy.test.mjs

tests/native-task-mcp.test.mjs

tests/native-task-phase.test.mjs

tests/native-task-plan.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 055. `feat/apipost-multiple-fields`

**结论：提交历史已纳入。** SHA：[`7aec51b68430`](https://github.com/Hubujiu/local-api-workbench/tree/7aec51b68430c73b1dc4a88e59deb3b500d400bf)；PR：[#174](https://github.com/Hubujiu/local-api-workbench/pull/174)。

**范围：** feat: support bounded multiple native field expressions

实际审查比较基线 `8017694ac244`；比较增量：15 files changed, 1127 insertions(+), 18 deletions(-)。原 main 领先 1171 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42997195986)

**实际审查：**

Header/表单/正文支持多个白名单表达式；解析器按初始表达式序列处理、禁止混入共享自定义函数，Query仍要求单个完整表达式。

核查单请求20阶段、5秒共享deadline与64KiB累计结果限制，保留JS替换符兼容规则且禁止Header换行；导入、UI与真实HTTP/备份测试有覆盖。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 056. `feat/aws-query-presigning`

**结论：提交历史已纳入。** SHA：[`7e1f5b78f00f`](https://github.com/Hubujiu/local-api-workbench/tree/7e1f5b78f00f50ab3e5258f71c113ae3e332316e)；PR：[#22](https://github.com/Hubujiu/local-api-workbench/pull/22)。

**范围：** AWS Query 预签名

实际审查比较基线 `88f70bb515c4`；比较增量：6 files changed, 1036 insertions(+), 6 deletions(-)。原 main 领先 396 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40322324209)

**实际审查：**

预签名经共享请求运行时和认证模型进入发送；保留明确 query 形式和时效参数，不应重置后来 HTTP header/body 规则。分支本身是候选祖先，独立合并没有额外业务增量。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 891 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 6 个变化路径中 2 个与候选文件完全同 blob。

**重点路径：** `src/aws-signature.mjs`、`src/runtime.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/aws-query-signature.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 057. `feat/bounded-load-redirect`

**结论：提交历史已纳入。** SHA：[`41d542866a6d`](https://github.com/Hubujiu/local-api-workbench/tree/41d542866a6dfced42f548ff73dd00a7b7071d41)；PR：[#171](https://github.com/Hubujiu/local-api-workbench/pull/171)。

**范围：** feat: bound same-origin redirect load runs with shared network budget

实际审查比较基线 `8a0060133059`；比较增量：17 files changed, 1204 insertions(+), 16 deletions(-)。原 main 领先 1166 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42986830600)

**实际审查：**

为普通与阶段压测加入仅进程内可持有的网络预算能力；每次连接前reserve、真正发送时start，所有重定向hop共享100次上限且不退款。

准入按展开步骤×迭代×最坏hop预计算，混合计划逐叶检查认证与脚本/动态函数；耗尽在下次连接前中止，报告区分逻辑请求与真实网络次数。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 058. `feat/bounded-plan-repeat`

**结论：语义已整合或由后续实现替代。** SHA：[`adc89ac359eb`](https://github.com/Hubujiu/local-api-workbench/tree/adc89ac359ebb0999b6f081213693c75878dc0ed)；PR：[#44](https://github.com/Hubujiu/local-api-workbench/pull/44)。

**范围：** canonical 递归有界 repeat

实际审查比较基线 `f540b5246f03`；比较增量：35 files changed, 7542 insertions(+), 43 deletions(-)。原 main 领先 595 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41005210249)

**实际审查：**

step identity 模块和14项相关文件同 blob。当前 repeat 已扩展 IF/until/runtime rows，但仍先遍历 disabled/false 分支计入潜在预算，限制深度、执行数和证据大小；nested snapshot 回归通过。旧递归实现不能覆盖这些后续能力。

**整合判断：** 非祖先且有 21 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 35 个变化路径中 14 个与候选文件完全同 blob。

**重点路径：** `src/plan-repeat.mjs`、`src/plan-step-identities.mjs`、`src/core.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/plan-repeat-nested-snapshot.test.mjs

**available_branch_tests**：tests/mcp-activity.test.mjs

tests/plan-repeat-consumers.test.mjs

tests/plan-repeat-evidence-limit.test.mjs

tests/plan-repeat-grpc-model.test.mjs

tests/plan-repeat-grpc-workflow.test.mjs

tests/plan-repeat-nested-model.test.mjs

tests/plan-repeat-nested-snapshot.test.mjs

tests/plan-repeat-socketio-model.test.mjs

tests/plan-repeat-socketio-workflow.test.mjs

tests/plan-repeat-tcp-model.test.mjs

tests/plan-repeat-tcp-workflow.test.mjs

tests/plan-repeat-wire-model.test.mjs

tests/plan-repeat-wire-workflow.test.mjs

tests/plan-repeat-workflow.test.mjs

tests/plan-repeat.test.mjs

tests/plan-step-identities-workflow.test.mjs

tests/plan-step-identities.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 059. `feat/bounded-same-origin-http-redirects`

**结论：语义已整合或由后续实现替代。** SHA：[`f631fc6242e4`](https://github.com/Hubujiu/local-api-workbench/tree/f631fc6242e4c79fb0c12e8af5ee91fb414e0ac5)；PR：[#50](https://github.com/Hubujiu/local-api-workbench/pull/50)。

**范围：** 同源有界 HTTP redirect

实际审查比较基线 `1f4598253ced`；比较增量：16 files changed, 2493 insertions(+), 3 deletions(-)。原 main 领先 401 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40661188761)

**实际审查：**

独立 redirect 单元/SDK/传输测试与旧分支同 blob。当前 runtime 在任意 proxy tunnel 前校验最终生成 headers，并限制跳转 origin/数量/总时限；入口回归通过。后续 load redirect 能力应随候选保留。

**整合判断：** 非祖先且有 5 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 16 个变化路径中 7 个与候选文件完全同 blob。

**重点路径：** `src/http-redirect.mjs`、`src/http-redirect-transport.mjs`、`src/runtime.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/http-redirect-entrypoints.test.mjs

**available_branch_tests**：tests/http-redirect-cookie-deadline.test.mjs

tests/http-redirect-definition-guards.test.mjs

tests/http-redirect-entrypoints.test.mjs

tests/http-redirect-runtime.test.mjs

tests/http-redirect-script-policy.test.mjs

tests/http-redirect-sdk.test.mjs

tests/http-redirect-storage.test.mjs

tests/http-redirect-transports.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 060. `feat/canonical-grpc-until-20261106`

**结论：提交历史已纳入。** SHA：[`0e2d83067e54`](https://github.com/Hubujiu/local-api-workbench/tree/0e2d83067e54ac172496ca96d66feca7229ce731)；PR：[#147](https://github.com/Hubujiu/local-api-workbench/pull/147)。

**范围：** feat: admit canonical gRPC repeat-until

实际审查比较基线 `2021566bc780`；比较增量：7 files changed, 1568 insertions(+), 32 deletions(-)。原 main 领先 1136 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42148923328)

**实际审查：**

gRPC repeat-until接入统一控制能力表，并同步MCP说明；四种RPC模式仍走既有独立调用生命周期。

核对until只扩gRPC叶子而不悄然放宽runtimeRows；回归覆盖假IF预检、凭据、mTLS、终止/溢出、未知提交停止与无重放。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 061. `feat/canonical-if`

**结论：语义已整合或由后续实现替代。** SHA：[`b839507e7bdf`](https://github.com/Hubujiu/local-api-workbench/tree/b839507e7bdf9aa93f6eae1b2be919126eed256f)；PR：[#91](https://github.com/Hubujiu/local-api-workbench/pull/91)。

**范围：** canonical IF 控制节点

实际审查比较基线 `2e9d8fdbdeca`；比较增量：18 files changed, 3268 insertions(+), 39 deletions(-)。原 main 领先 609 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41770183933)

**实际审查：**

IF模块后续增加iterationData和contains/notContains，仍拒绝隐式类型转换。false/disabled分支仍做结构和资源授权预检，执行/历史/取消使用同一冻结图；owner回归通过。

**整合判断：** 非祖先且有 33 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 18 个变化路径中 6 个与候选文件完全同 blob。

**重点路径：** `src/plan-condition.mjs`、`src/plan-repeat.mjs`、`src/core.mjs`、`src/mcp-activity.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/plan-if-owner.test.mjs

**available_branch_tests**：tests/plan-if-boundaries.test.mjs

tests/plan-if-cli.test.mjs

tests/plan-if-mcp.test.mjs

tests/plan-if-owner.test.mjs

tests/plan-if-progress-failure.test.mjs

tests/plan-if.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 062. `feat/canonical-if-grpc`

**结论：提交历史已纳入。** SHA：[`7205b0eb5d4c`](https://github.com/Hubujiu/local-api-workbench/tree/7205b0eb5d4c9aef0bc1023634d8068b314ab0f8)；PR：[#122](https://github.com/Hubujiu/local-api-workbench/pull/122)。

**范围：** Support canonical IF gRPC with independent executor preflight

实际审查比较基线 `b0c09c8e88d3`；比较增量：10 files changed, 958 insertions(+), 11 deletions(-)。原 main 领先 1107 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42067978365)

**实际审查：**

IF允许gRPC并递归检查grpcScripts；执行前收集条件gRPC ID，先检查执行授权再允许早期HTTP发生。

未知PROJECT_COMMIT_UNCERTAIN对象/code都将scopeCommit标unknown并停止；禁用定义仍静态校验，运行时不执行。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 063. `feat/canonical-socketio-until-20261106`

**结论：提交历史已纳入。** SHA：[`bd57ba40cc88`](https://github.com/Hubujiu/local-api-workbench/tree/bd57ba40cc88d9f6472c700804a10480d4fc3c27)；PR：[#150](https://github.com/Hubujiu/local-api-workbench/pull/150)。

**范围：** feat: admit canonical Socket.IO repeat-until

实际审查比较基线 `cd7f96497890`；比较增量：9 files changed, 1503 insertions(+), 14 deletions(-)。原 main 领先 1139 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42154786257)

**实际审查：**

Socket.IO repeat-until按能力表增加独立socketio叶子；没有把它伪装成wire protocol。

核对runtimeRows仍受祖先约束；回归覆盖v2/v4、polling/websocket、逐轮独立响应、取消与ACK/提交未知不重放。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 064. `feat/canonical-sse-until-20261106`

**结论：提交历史已纳入。** SHA：[`c1f8aa65cc80`](https://github.com/Hubujiu/local-api-workbench/tree/c1f8aa65cc805e72602e53de627184f81323e31d)；PR：[#152](https://github.com/Hubujiu/local-api-workbench/pull/152)。

**范围：** feat: admit canonical SSE repeat-until

实际审查比较基线 `f981d31555a7`；比较增量：10 files changed, 1360 insertions(+), 15 deletions(-)。原 main 领先 1142 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42160577011)

**实际审查：**

SSE repeat-until只扩until.protocols中的sse能力，既有捕获与截止语义保持。

回归覆盖EOF/时长/事件上限、partial与completed区分、POST逐次副作用、无自动重连、取消停止tail；原head CI失败不可改写为成功，但当前候选包含增量。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 065. `feat/canonical-ws-until-20261106`

**结论：提交历史已纳入。** SHA：[`59d563369704`](https://github.com/Hubujiu/local-api-workbench/tree/59d563369704ac5f66ce20c568ff2cc202804eda)；PR：[#145](https://github.com/Hubujiu/local-api-workbench/pull/145)。

**范围：** feat: admit canonical WebSocket repeat-until plans

实际审查比较基线 `62c442a351c8`；比较增量：10 files changed, 1236 insertions(+), 21 deletions(-)。原 main 领先 1133 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42143054949)

**实际审查：**

WebSocket repeat-until扩展统一until能力及MCP说明，未扩大其他protocol别名。

核对runtime-row祖先限制在当时仍保留，后续另分支显式开放；真实第二轮挂起取消、冻结引用与提交不确定回归覆盖。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 066. `feat/cli-database-grants`

**结论：提交历史已纳入。** SHA：[`a3ffbcd00134`](https://github.com/Hubujiu/local-api-workbench/tree/a3ffbcd00134d5846b2a8550a5d096cec9139b7f)；PR：[#2](https://github.com/Hubujiu/local-api-workbench/pull/2)。

**范围：** CLI 临时数据库授权

实际审查比较基线 `88f70bb515c4`；比较增量：8 files changed, 811 insertions(+), 8 deletions(-)。原 main 领先 401 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40275759477)

**实际审查：**

入口先校验计划类型与活动叶子，再收集必需连接；stdin 凭据属于本次调用，不写入冻结计划。当前实现已支持递归控制图，不能用旧分支文件覆盖。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 886 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 8 个变化路径中 4 个与候选文件完全同 blob。

**重点路径：** `src/cli-database-grants.mjs`、`src/cli-runtime-credentials.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/cli-database-grants.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 067. `feat/curl-attached-short-options`

**结论：提交历史已纳入。** SHA：[`51cf36703497`](https://github.com/Hubujiu/local-api-workbench/tree/51cf36703497a951ff09c7c03d4eb460ad49bc71)；PR：[#178](https://github.com/Hubujiu/local-api-workbench/pull/178)。

**范围：** feat: support bounded attached curl short option values

实际审查比较基线 `4fb12a92b086`；比较增量：4 files changed, 372 insertions(+), 4 deletions(-)。原 main 领先 1176 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43008027539)

**实际审查：**

cURL导入支持-XPOST/-Hname:value/-dtext，只在选项位置拆分短选项。

已被-H/-d/--url消费的值不再次当选项；既有shell/文件输入、冲突body和未知参数仍拒绝，有实际curl线等价测试。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 068. `feat/database-session-read-revocation`

**结论：语义已整合或由后续实现替代。** SHA：[`a18ff714dfc9`](https://github.com/Hubujiu/local-api-workbench/tree/a18ff714dfc9cfd9e67b58f5ea23cf70681b84fb)；PR：[#93](https://github.com/Hubujiu/local-api-workbench/pull/93)。

**范围：** 数据库会话读权限撤销

实际审查比较基线 `f147a3b0f318`；比较增量：7 files changed, 1397 insertions(+), 17 deletions(-)。原 main 领先 454 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41777522633)

**实际审查：**

原撤销测试完全同blob。当前同一会话对象/代次在await source校验前后均复核，revoke后重新登记同alias不能复活捕获授权；新增batch授权及native写捕获仍沿用身份校验。

**整合判断：** 非祖先且有 4 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 7 个变化路径中 3 个与候选文件完全同 blob。

**重点路径：** `src/database-sessions.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/database-session-revoke.test.mjs

**available_branch_tests**：tests/cli-database-grants.test.mjs

tests/database-session-revoke-consumers.test.mjs

tests/database-session-revoke-identity.test.mjs

tests/database-session-revoke-resources.test.mjs

tests/database-session-revoke.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 069. `feat/graphql-variable-strings`

**结论：提交历史已纳入。** SHA：[`89a3681dca42`](https://github.com/Hubujiu/local-api-workbench/tree/89a3681dca424676ef521c2e4598d3123b890843)；PR：[#172](https://github.com/Hubujiu/local-api-workbench/pull/172)。

**范围：** feat: safely resolve GraphQL variable string placeholders

实际审查比较基线 `41d542866a6d`；比较增量：13 files changed, 777 insertions(+), 16 deletions(-)。原 main 领先 1168 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42992079055)

**实际审查：**

GraphQL仅完整字符串占位符替换，保留原JSON数字字面量、空白及转义；标记版本1与raw/bodyDynamic冲突均显式校验。

核查重复键、64层/100000节点、100占位符、每值64KiB及总1MiB限制，拒绝变量getter/proxy与非字符串；运行前解析，无法保存合同的导出和直接传输入口拒绝。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 070. `feat/grpc-live-sessions`

**结论：提交历史已纳入。** SHA：[`406f40036fe0`](https://github.com/Hubujiu/local-api-workbench/tree/406f40036fe041d72af713a7dc98c7f230a812fd)；PR：[#80](https://github.com/Hubujiu/local-api-workbench/pull/80)。

**范围：** gRPC 交互流会话

实际审查比较基线 `5bec1b033c91`；比较增量：12 files changed, 2792 insertions(+), 32 deletions(-)。原 main 领先 421 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41256942651)

**实际审查：**

session 按 projectId 取用，client-stream 要求显式 send，不接受隐式 initial message；证据最多50条，仅清理已终止且已保存会话。后续会话 UI/MCP 管理属于已继承能力，不能从旧分支覆盖。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 866 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 12 个变化路径中 5 个与候选文件完全同 blob。

**重点路径：** `src/grpc-sessions.mjs`、`src/grpc-session-evidence.mjs`、`src/grpc-slots.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/grpc-live-sessions-workflow.test.mjs

tests/grpc-session-state.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 071. `feat/grpc-plan-scripts`

**结论：提交历史已纳入。** SHA：[`0c515c90668e`](https://github.com/Hubujiu/local-api-workbench/tree/0c515c90668e292c4476bcb9812dd21c9d8d2752)；PR：[#79](https://github.com/Hubujiu/local-api-workbench/pull/79)。

**范围：** gRPC 计划前后脚本

实际审查比较基线 `ecb8dc59c566`；比较增量：12 files changed, 1444 insertions(+), 7 deletions(-)。原 main 领先 427 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41254879167)

**实际审查：**

脚本 context 与 shared phase 适配仍存在，core 的协议分支没有降回 HTTP 请求形状。导入凭据必须来自显式运行时输入，不从历史记录或 metadata 推断；独立脚本 workflow 的环境覆盖依赖完整 CI。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 860 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 12 个变化路径中 4 个与候选文件完全同 blob。

**重点路径：** `src/grpc-plan-scripts.mjs`、`src/grpc-script-context.mjs`、`src/core.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/grpc-plan-credentials.test.mjs

tests/grpc-plan-scripts-workflow.test.mjs

tests/grpc-plan-scripts.test.mjs

tests/grpc-script-context-pure.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 072. `feat/grpc-request-example`

**结论：提交历史已纳入。** SHA：[`70c08f1d7b58`](https://github.com/Hubujiu/local-api-workbench/tree/70c08f1d7b58844909bc6c349e60523a08760b73)；PR：[#100](https://github.com/Hubujiu/local-api-workbench/pull/100)。

**范围：** gRPC 请求示例生成

实际审查比较基线 `3875f89be57b`；比较增量：8 files changed, 333 insertions(+), 6 deletions(-)。原 main 领先 1057 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41834023073)

**实际审查：**

从descriptor生成有界示例数据，不等于执行远端RPC；reflection和示例工具在owner/MCP两入口均保留，proto复杂性和消息大小边界继续由当前gRPC schema实现限制。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 230 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 8 个变化路径中 5 个与候选文件完全同 blob。

**重点路径：** `src/grpc-request-example.mjs`、`src/grpc-schema.mjs`、`src/mcp.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/grpc-reflection.test.mjs

tests/grpc-request-example.test.mjs

tests/mcp-expanded.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 073. `feat/grpc-stream-workbench`

**结论：提交历史已纳入。** SHA：[`d2d0900b4de2`](https://github.com/Hubujiu/local-api-workbench/tree/d2d0900b4de2f52b85315593f3898f97c5260bf5)；PR：[#231](https://github.com/Hubujiu/local-api-workbench/pull/231)。

**范围：** gRPC 交互式流控制、半关闭和终态记录核对

实际审查比较基线 `00e197c57477`；比较增量：10 files changed, 1859 insertions(+), 4 deletions(-)。原 main 领先 1246 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43391521738)

**实际审查：**

启动前只读 inspect 已保存定义，区分 unary/client/server/bidi 及初始请求规则，拒绝模式错误。

创建/发送/半关闭前写入恢复证据；snapshot 验证 ID/type/lifecycle/messages/receiptState，未知发送保持并禁止重放。

cancel/reconcile 与业务发送隔离；终态取消结果不被迟到 send 覆盖；reconcile 最多重试存储，不重新发起业务流。

创建 unknown-start 可被 sessionStorage 恢复，但只有成功 start 代码能清除，而 start 自身先拒绝 true；该保守恢复限制另列 P2。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/grpc-stream-workbench.js`、`public/app.js`、`tests/grpc-stream-workbench.test.mjs`、`tests/grpc-stream-app-adapter.test.mjs`、`tests/helpers/grpc-stream-ui.mjs`

**发现/保留边界：**

**severity**：P2

**category**：non-blocking product recovery limitation

**path**：public/grpc-stream-workbench.js

**line**：187

**title**：未知创建结果缺少可核对后结束该事件的产品流程

**repro_or_basis**：start 在行238先设 uncertainStart=true 并 persist；创建回执丢失/迟到或标记持久化失败后保留 true。poll/cancel/reconcile 不将它清 false；下次 requireNew 行187先拒绝。只有 start 成功回执路径行248清 false，而该路径受同一前置门禁阻止。tests/grpc-stream-workbench.test.mjs 明确断言 restored unknown-start 不能经手动 ID GET 清除。

**impact**：在当前项目恢复证据生命周期内可能长期只能读取/停止，无法创建新会话；保守防重放意图本身正确。

**recommendation**：后续引入绑定服务实例和创建操作 ID 的明确核对/终止流程，保留原未知业务结果证据；不能以任意清标记或自动重放绕过。

**merge_blocking**：否

**basis_scope**：当前行为与明确保守测试合同一致，不是被遗漏旧分支可以修复的回归。

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：活动期限与消息上限不随刷新续期；真实外部 gRPC 服务兼容性没有在本次本地运行。

### 074. `feat/grpc-unary-ui`

**结论：提交历史已纳入。** SHA：[`4fb255128763`](https://github.com/Hubujiu/local-api-workbench/tree/4fb2551287632888eec02bc23937bca2db768d16)；PR：[#229](https://github.com/Hubujiu/local-api-workbench/pull/229)。

**范围：** gRPC unary 工作台定义、临时凭据和单次执行

实际审查比较基线 `5d0a983ab7a5`；比较增量：12 files changed, 1610 insertions(+), 6 deletions(-)。原 main 领先 1243 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43323128868)

**实际审查：**

definitionOf 只提取可保存定义；临时 metadata/CA/cert/key 不进入定义保存，离开视图清除。

controller 用 generation/revision/token/current 检查异步结果；迟到执行回执保留为需核对证据，不自动重试。

app adapter 的 busy 只由对应 owner token 释放；grpc-run 进入项目 execution guard，recordSaved 不为 true 或异常时要求 reconciliation。

saveDefinition 先拒绝其他未保存草稿；保存失败仅用 #221 的明确未提交、同 owner/version 回滚许可。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/grpc-unary-workbench.js`、`public/app.js`、`tests/grpc-unary-workbench.test.mjs`、`tests/grpc-unary-app-adapter.test.mjs`、`tests/helpers/grpc-unary-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：reflection 属网络操作，schema/example 边界单独处理；本地取消不等于远端未执行。

### 075. `feat/if-socketio-plans-20261105`

**结论：提交历史已纳入。** SHA：[`c65809fa8377`](https://github.com/Hubujiu/local-api-workbench/tree/c65809fa83776222efabbe8a4f54542dbb345c57)；PR：[#123](https://github.com/Hubujiu/local-api-workbench/pull/123)。

**范围：** Support canonical IF Socket.IO with independent executor preflight

实际审查比较基线 `7205b0eb5d4c`；比较增量：7 files changed, 993 insertions(+), 7 deletions(-)。原 main 领先 1108 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42070839642)

**实际审查：**

Socket.IO IF增加独立executor预检、条件ID收集及提交未知fail-stop。

原子抽取/条件图能力与禁用节点规则保留；测试跨版本、SDK HTTP/stdio、CLI、恢复和取消。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 076. `feat/if-socketio-upload-20261105`

**结论：语义已整合或由后续实现替代。** SHA：[`e0214a68b9dd`](https://github.com/Hubujiu/local-api-workbench/tree/e0214a68b9dd6ec9b14db2d70534cbd74412e74e)；PR：无独立 PR。

**范围：** Prepare reviewed canonical IF Socket.IO: tests/plan-if-tcp-model.test.mjs

实际审查比较基线 `7205b0eb5d4c`；比较增量：7 files changed, 993 insertions(+), 7 deletions(-)。原 main 领先 1114 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是按文件上传的 canonical IF Socket.IO 过渡分支。候选保留模型、执行与工作流测试，随后扩展 until/runtime rows 支持，并将未知作用域提交改为停止后续执行。

**整合判断：** 旧分支对 until/runtime rows 的拒绝和未知提交继续运行断言已过时；整支回放会退化当前合同。

**重点路径：** `src/plan-repeat.mjs`、`src/core.mjs`、`tests/plan-if-socketio-model.test.mjs`、`tests/plan-if-socketio-workflow.test.mjs`、`tests/plan-if-boundaries.test.mjs`

**验证及限制：**

旧分支对 until/runtime rows 的拒绝和未知提交继续运行断言已过时；整支回放会退化当前合同。

### 077. `feat/integrated-plan-controls`

**结论：提交历史已纳入。** SHA：[`90683f02c8eb`](https://github.com/Hubujiu/local-api-workbench/tree/90683f02c8ebfae7135ef35df75b359bbae29404)；PR：[#220](https://github.com/Hubujiu/local-api-workbench/pull/220)。

**范围：** 将可视化控制编辑整合到执行所有权基线

实际审查比较基线 `38717504f6b6`；比较增量：7 files changed, 879 insertions(+), 2 deletions(-)。原 main 领先 1231 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43205650635)

**实际审查：**

相对 #218 的改动与 #219 相对基线的补丁相同，实际接线保留 if/repeat 编辑、类型摘要及严格输入验证。

候选沿 #220 保留整合结果；不需要把 #219 再 merge 一次。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/plan-control-editor.js`、`public/plan-view.js`、`public/step-editor.js`、`tests/plan-control-editor.test.mjs`、`tests/helpers/plan-control-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：复用 #219 控制器审查；后续 #223 提供结构变更，未把参数编辑本身当作任意结构重组。

### 078. `feat/integrated-plan-structure-diagnostics`

**结论：提交历史已纳入。** SHA：[`192c6985934d`](https://github.com/Hubujiu/local-api-workbench/tree/192c6985934d9e17b7e923733d56e10acd34c607)；PR：[#224](https://github.com/Hubujiu/local-api-workbench/pull/224)。

**范围：** 结构编辑基线上的 heap 失败诊断整合

实际审查比较基线 `c9606aefa6a9`；比较增量：3 files changed, 120 insertions(+), 9 deletions(-)。原 main 领先 1234 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43282971604)

**实际审查：**

相对 #223 的新增诊断补丁与 #222 相同，三文件与候选一致。

只扩展测试失败输出，不改变生产 QuickJS 行为、活动预算或通过条件。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `tests/helpers/heap-workflow-diagnostics.mjs`、`tests/quickjs-heap-workflow.test.mjs`、`tests/worker-rejection-diagnostics.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：复用 #222 诊断审查；绿色诊断测试不代表历史偶发失败根因已消失。

### 079. `feat/live-collection-scopes-20261105`

**结论：提交历史已纳入。** SHA：[`9cc387488a17`](https://github.com/Hubujiu/local-api-workbench/tree/9cc387488a17e7f20c457f2d512b4db782b92624)；PR：[#137](https://github.com/Hubujiu/local-api-workbench/pull/137)。

**范围：** feat: admit matching collection scopes in live HTTP plans

实际审查比较基线 `f9b238160213`；比较增量：4 files changed, 519 insertions(+), 6 deletions(-)。原 main 领先 1124 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42123430996)

**实际审查：**

实时计划允许Postman collection，先校验整个引用图，再冻结当前定义。

要求当前source collection ID等于任务template ID，身份改变必须重建；包括disabled/frozen sibling，防止计划悄然换作用域。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 080. `feat/live-plan-references`

**结论：本轮补回遗漏回归和历史。** SHA：[`75c88ae0d345`](https://github.com/Hubujiu/local-api-workbench/tree/75c88ae0d345b64837abb6637efac7e775adb472)；PR：[#106](https://github.com/Hubujiu/local-api-workbench/pull/106)。

**范围：** Freeze live HTTP plan references at execution

实际审查比较基线 `0aca69513970`；比较增量：16 files changed, 1187 insertions(+), 43 deletions(-)。原 main 领先 1081 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41864520357)

**实际审查：**

实时接口引用、一次性冻结、环境绑定、CLI/MCP 接线均已整合。发现最后一个 75c88ae 预取消 MCP 回归测试遗漏；三方合并只新增 82 行测试，保留已升级的 Postman collection/runtime rows 实现。

**整合判断：** 补回后整个 live-plan-workflow 6/6 通过：预取消不发送 HTTP、不执行脚本，并保存可读取的 cancelled 证据。

**重点路径：** `src/live-plan-reference.mjs`、`src/live-plan-materialize.mjs`、`tests/live-plan-workflow.test.mjs`、`src/mcp.mjs`

**验证及限制：**

补回后整个 live-plan-workflow 6/6 通过：预取消不发送 HTTP、不执行脚本，并保存可读取的 cancelled 证据。

### 081. `feat/load-collection-scopes-20261105`

**结论：提交历史已纳入。** SHA：[`77bfc8081250`](https://github.com/Hubujiu/local-api-workbench/tree/77bfc8081250540c03d0b9513124218191135473)；PR：[#135](https://github.com/Hubujiu/local-api-workbench/pull/135)。

**范围：** feat: isolate collection variable scopes in HTTP load runs

实际审查比较基线 `f7a510947508`；比较增量：5 files changed, 385 insertions(+), 9 deletions(-)。原 main 领先 1122 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42115268922)

**实际审查：**

单请求压测按绑定collection构建作用域，每次runPlan创建私有session。

owner入口debugEnvironment也传collection ID；取消/并发迭代和脚本失败不持久化collection写入，重定向仍独立受控。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 082. `feat/load-receipts-mcp-read`

**结论：提交历史已纳入。** SHA：[`22029af311fb`](https://github.com/Hubujiu/local-api-workbench/tree/22029af311fb218be5790ea33fbe5595adad7189)；PR：[#181](https://github.com/Hubujiu/local-api-workbench/pull/181)。

**范围：** feat: expose saved load receipts through read-only MCP tools

实际审查比较基线 `39a2a2ca9df9`；比较增量：6 files changed, 988 insertions(+), 4 deletions(-)。原 main 领先 1180 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43018414520)

**实际审查：**

新增MCP只读收据列表/详情，授权项目和固定参数集合先校验，读取前后检查取消，绝不恢复pending或执行请求。

只投影并完整校验loadRuns字段；最大60条、1MiB、详情UUID与RPC字节限制，未知敏感字段不静默丢弃，Store错误不读取属性且仅返回固定错误码。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 083. `feat/load-report-classification`

**结论：提交历史已纳入。** SHA：[`8017694ac244`](https://github.com/Hubujiu/local-api-workbench/tree/8017694ac244b5253e34ed35f2c1aa8bae16ae07)；PR：[#173](https://github.com/Hubujiu/local-api-workbench/pull/173)。

**范围：** feat: classify load report failures without changing status policy

实际审查比较基线 `89a3681dca42`；比较增量：13 files changed, 849 insertions(+), 3 deletions(-)。原 main 领先 1169 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42992457755)

**实际审查：**

压测报告增加版本化statusPolicy和固定失败原因词汇，保留原执行器通过/失败判断，单次压测与计划策略明确区分。

原因取结构化证据而非远端错误文案；阶段压测每失败step计数，整迭代同原因去重，取消/重定向/断言分开；旧历史不会被伪装成新格式。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 084. `feat/load-report-receipts`

**结论：提交历史已纳入。** SHA：[`62029bd19b2b`](https://github.com/Hubujiu/local-api-workbench/tree/62029bd19b2bf699e13c816f08b5892db84400c7)；PR：[#179](https://github.com/Hubujiu/local-api-workbench/pull/179)。

**范围：** feat: add opt-in owner load report receipts

实际审查比较基线 `51cf36703497`；比较增量：12 files changed, 1530 insertions(+), 13 deletions(-)。原 main 领先 1177 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43011545880)

**实际审查：**

可选持久化压测收据采用pending→终态单向转换，执行前存储失败阻止执行，终态保存失败保留未确认身份而不重放网络。

核查同项目文件锁内读改写、最多10pending+50terminal、幂等终态、独立私有历史文件与manifest版本；普通项目/定义导出隐藏收据，重启只保留pending不推断运行状态。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 085. `feat/manual-resource-import-plan`

**结论：提交历史已纳入。** SHA：[`2327c5295685`](https://github.com/Hubujiu/local-api-workbench/tree/2327c52956852ffc7cde4e88ecb0f0687bb0a659)；PR：[#98](https://github.com/Hubujiu/local-api-workbench/pull/98)。

**范围：** 手工资源导入预览与提交

实际审查比较基线 `991e6158d70f`；比较增量：22 files changed, 7680 insertions(+), 30 deletions(-)。原 main 领先 1042 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41808259225)

**实际审查：**

规划/预览token和实际commit分开，来源与项目身份绑定；候选后续UI ownership修复不可被旧import分支覆盖。提供HTTP/stdio planner/token/store工作流测试，当前范围验证了共享scoped-export回归。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 245 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 22 个变化路径中 11 个与候选文件完全同 blob。

**重点路径：** `src/manual-import-planner.mjs`、`src/manual-import-token.mjs`、`src/manual-import.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/manual-import-input.test.mjs

tests/manual-import-mcp.test.mjs

tests/manual-import-planner.test.mjs

tests/manual-import-source.test.mjs

tests/manual-import-stdio.test.mjs

tests/manual-import-store.test.mjs

tests/manual-import-token.test.mjs

tests/manual-import-workflows.test.mjs

tests/mcp-expanded.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 086. `feat/mcp-database-grants`

**结论：提交历史已纳入。** SHA：[`3024e59e5b64`](https://github.com/Hubujiu/local-api-workbench/tree/3024e59e5b6431d879164ca2272364fa79e0d1e9)；PR：[#10](https://github.com/Hubujiu/local-api-workbench/pull/10)。

**范围：** MCP HTTP/stdio 临时数据库授权

实际审查比较基线 `23871b56ff21`；比较增量：17 files changed, 2452 insertions(+), 57 deletions(-)。原 main 领先 427 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40312763085)

**实际审查：**

HTTP 与 stdio 授权适配器均存在，保持 project/session 来源隔离。与数据库撤销、原生写拒绝的候选接线共同核对；不能只因 stdio 已有工具名就声称所有数据库 provider 完成。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 860 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 17 个变化路径中 5 个与候选文件完全同 blob。

**重点路径：** `src/mcp-database-grants.mjs`、`src/mcp-stdio-database-grants.mjs`、`src/mcp.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/mcp-database-grants.test.mjs

tests/mcp-ssh-policy.test.mjs

tests/mcp-stdio-database-grants.test.mjs

tests/mcp-stdio-database-workflow.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 087. `feat/mcp-http-cancellation`

**结论：语义已整合或由后续实现替代。** SHA：[`b82adc210485`](https://github.com/Hubujiu/local-api-workbench/tree/b82adc210485caecf7d994a2437e0d26468e4b44)；PR：[#19](https://github.com/Hubujiu/local-api-workbench/pull/19)。

**范围：** MCP HTTP 取消与持久化等待

实际审查比较基线 `c5c588efd1a1`；比较增量：27 files changed, 4196 insertions(+), 192 deletions(-)。原 main 领先 414 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41585555226)

**实际审查：**

候选保留 HTTP session 取消、queued save 的 scope cancellation 和 progress-failure evidence 测试；等待存储锁时的取消不能偷偷提交新变量，也不能把未知提交改写成普通执行失败。共享模块后续扩展是有意整合，不宜原样合旧分支。

**整合判断：** 非祖先且有 5 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 27 个变化路径中 11 个与候选文件完全同 blob。

**重点路径：** `src/mcp-http-sessions.mjs`、`src/mcp-activity.mjs`、`src/variable-scopes.mjs`、`src/core.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/mcp-activity.test.mjs

tests/mcp-http-cancellation.test.mjs

tests/mcp-http-sessions.test.mjs

tests/mcp-progress-failure-evidence.test.mjs

tests/mcp-stateless-epoch.test.mjs

tests/mcp-stdio-cancellation.test.mjs

tests/mcp-stdio-errors-sdk.test.mjs

tests/mcp-stdio-errors.test.mjs

tests/mcp-stdio-transport.test.mjs

tests/scope-cancellation-workflow.test.mjs

tests/scope-cancellation.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 088. `feat/mcp-http-grpc-bidi`

**结论：提交历史已纳入。** SHA：[`9f794256814a`](https://github.com/Hubujiu/local-api-workbench/tree/9f794256814a54446e491681e1978af451f04658)；PR：[#185](https://github.com/Hubujiu/local-api-workbench/pull/185)。

**范围：** feat: add bounded HTTP MCP gRPC bidi sessions

实际审查比较基线 `d0d926030c9c`；比较增量：11 files changed, 1709 insertions(+), 11 deletions(-)。原 main 领先 1185 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43030362608)

**实际审查：**

HTTP MCP双向gRPC复用已有五槽池，以宿主WeakSet owner和项目绑定限制会话，operationId200项有界去重且不驱逐。

发送须本地callback和drain均完成，half-close不等同远端确认；提交后异常固定unknown，late callback不能改终态。DELETE/撤权/归档/关机先同步撤权再等待原保存，不重试持久化或网络。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 089. `feat/mcp-http-websocket-pr182`

**结论：提交历史已纳入。** SHA：[`ddf061d8f3f8`](https://github.com/Hubujiu/local-api-workbench/tree/ddf061d8f3f8ff20dfe4ccea258b2d6951017bf5)；PR：[#183](https://github.com/Hubujiu/local-api-workbench/pull/183)。

**范围：** feat: add bounded HTTP MCP WebSocket sessions

实际审查比较基线 `f1afa202d36e`；比较增量：10 files changed, 2298 insertions(+), 9 deletions(-)。原 main 领先 1182 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43022053765)

**实际审查：**

HTTP MCP WebSocket绑定逻辑会话owner而非物理连接；固定保存定义、授权+write+execute准入，操作ID先登记后异步读项目。

核查200操作共享账本、60秒显式续租与15分钟绝对上限、每页20项/4096字符、1MiB消息及共享五槽池；读不续租，撤权同步生效，未知发送不重放且终态保存需排空。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 090. `feat/mcp-project-roundtrip`

**结论：提交历史已纳入。** SHA：[`1ef5fc2f5a32`](https://github.com/Hubujiu/local-api-workbench/tree/1ef5fc2f5a329b7fcfafacd098a5f2d6cb66a044)；PR：[#29](https://github.com/Hubujiu/local-api-workbench/pull/29)。

**范围：** MCP 项目导入导出往返

实际审查比较基线 `9e033cd3a0b8`；比较增量：8 files changed, 1779 insertions(+), 3 deletions(-)。原 main 领先 549 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40509016977)

**实际审查：**

canonical backup/restore 与原生交换是不同模式，均由明确工具适配接入；候选保留 roundtrip SDK 与 inheritance SDK 测试。不能因 native export 限制而删掉完整备份路径。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 738 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 8 个变化路径中 3 个与候选文件完全同 blob。

**重点路径：** `src/mcp-project-interchange.mjs`、`src/mcp.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/mcp-expanded.test.mjs

tests/mcp-inheritance-roundtrip-sdk.test.mjs

tests/mcp-project-interchange.test.mjs

tests/mcp-project-roundtrip-sdk.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 091. `feat/mcp-stdio-grpc-bidi`

**结论：提交历史已纳入。** SHA：[`4be550df4a27`](https://github.com/Hubujiu/local-api-workbench/tree/4be550df4a279df01030ddd25a3b8dd74103a961)；PR：[#186](https://github.com/Hubujiu/local-api-workbench/pull/186)。

**范围：** feat: add bounded stdio MCP gRPC bidi sessions

实际审查比较基线 `9f794256814a`；比较增量：13 files changed, 1383 insertions(+), 24 deletions(-)。原 main 领先 1186 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43031683958)

**实际审查：**

stdio扩展双向gRPC，沿用已初始化owner和启动时项目allowlist，有限RPC与交互流共享五槽池，HTTP授权变化不扩大启动授权。

EOF/关闭同步停止新准入并abort有限调用，再排空双向流与证据保存；异步microtask开网前再检查signal，slot finally释放，200操作/100消息/1MiB限制继续有效。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 092. `feat/mcp-stdio-websocket`

**结论：提交历史已纳入。** SHA：[`d0d926030c9c`](https://github.com/Hubujiu/local-api-workbench/tree/d0d926030c9c4285f724015a1af63c2b554857d4)；PR：[#184](https://github.com/Hubujiu/local-api-workbench/pull/184)。

**范围：** feat: add bounded stdio MCP WebSocket sessions

实际审查比较基线 `ddf061d8f3f8`；比较增量：12 files changed, 1117 insertions(+), 44 deletions(-)。原 main 领先 1183 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43024360815)

**实际审查：**

stdio WebSocket仅在初始化响应实际写出后暴露owner，服务由双启动授权创建，项目allowlist冻结，不随导入扩张。

复用单次自动证据保存器；EOF先撤owner再等待pending/registry/storage drain，shutdown幂等并保留unknown。独立进程五槽隔离与HTTP撤权互不干扰有真实SDK测试。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 093. `feat/mcp-tcp-sessions`

**结论：提交历史已纳入。** SHA：[`bb5e58df2805`](https://github.com/Hubujiu/local-api-workbench/tree/bb5e58df2805be660c1d56b99d5ebc1e32a4f5c4)；PR：[#188](https://github.com/Hubujiu/local-api-workbench/pull/188)。

**范围：** feat: bounded TCP MCP interaction with shared WS authority and quotas

实际审查比较基线 `89835079f1ed`；比较增量：16 files changed, 2185 insertions(+), 64 deletions(-)。原 main 领先 1191 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43054314008)

**实际审查：**

HTTP/stdio增加保存TCP定义交互视图，TCP/WS共享相同owner、五连接池和200操作账本；指纹及查找同时绑定protocolType。

拒绝临时目标、非文本/过大初始消息及不支持字段；读分页明确字节流无消息边界、不续租，原有未知结果/撤权/排空合同保留，禁止跨协议会话或操作ID冒用。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 094. `feat/multipart-part-media-types`

**结论：语义已整合或由后续实现替代。** SHA：[`3b468d426082`](https://github.com/Hubujiu/local-api-workbench/tree/3b468d426082dcba7d9e84a992883169e83d7478)；PR：[#69](https://github.com/Hubujiu/local-api-workbench/pull/69)。

**范围：** multipart 每部分媒体与 OpenAPI encoding

实际审查比较基线 `88f70bb515c4`；比较增量：19 files changed, 2070 insertions(+), 55 deletions(-)。原 main 领先 405 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40968290499)

**实际审查：**

两个纯模块及11项测试/fixture同 blob；core/body/runtime 的后续差异包含额外 serialization 能力而非删除 part media。纯函数回归通过；不通过随意重编码改变真实 multipart 分隔与媒体语义。

**整合判断：** 非祖先且有 7 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 19 个变化路径中 12 个与候选文件完全同 blob。

**重点路径：** `src/multipart-part-media.mjs`、`src/openapi-form-encoding.mjs`、`src/openapi-body.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/multipart-part-media-pure.test.mjs

**available_branch_tests**：tests/mcp-sdk-interop.test.mjs

tests/multipart-part-media-pure.test.mjs

tests/multipart-part-media-workflow.test.mjs

tests/openapi-content-type.test.mjs

tests/openapi-form-encoding-pure.test.mjs

tests/openapi-form-schema.test.mjs

tests/openapi-media.test.mjs

tests/openapi-reference-siblings.test.mjs

tests/sdk-flow-failure-context.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 095. `feat/native-attribute-export`

**结论：语义已整合或由后续实现替代。** SHA：[`794eb7769475`](https://github.com/Hubujiu/local-api-workbench/tree/794eb7769475daa1873dd48503217f047954d29f)；PR：[#89](https://github.com/Hubujiu/local-api-workbench/pull/89)。

**范围：** 原生属性库导出

实际审查比较基线 `79bf5f54cb4a`；比较增量：10 files changed, 1256 insertions(+), 7 deletions(-)。原 main 领先 570 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41763885534)

**实际审查：**

属性模块和preflight/roundtrip测试同blob；共享 exporter 在prepare前先检查属性输入，再验证重导入结果。当前错误说明保留继承属性拒绝上下文；两代 roundtrip通过。

**整合判断：** 非祖先且有 38 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 10 个变化路径中 7 个与候选文件完全同 blob。

**重点路径：** `src/apipost-attribute-export.mjs`、`src/apipost-export.mjs`、`src/apipost-sample-export.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/apipost-attribute-roundtrip.test.mjs

**available_branch_tests**：tests/apipost-attribute-export-unit.test.mjs

tests/apipost-attribute-export.test.mjs

tests/apipost-attribute-preflight-diagnostics.test.mjs

tests/apipost-attribute-roundtrip.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 096. `feat/native-bounded-wait`

**结论：提交历史已纳入。** SHA：[`15c75beb47c5`](https://github.com/Hubujiu/local-api-workbench/tree/15c75beb47c536dbc06bff02c0114b4b94999432)；PR：[#27](https://github.com/Hubujiu/local-api-workbench/pull/27)。

**范围：** 原生有限等待任务

实际审查比较基线 `aa95fd403b75`；比较增量：10 files changed, 1010 insertions(+), 5 deletions(-)。原 main 领先 424 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40377823350)

**实际审查：**

启用单次 wait 为0至1000ms整数、每阶段合计1000ms；安装器要求串行 index 和真实完成，不把用户 Promise 原型变化当已完成。与 canonical repeat 的间隔合同不同，不能混并为无限 sleep。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 863 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 10 个变化路径中 3 个与候选文件完全同 blob。

**重点路径：** `src/native-wait-tasks.mjs`、`src/native-task-phase.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/apipost-modern.test.mjs

tests/native-wait-tasks.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 097. `feat/native-code-export`

**结论：语义已整合或由后续实现替代。** SHA：[`8d7886e6c805`](https://github.com/Hubujiu/local-api-workbench/tree/8d7886e6c8057daf98aee189622a9ed6277df502)；PR：[#87](https://github.com/Hubujiu/local-api-workbench/pull/87)。

**范围：** 原生代码片段库导出

实际审查比较基线 `79bf5f54cb4a`；比较增量：9 files changed, 1071 insertions(+), 5 deletions(-)。原 main 领先 568 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41596932419)

**实际审查：**

专用code模块、两种出口及往返测试同blob；catalogue声明只表示数据，不自动执行导入片段。实际往返与拒绝保持已保存状态的测试保留。

**整合判断：** 非祖先且有 37 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 9 个变化路径中 7 个与候选文件完全同 blob。

**重点路径：** `src/apipost-code-export.mjs`、`src/apipost-export.mjs`、`src/apipost-directory-export.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/apipost-code-roundtrip.test.mjs

**available_branch_tests**：tests/apipost-code-export-unit.test.mjs

tests/apipost-code-export.test.mjs

tests/apipost-code-roundtrip.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 098. `feat/native-conditional-mock`

**结论：提交历史已纳入。** SHA：[`5bb93908b177`](https://github.com/Hubujiu/local-api-workbench/tree/5bb93908b177dbd880d340978b278dde1bf73f37)；PR：[#11](https://github.com/Hubujiu/local-api-workbench/pull/11)。

**范围：** 原生条件 Mock

实际审查比较基线 `306ab3225ec8`；比较增量：16 files changed, 1959 insertions(+), 19 deletions(-)。原 main 领先 404 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40308934342)

**实际审查：**

原生条件数据通过专用路由/运行时解释，保留受支持子集的拒绝边界；不等同于可执行任意导入 JS。后续属性/Mock/计划组合测试继续覆盖而非回退旧分支。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 883 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 16 个变化路径中 7 个与候选文件完全同 blob。

**重点路径：** `src/native-mock-route.mjs`、`src/native-mock-runtime.mjs`、`src/apipost-native-mock.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/native-mock-media.test.mjs

tests/native-mock-route.test.mjs

tests/native-mock.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 099. `feat/native-description-export`

**结论：语义已整合或由后续实现替代。** SHA：[`4b234240b50a`](https://github.com/Hubujiu/local-api-workbench/tree/4b234240b50ae0b596a3ce3044d8193d746cc871)；PR：[#86](https://github.com/Hubujiu/local-api-workbench/pull/86)。

**范围：** 原生参数描述库导出

实际审查比较基线 `79bf5f54cb4a`；比较增量：9 files changed, 944 insertions(+), 5 deletions(-)。原 main 领先 568 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41594734414)

**实际审查：**

专用description模块、两种出口与往返测试同blob；共享导出器仍import并执行 export/verify，实际两代往返通过。纯依赖代码不是新功能增量。

**整合判断：** 非祖先且有 37 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 9 个变化路径中 7 个与候选文件完全同 blob。

**重点路径：** `src/apipost-description-export.mjs`、`src/apipost-export.mjs`、`src/apipost-directory-export.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/apipost-description-roundtrip.test.mjs

**available_branch_tests**：tests/apipost-description-export-unit.test.mjs

tests/apipost-description-export.test.mjs

tests/apipost-description-roundtrip.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 100. `feat/native-document-lifecycle`

**结论：语义已整合或由后续实现替代。** SHA：[`0bd4fbf48a7a`](https://github.com/Hubujiu/local-api-workbench/tree/0bd4fbf48a7a41cee01a99b3721ca8bd26a067c5)；PR：[#21](https://github.com/Hubujiu/local-api-workbench/pull/21)。

**范围：** 原生文档/API 生命周期与恢复

实际审查比较基线 `d87da10d0be3`；比较增量：15 files changed, 3391 insertions(+), 32 deletions(-)。原 main 领先 419 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41223491342)

**实际审查：**

restore 与文档模块同 blob，生命周期主模块与后续继承目录、手工导入共同演进。隐式父目录只恢复已见证的关系，不复活之后删除的资源；目录恢复持久化回归通过。

**整合判断：** 非祖先且有 10 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 15 个变化路径中 5 个与候选文件完全同 blob。

**重点路径：** `src/api-resource-lifecycle.mjs`、`src/api-resource-restore.mjs`、`src/apipost-documents.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/api-resource-restore-model.test.mjs

tests/api-resource-restore-owner.test.mjs

tests/native-document-lifecycle.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 101. `feat/native-inheritance-graph`

**结论：语义已整合或由后续实现替代。** SHA：[`bef868242bac`](https://github.com/Hubujiu/local-api-workbench/tree/bef868242baceb7d45228c35c9647860841f1e2e)；PR：[#43](https://github.com/Hubujiu/local-api-workbench/pull/43)。

**范围：** 原生继承图、目录生命周期与冻结计划

实际审查比较基线 `9c66155ceeff`；比较增量：30 files changed, 6936 insertions(+), 29 deletions(-)。原 main 领先 524 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41212787343)

**实际审查：**

inheritance import/export/plans 与 folder lifecycle 模块同 blob；导出器同时执行 validate/verify 两端检查。Store 回归证明目录转换和 journal 恢复；后续来源标记、模型约束变化应保留。

**整合判断：** 非祖先且有 4 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 30 个变化路径中 10 个与候选文件完全同 blob。

**重点路径：** `src/native-inheritance.mjs`、`src/native-inheritance-export.mjs`、`src/native-inheritance-import.mjs`、`src/native-folder-lifecycle.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/native-folder-lifecycle-store.test.mjs

**available_branch_tests**：tests/native-folder-lifecycle-model.test.mjs

tests/native-folder-lifecycle-sdk.test.mjs

tests/native-folder-lifecycle-store.test.mjs

tests/native-inheritance-flow.test.mjs

tests/native-inheritance-form.test.mjs

tests/native-inheritance-lifecycle.test.mjs

tests/native-inheritance-workflow.test.mjs

tests/native-inheritance.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 102. `feat/native-mcp-workflows`

**结论：语义已整合或由后续实现替代。** SHA：[`d87da10d0be3`](https://github.com/Hubujiu/local-api-workbench/tree/d87da10d0be32912b4e9bc36f5f62340b6221666)；PR：[#16](https://github.com/Hubujiu/local-api-workbench/pull/16)。

**范围：** 原生 MCP 工作流及结果分块

实际审查比较基线 `88f70bb515c4`；比较增量：43 files changed, 6892 insertions(+), 74 deletions(-)。原 main 领先 413 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41208833136)

**实际审查：**

HTTP 原生形状投影、冻结计划、环境投影和结果 chunk 均仍在候选；原生工具只承担声明范围，不扩大 canonical 计划支持面。关键 chunk、environment、OpenAPI admission 模块及 SDK 测试同 blob，公共入口已扩展而非遗漏。

**整合判断：** 非祖先且有 8 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 43 个变化路径中 27 个与候选文件完全同 blob。

**重点路径：** `src/native-mcp-tools.mjs`、`src/native-mcp-plan.mjs`、`src/native-mcp-http-shape.mjs`、`src/execution-result-chunk.mjs`、`src/mcp.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/execution-result-chunk.test.mjs

tests/import-document-parser.test.mjs

tests/import-document-routing.test.mjs

tests/mcp-expanded.test.mjs

tests/mcp-openapi-sync.test.mjs

tests/mcp-openapi-yaml-workflow.test.mjs

tests/mcp-request-input.test.mjs

tests/mcp-result-chunk-sdk.test.mjs

tests/mcp-sdk-interop.test.mjs

tests/native-mcp-api.test.mjs

tests/native-mcp-environments.test.mjs

tests/native-mcp-history.test.mjs

tests/native-mcp-http-projection-sdk.test.mjs

tests/native-mcp-http-shape.test.mjs

tests/native-mcp-project-sync.test.mjs

tests/native-mcp-variable-values.test.mjs

tests/native-mcp-workflows.test.mjs

tests/openapi-operation-admission.test.mjs

tests/sdk-flow-failure-context.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 103. `feat/native-oauth2-token-policy`

**结论：语义已整合或由后续实现替代。** SHA：[`fc529bf4da1f`](https://github.com/Hubujiu/local-api-workbench/tree/fc529bf4da1f97538125f3f9f5f623f43a3ac3bd)；PR：[#74](https://github.com/Hubujiu/local-api-workbench/pull/74)。

**范围：** 原生 OAuth2 token/acquisition 策略

实际审查比较基线 `6350e7ef07b1`；比较增量：20 files changed, 2534 insertions(+), 6 deletions(-)。原 main 领先 408 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41217117098)

**实际审查：**

原生 token/grant/model 与5项关键测试同 blob，临时授权与持久 token 注入配置分开。HTTP1/2 wire 验证通过；无法保真的原生采集字段仍显式拒绝，不能导出成无认证请求。

**整合判断：** 非祖先且有 7 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 20 个变化路径中 10 个与候选文件完全同 blob。

**重点路径：** `src/native-oauth2-token.mjs`、`src/native-oauth2-grant.mjs`、`public/native-oauth2-model.js`、`src/runtime.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/native-oauth2-wire.test.mjs

**available_branch_tests**：tests/native-oauth2-acquisition.test.mjs

tests/native-oauth2-admission.test.mjs

tests/native-oauth2-model.test.mjs

tests/native-oauth2-owner.test.mjs

tests/native-oauth2-token.test.mjs

tests/native-oauth2-wire.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 104. `feat/native-project-export`

**结论：语义已整合或由后续实现替代。** SHA：[`7df8280d9b9e`](https://github.com/Hubujiu/local-api-workbench/tree/7df8280d9b9ed73f12af3f23288f0bdc598b7f4a)；PR：[#14](https://github.com/Hubujiu/local-api-workbench/pull/14)。

**范围：** 原生 JSON/目录项目导出及认证协议往返

实际审查比较基线 `0a34519d5506`；比较增量：62 files changed, 15581 insertions(+), 14 deletions(-)。原 main 领先 569 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41818749728)

**实际审查：**

导出器同时接入 descriptions/codes/attributes、数据库 rebind、原生继承图与扩展协议验证，并在表示不了的 metadata 上明确拒绝。大量专用序列化器与旧分支同 blob；两代往返和 binary export 回归通过。不能直接合并旧 exporter 覆盖最新 OpenAPI 标记拒绝与共享边界。

**整合判断：** 非祖先且有 37 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 62 个变化路径中 45 个与候选文件完全同 blob。

**重点路径：** `src/apipost-export.mjs`、`src/apipost-directory-export.mjs`、`src/apipost-protocol-export.mjs`、`src/apipost-auth-export.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/native-websocket-binary-export.test.mjs

**available_branch_tests**：tests/apipost-auth-export.test.mjs

tests/apipost-auth-import.test.mjs

tests/apipost-directory-export.test.mjs

tests/apipost-document-export.test.mjs

tests/apipost-export.test.mjs

tests/apipost-extended-protocol-export.test.mjs

tests/apipost-mock-export.test.mjs

tests/apipost-mock-media-export.test.mjs

tests/apipost-model-export.test.mjs

tests/apipost-protocol-export.test.mjs

tests/apipost-sample-export.test.mjs

tests/apipost-websocket-export.test.mjs

tests/extended-protocol-export-entrypoints.test.mjs

tests/native-asap-definition-roundtrip.test.mjs

tests/native-asap-owner-roundtrip.test.mjs

tests/native-digest-bootstrap.test.mjs

tests/native-digest-owner-roundtrip.test.mjs

tests/native-jwt-definition-export.test.mjs

tests/native-jwt-owner-roundtrip.test.mjs

tests/native-ntlm-credentials.test.mjs

tests/native-ntlm-owner-roundtrip.test.mjs

tests/native-oauth1-owner-roundtrip.test.mjs

tests/native-oauth1-policy.test.mjs

tests/native-oauth2-definition-owner.test.mjs

tests/native-oauth2-definition.test.mjs

tests/native-websocket-binary-export.test.mjs

tests/websocket-export-entrypoints.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 105. `feat/native-protocol-import`

**结论：语义已整合或由后续实现替代。** SHA：[`66c94aa9f7a4`](https://github.com/Hubujiu/local-api-workbench/tree/66c94aa9f7a4e75539e1db673672adb3414355d9)；PR：[#13](https://github.com/Hubujiu/local-api-workbench/pull/13)。

**范围：** 原生协议导入含 WebSocket binary

实际审查比较基线 `ee13e2b5fdd6`；比较增量：38 files changed, 5335 insertions(+), 12 deletions(-)。原 main 领先 419 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41819464035)

**实际审查：**

核心协议导入、身份隔离及 binary 测试与旧分支完全同 blob。候选新增握手/会话能力时保留了这些核心文件；实际 binary import 回归通过。旧 WIP 提交标题不能据此判定当前实现仍缺失。

**整合判断：** 非祖先且有 2 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 38 个变化路径中 18 个与候选文件完全同 blob。

**重点路径：** `src/apipost-native-protocols.mjs`、`src/apipost-extended-protocols.mjs`、`src/apipost-protocol-identities.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/native-websocket-binary-import.test.mjs

**available_branch_tests**：tests/apipost-extended-protocols.test.mjs

tests/apipost-native-protocols.test.mjs

tests/native-extended-protocol-integration.test.mjs

tests/native-grpc-metadata.test.mjs

tests/native-grpc-tls.test.mjs

tests/native-protocol-identity-isolation.test.mjs

tests/native-protocol-integration.test.mjs

tests/native-protocol-templates.test.mjs

tests/native-socketio-handshake.test.mjs

tests/native-websocket-binary-import.test.mjs

tests/native-websocket-fidelity.test.mjs

tests/protocol-handshake.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 106. `feat/native-redis-set-owner`

**结论：语义已整合或由后续实现替代。** SHA：[`3183d4c726ca`](https://github.com/Hubujiu/local-api-workbench/tree/3183d4c726cabb26a44b32d9e9c896bd506e27ce)；PR：[#72](https://github.com/Hubujiu/local-api-workbench/pull/72)。

**范围：** 原生 Redis SET 的 owner 单次授权

实际审查比较基线 `b07afdbfcf29`；比较增量：27 files changed, 5155 insertions(+), 64 deletions(-)。原 main 领先 458 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41027263258)

**实际审查：**

owner ledger 固定项目配置指纹、session generation、目标和 command digest；能力在 beforeDispatch 消耗且不可重放。MCP/CLI 默认入口拒绝，runtime rows 在能力创建前拒绝；授权撤销与 owner 测试通过。远端写入恰好一次不作保证，收据状态不能冒充服务器证明。

**整合判断：** 非祖先且有 7 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 27 个变化路径中 12 个与候选文件完全同 blob。

**重点路径：** `src/native-write-owner.mjs`、`src/native-write-authorizations.mjs`、`src/native-write-execution.mjs`、`src/database-sessions.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/native-write-entrypoint-denial.test.mjs

tests/native-write-owner.test.mjs

**available_branch_tests**：tests/native-redis-dispatch.test.mjs

tests/native-redis-owner.test.mjs

tests/native-redis-target.test.mjs

tests/native-redis-tasks.test.mjs

tests/native-redis-write-intent.test.mjs

tests/native-write-authorizations.test.mjs

tests/native-write-entrypoint-denial.test.mjs

tests/native-write-execution.test.mjs

tests/native-write-owner.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 107. `feat/native-response-assertions`

**结论：语义已整合或由后续实现替代。** SHA：[`5613c6a50904`](https://github.com/Hubujiu/local-api-workbench/tree/5613c6a50904ed52f33c7996ba735ddee6bc82f6)；PR：[#26](https://github.com/Hubujiu/local-api-workbench/pull/26)。

**范围：** 原生响应断言

实际审查比较基线 `4a79927b16f7`；比较增量：32 files changed, 10348 insertions(+), 21 deletions(-)。原 main 领先 460 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41830441173)

**实际审查：**

断言模块及 header 证据模块与旧分支同 blob。当前 header 边界测试只是增加白名单诊断标签，访问器/non-string/Unicode/64KiB 断言仍在；未发现为通过 CI 弱化断言。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 32 个变化路径中 19 个与候选文件完全同 blob。

**重点路径：** `src/native-response-assertions.mjs`、`src/native-cookie-name.mjs`、`src/response-header-evidence.mjs`、`tests/native-header-assertion-boundaries.test.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/cli-result-diagnostics.test.mjs

tests/execution-result-diagnostics.test.mjs

tests/native-comparator-assertion-boundaries.test.mjs

tests/native-comparator-assertion-workflow.test.mjs

tests/native-cookie-assertions.test.mjs

tests/native-expected-expansion.test.mjs

tests/native-header-assertion-boundaries.test.mjs

tests/native-header-assertion-workflow.test.mjs

tests/native-metric-assertions.test.mjs

tests/native-pick-xml-workflow.test.mjs

tests/native-regularmatch-assertions.test.mjs

tests/native-response-assertions.test.mjs

tests/native-text-assertion-boundaries.test.mjs

tests/native-text-assertion-workflow.test.mjs

tests/native-variable-assertions.test.mjs

tests/native-xml-assertion-boundaries.test.mjs

tests/native-xml-assertion-workflow.test.mjs

tests/worker-rejection-diagnostics.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 108. `feat/native-response-extraction`

**结论：语义已整合或由后续实现替代。** SHA：[`51a3296cf1b4`](https://github.com/Hubujiu/local-api-workbench/tree/51a3296cf1b4328dbd5d6f681d3d628e50016093)；PR：[#25](https://github.com/Hubujiu/local-api-workbench/pull/25)。

**范围：** 原生变量提取：cookie/header/request/XML

实际审查比较基线 `f8965e98d46a`；比较增量：44 files changed, 8272 insertions(+), 38 deletions(-)。原 main 领先 453 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41226756202)

**实际审查：**

提取器、request snapshot、XML 路径模块与旧分支同 blob；剩余不同主要是新增诊断。当前 XML workflow 仍保留原断言，并增加已观察请求数量和 t.diagnostic 输出，没有移除拒绝路径。XML 实库/外部 XML 输入穷举不在本轮范围。

**整合判断：** 非祖先且有 4 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 44 个变化路径中 22 个与候选文件完全同 blob。

**重点路径：** `src/native-response-extraction.mjs`、`src/native-request-snapshot.mjs`、`src/native-xml-path.mjs`、`src/native-task-phase.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/cli-result-diagnostics.test.mjs

tests/native-pick-cookie-workflow.test.mjs

tests/native-pick-cookie.test.mjs

tests/native-pick-header-boundaries.test.mjs

tests/native-pick-header-workflow.test.mjs

tests/native-pick-metadata-workflow.test.mjs

tests/native-pick-metadata.test.mjs

tests/native-pick-request-json5.test.mjs

tests/native-pick-request-workflow.test.mjs

tests/native-pick-request.test.mjs

tests/native-pick-text-boundaries.test.mjs

tests/native-pick-text-workflow.test.mjs

tests/native-pick-vars.test.mjs

tests/native-pick-xml-boundaries.test.mjs

tests/native-pick-xml-workflow.test.mjs

tests/worker-rejection-diagnostics.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 109. `feat/native-safe-append-20261106`

**结论：提交历史已纳入。** SHA：[`7bf3e20d6c4b`](https://github.com/Hubujiu/local-api-workbench/tree/7bf3e20d6c4bed00d30621c9f99cad89ed0778ab)；PR：[#156](https://github.com/Hubujiu/local-api-workbench/pull/156)。

**范围：** feat: append same-source native HTTP graphs through signed import

实际审查比较基线 `846e62416269`；比较增量：9 files changed, 730 insertions(+), 6 deletions(-)。原 main 领先 1146 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42167379883)

**实际审查：**

现代原生JSON/目录仅创建新HTTP身份的追加导入，来源项目、共享定义、环境与旧文件夹必须完全一致，禁止覆盖/清除/重绑。

预览签名结合确定ID；Store锁内重放并比较整个项目，旧历史不可裁剪/修改，取消及未知发布保留恢复语义。其旧计划归一化问题由后续fix/native-append-legacy-plans修复，候选同时包含。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 110. `feat/native-task-export`

**结论：语义已整合或由后续实现替代。** SHA：[`b56fa9776e8a`](https://github.com/Hubujiu/local-api-workbench/tree/b56fa9776e8a434ca7b3fdfa068bc70cbe78f7ab)；PR：[#28](https://github.com/Hubujiu/local-api-workbench/pull/28)。

**范围：** 原生任务导出与 SQL 显式 rebind

实际审查比较基线 `70f49d2bc5d0`；比较增量：13 files changed, 2183 insertions(+), 23 deletions(-)。原 main 领先 471 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41229645334)

**实际审查：**

task/database export 模块及 model/integration 测试同 blob。候选共享 exporter 仍显式调用数据库 mode 与 task pipeline；默认拒绝不能保真的连接，rebind 不携带运行期凭据。HTTP/stdio scoped rebind 回归通过。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 13 个变化路径中 6 个与候选文件完全同 blob。

**重点路径：** `src/apipost-task-export.mjs`、`src/apipost-database-export.mjs`、`src/apipost-export.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/apipost-task-export.test.mjs

tests/native-database-export-model.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 111. `feat/ntlmv2-mic`

**结论：语义已整合或由后续实现替代。** SHA：[`482055181ab5`](https://github.com/Hubujiu/local-api-workbench/tree/482055181ab5d30059481994cbf121ece33864b6)；PR：[#68](https://github.com/Hubujiu/local-api-workbench/pull/68)。

**范围：** NTLMv2 MIC transcript 完整性

实际审查比较基线 `88f70bb515c4`；比较增量：11 files changed, 1054 insertions(+), 34 deletions(-)。原 main 领先 398 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40917817025)

**实际审查：**

ntlm 字节模块及 pure fixture/test 同 blob；runtime 把原 Type1 header 传到 ntlmType3，保持连接绑定和 transcript 校验。不能用更早不带 MIC 的实现覆盖，真实外部 NTLM 服务互操作未在本机复验。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 11 个变化路径中 6 个与候选文件完全同 blob。

**重点路径：** `src/ntlm.mjs`、`src/runtime.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/ntlm-mic-pure.test.mjs

tests/ntlm-mic-workflow.test.mjs

tests/ntlm.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 112. `feat/oauth1-callback`

**结论：提交历史已纳入。** SHA：[`5aa96e820186`](https://github.com/Hubujiu/local-api-workbench/tree/5aa96e820186e30bde00f1aeecda4f580da5561a)；PR：[#39](https://github.com/Hubujiu/local-api-workbench/pull/39)。

**范围：** OAuth1 loopback 回调

实际审查比较基线 `88f70bb515c4`；比较增量：4 files changed, 1037 insertions(+), 37 deletions(-)。原 main 领先 397 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40440442949)

**实际审查：**

回调路径使用24字节随机值，token/verifier 参数拒绝重复和非法编码；flow 过期/取消会删除临时秘密，交换后再次核对活动身份。分支历史已在候选。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 890 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 4 个变化路径中 3 个与候选文件完全同 blob。

**重点路径：** `src/oauth1-flow.mjs`、`src/server.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/oauth1-callback.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 113. `feat/oauth1-request-policy`

**结论：语义已整合或由后续实现替代。** SHA：[`27ed173c9614`](https://github.com/Hubujiu/local-api-workbench/tree/27ed173c9614b261ca28f3033f1d9c93f54701af)；PR：[#73](https://github.com/Hubujiu/local-api-workbench/pull/73)。

**范围：** OAuth1 显式签名参数策略

实际审查比较基线 `88f70bb515c4`；比较增量：16 files changed, 2374 insertions(+), 41 deletions(-)。原 main 领先 400 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41078547444)

**实际审查：**

signer/policy 模块和协议 oracle/wire 测试同 blob；runtime 将显式 policy 传给 oauth1Request，header/query/body hash 条件保持。Postman OAuth1 owner/freeze/restore 回归进一步验证共享接线。

**整合判断：** 非祖先且有 5 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 16 个变化路径中 9 个与候选文件完全同 blob。

**重点路径：** `src/oauth1.mjs`、`public/oauth1-policy-model.js`、`src/runtime.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/oauth1-policy-admission.test.mjs

tests/oauth1-policy-model.test.mjs

tests/oauth1-policy-owner.test.mjs

tests/oauth1-policy-wire.test.mjs

tests/oauth1-request-policy.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 114. `feat/offline2-directory-import`

**结论：提交历史已纳入。** SHA：[`2d1654a10fd7`](https://github.com/Hubujiu/local-api-workbench/tree/2d1654a10fd73db70e098d02138bca77464b5d76)；PR：[#6](https://github.com/Hubujiu/local-api-workbench/pull/6)。

**范围：** Offline2 目录导入

实际审查比较基线 `7167ce31e30e`；比较增量：15 files changed, 753 insertions(+), 4 deletions(-)。原 main 领先 399 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40200210452)

**实际审查：**

导入目录资源和原始来源资料；应保留受限目录解析及原始文件凭据，不把目录路径解释为任意本地文件读取授权。候选保留对应 fixture 和目录工件测试。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 888 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 15 个变化路径中 9 个与候选文件完全同 blob。

**重点路径：** `src/apipost-directory-artifacts.mjs`、`src/apipost-directory.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/original-directory-artifacts.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 115. `feat/offline2-execution-import`

**结论：语义已整合或由后续实现替代。** SHA：[`3935a48a6743`](https://github.com/Hubujiu/local-api-workbench/tree/3935a48a6743ed666f5e1cb6128226c081090efd)；PR：[#7](https://github.com/Hubujiu/local-api-workbench/pull/7)。

**范围：** Offline2 历史执行导入与原始字节分块读取

实际审查比较基线 `2d1654a10fd7`；比较增量：33 files changed, 7080 insertions(+), 21 deletions(-)。原 main 领先 417 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40796887865)

**实际审查：**

原始历史文件只读、哈希固定、分块版本及 EOF 明确。关键 reader/chunk 模块和相应测试与旧分支完全同 blob；MCP chunk 参数仍由专用校验器处理，历史并不等于可以重放的执行计划。

**整合判断：** 非祖先且有 4 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 33 个变化路径中 17 个与候选文件完全同 blob。

**重点路径：** `src/imported-execution-chunk.mjs`、`src/imported-execution-history.mjs`、`src/imported-native-flow-source.mjs`、`src/mcp.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/imported-execution-chunk-validation.test.mjs

tests/imported-execution-chunks.test.mjs

tests/imported-execution-history.test.mjs

tests/imported-execution-reader.test.mjs

tests/imported-native-flow-source.test.mjs

tests/imported-native-task-source.test.mjs

tests/mcp-expanded.test.mjs

tests/native-flow-task-boundary.test.mjs

tests/original-execution-import.test.mjs

tests/original-mcp-flow-import.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 116. `feat/openapi31-schema-export`

**结论：提交历史已纳入。** SHA：[`9662c161d7e0`](https://github.com/Hubujiu/local-api-workbench/tree/9662c161d7e05b3ad5f62829e3db945683749a6b)；PR：[#162](https://github.com/Hubujiu/local-api-workbench/pull/162)。

**范围：** feat: export common OpenAPI 3.1 schema constraints

实际审查比较基线 `71e2bb69d912`；比较增量：8 files changed, 985 insertions(+), 7 deletions(-)。原 main 领先 1155 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42853723808)

**实际审查：**

OpenAPI3.1非null const转换为3.0 singleton enum，有现存enum时追加allOf交集；数字exclusive边界保留更严格的原有inclusive约束。

遍历只触Schema位置，不改变例子数据；plain JSON const拒绝getter/稀疏数组/非有限值，沿用节点深度预算；const:null及未支持方言明确拒绝。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 117. `feat/openapi-cookie-object-pairs-pr165`

**结论：提交历史已纳入。** SHA：[`d958133aab91`](https://github.com/Hubujiu/local-api-workbench/tree/d958133aab918ecfb6efec8c0267590b9f0cbd3d)；PR：[#166](https://github.com/Hubujiu/local-api-workbench/pull/166)。

**范围：** feat: support explicitly marked OpenAPI Cookie object pairs

实际审查比较基线 `068a5f751429`；比较增量：22 files changed, 2453 insertions(+), 16 deletions(-)。原 main 领先 1161 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42976525645)

**实际审查：**

Cookie对象只有显式x-local-api-cookie-dialect=cookie-pairs-v1才接纳，按form/explode生成安全Cookie pairs，不把未标记对象推断为同义格式。

闭合标记、扁平类型、token名字、64KiB与名称冲突检查贯通导入/动态值/MCP/Store/传输；显式Cookie认证冲突拒绝，schema和原operation只作元数据不重复插值，无法保真的原生出口拒绝。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 118. `feat/openapi-header-object-serialization`

**结论：提交历史已纳入。** SHA：[`c24537538fdb`](https://github.com/Hubujiu/local-api-workbench/tree/c24537538fdbdb7d77c35e1290410f06d79c5242)；PR：[#164](https://github.com/Hubujiu/local-api-workbench/pull/164)。

**范围：** feat: serialize OpenAPI simple Header objects end to end

实际审查比较基线 `85567408e83f`；比较增量：21 files changed, 2530 insertions(+), 17 deletions(-)。原 main 领先 1159 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42862428962)

**实际审查：**

Header对象以版本化simple/explode合同编码扁平primitive对象，字段百分号编码防分隔符注入，保留明确空对象及真实HTTP1/2/cURL等值性。

审查标记位置、disabled行、类型/64KiB限制、大小写重复Header与Content-Type边界；只允许enum型allOf以兼容const转换，动态覆盖后再校验，原生出口禁止静默丢标记。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 119. `feat/openapi-query-object-safe`

**结论：提交历史已纳入。** SHA：[`8a0060133059`](https://github.com/Hubujiu/local-api-workbench/tree/8a0060133059fc82ef134e03e916767ed9e40c08)；PR：[#170](https://github.com/Hubujiu/local-api-workbench/pull/170)。

**范围：** feat: restricted OpenAPI form exploded Query objects

实际审查比较基线 `7209638aede4`；比较增量：19 files changed, 1812 insertions(+), 5 deletions(-)。原 main 领先 1165 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42984260661)

**实际审查：**

Query对象首版限定OAS3 form/explode=true、封闭非空扁平schema、安全ASCII属性与有限primitive值，编码后展开为property pairs。

导入、共享参数解析后、脚本/动态输入后和真正组URL前均检查冲突；禁止原URLquery/SDK模式/不支持认证，保留等号，64KiB有界；定义出口不会静默丢失共享Query或版本标记。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 120. `feat/openapi-reserved-scalar`

**结论：提交历史已纳入。** SHA：[`50476cfcab8b`](https://github.com/Hubujiu/local-api-workbench/tree/50476cfcab8b1b2630b3ac3f82b7ec5faca9760c)；PR：[#167](https://github.com/Hubujiu/local-api-workbench/pull/167)。

**范围：** feat: support bounded scalar OpenAPI reserved query values

实际审查比较基线 `d958133aab91`；比较增量：21 files changed, 1408 insertions(+), 7 deletions(-)。原 main 领先 1162 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42978643323)

**实际审查：**

受限allowReserved标量实现保留有效预编码百分号拼写和安全reserved字符，&=+#等结构字符仍编码，畸形百分号/UTF8及原始单引号拒绝。

64KiB单值与合计、版本标记位置和primitive域贯通导入/动态/MCP/HTTP，限制SDK与未经验证签名认证；原URLquery可保持线上字节但无法保真的OpenAPI定义导出明确拒绝。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 121. `feat/oracle-readonly-wip`

**结论：隔离保留，不并入主线。** SHA：[`161c20f71bc9`](https://github.com/Hubujiu/local-api-workbench/tree/161c20f71bc95bd5e1c25b5e8ea9b67e8dc72081)；PR：[#56](https://github.com/Hubujiu/local-api-workbench/pull/56)。

**范围：** Oracle Thin 禁用 WIP

实际审查比较基线 `88f70bb515c4`；比较增量：29 files changed, 4930 insertions(+)。原 main 领先 401 提交；原候选直接包含：否。

原分支精确 head 的 CI：**failure**。 [Verify Oracle Image Metadata Only / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40734696699)；[Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40734696498)；[Oracle TCPS Isolated Acceptance / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/40734696277)

**实际审查：**

该分支真实未收录；普通核心 CI 和 metadata 成功不等于 Oracle TCPS 可用。独立 TCPS run40734696277 在启动固定 Oracle fixture 失败，实际只读验收步骤跳过。应保留独立研究档案，不作为完成的 provider 合入当前主线。

**整合判断：** 真实未集成的禁用 Oracle 研究实现；保留归档，不并入交付主线；待独立真实服务验收后作为新PR开发。

**重点路径：** `src/oracle-read-wip.mjs`、`src/oracle-read-supervisor.mjs`、`.github/workflows/oracle-tcps-integration.yml`

**发现/保留边界：**

**severity**：P1 (gate for this branch, not a blocker to consolidating the supported candidate)

**path**：.github/workflows/oracle-tcps-integration.yml

**summary**：TCPS真实服务验收失败，核心/metadata绿色不能证明provider可用。

**evidence**：GitHub run 40734696277: Start pinned isolated Oracle fixture failed; Exercise real TCPS and owned read boundary skipped; repository marks adapter disabled/unregistered.

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/40734696277

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/oracle-read-ca.test.mjs

tests/oracle-read-config-values.test.mjs

tests/oracle-read-driver-ci.test.mjs

tests/oracle-read-environment.test.mjs

tests/oracle-read-process.test.mjs

tests/oracle-read-supervisor.test.mjs

tests/oracle-read-tls-ci.test.mjs

tests/oracle-read-wip.test.mjs

tests/oracle-read-worker-trust.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 122. `feat/plan-failure-policy`

**结论：语义已整合或由后续实现替代。** SHA：[`7c5d1062e721`](https://github.com/Hubujiu/local-api-workbench/tree/7c5d1062e7210ed12aed35eda7cfb9fdc4e1cebe)；PR：[#92](https://github.com/Hubujiu/local-api-workbench/pull/92)。

**范围：** 计划失败即停止策略

实际审查比较基线 `b839507e7bdf`；比较增量：14 files changed, 1540 insertions(+), 3 deletions(-)。原 main 领先 612 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41773588873)

**实际审查：**

policy模块和owner/pure测试同blob，默认continue保持旧序列化形式。stop与scope-commit-unknown分开，取消/存储不确定性优先级保留；真实journal未知提交恢复不重放回归通过。

**整合判断：** 非祖先且有 36 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 14 个变化路径中 3 个与候选文件完全同 blob。

**重点路径：** `src/plan-failure-policy.mjs`、`src/core.mjs`、`src/execution-history.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/plan-failure-policy-owner.test.mjs

**available_branch_tests**：tests/plan-failure-policy-boundaries.test.mjs

tests/plan-failure-policy-mcp-cli.test.mjs

tests/plan-failure-policy-owner.test.mjs

tests/plan-failure-policy.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 123. `feat/plan-if-iteration-data`

**结论：提交历史已纳入。** SHA：[`50b3a7161cab`](https://github.com/Hubujiu/local-api-workbench/tree/50b3a7161cabe421f9bdc5b5e3fdeb19f7734cc3)；PR：[#108](https://github.com/Hubujiu/local-api-workbench/pull/108)。

**范围：** Let canonical IF inspect inline data rows

实际审查比较基线 `4e0396d3e1b5`；比较增量：8 files changed, 649 insertions(+), 8 deletions(-)。原 main 领先 1082 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41865865242)

**实际审查：**

IF可显式读取当前inline row的iterationData顶层字段；数据行以独立上下文传递，不进入globals/environment/runtime。

所有潜在row（包括false/disabled分支）提前验证字段存在、primitive与比较类型，拒绝getter/proxy及外部executionContext伪造；嵌套普通repeat承接同一行，点号名称按字面读取。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 124. `feat/plan-if-text-match`

**结论：提交历史已纳入。** SHA：[`aa5a1fdcf551`](https://github.com/Hubujiu/local-api-workbench/tree/aa5a1fdcf55157457ff165823d0f7787b555a829)；PR：[#109](https://github.com/Hubujiu/local-api-workbench/pull/109)。

**范围：** Add strict text matching to plan conditions

实际审查比较基线 `50b3a7161cab`；比较增量：7 files changed, 585 insertions(+), 13 deletions(-)。原 main 领先 1083 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41867651744)

**实际审查：**

条件新增contains/notContains严格区分大小写文本比较，不做类型转换、正则执行或Unicode归一化。

统一validateKnownType用于字面量和所有潜在数据行，负向比较遇到非法类型也失败；旧eq/neq和数值比较域保持，运行错误不泄露比较值。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 125. `feat/plan-inline-data-rows`

**结论：提交历史已纳入。** SHA：[`0aca69513970`](https://github.com/Hubujiu/local-api-workbench/tree/0aca695139709ac0145f738b3fbf7a2c75eaf061)；PR：[#105](https://github.com/Hubujiu/local-api-workbench/pull/105)。

**范围：** Add bounded inline data rows to repeat plans

实际审查比较基线 `e8f37c8b6a7b`；比较增量：6 files changed, 719 insertions(+), 15 deletions(-)。原 main 领先 1074 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/41857682244)

**实际审查：**

repeat可保存count严格匹配的inline rows，为每个occurrence传只读iteration/iterationCount/iterationData，退出后恢复外部上下文。

拒绝嵌套数据行组、稀疏数组/accessor/原型键/非JSON/-0，深度32及100000节点检查；最坏row字节计入整图展开预算，gRPC/TCP/WS/SSE脚本与阶段压测用相同上下文。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 126. `feat/plan-repeat-interval`

**结论：提交历史已纳入。** SHA：[`4e0396d3e1b5`](https://github.com/Hubujiu/local-api-workbench/tree/4e0396d3e1b58a9a2128ab0f32141076caf6ed50)；PR：[#107](https://github.com/Hubujiu/local-api-workbench/pull/107)。

**范围：** Add bounded cancellable repeat intervals

实际审查比较基线 `6ae20e866080`；比较增量：6 files changed, 537 insertions(+), 10 deletions(-)。原 main 领先 1081 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/41864516408)

**实际审查：**

repeat新增0至10000ms间隔，最坏展开等待累加不得超过60000ms（含disabled定义），等待是显式control而非伪造请求。

用可取消delayForControl，仅轮间有work才等待，IF跳过包含内部wait；执行证据next/remaining排除wait，取消或stop后不启动下一轮。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 127. `feat/postman-collection-variable-scope`

**结论：语义已整合或由后续实现替代。** SHA：[`48be18b3957a`](https://github.com/Hubujiu/local-api-workbench/tree/48be18b3957a360a0c7abd72325e8c42f348ea8c)；PR：[#67](https://github.com/Hubujiu/local-api-workbench/pull/67)。

**范围：** Postman collection 变量作用域

实际审查比较基线 `b58d3bf131cd`；比较增量：16 files changed, 2494 insertions(+), 34 deletions(-)。原 main 领先 418 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40895640923)

**实际审查：**

三个关键模块和 cancellation/model/pure 测试同 blob。collection registry 及 retirement 使用独立数据语义，取消不能提交排队中的 scope save，历史收据不随删除被改写；公共入口仍有 opt-in 校验和 export refusal。

**整合判断：** 非祖先且有 9 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 16 个变化路径中 6 个与候选文件完全同 blob。

**重点路径：** `src/postman-collection-scopes.mjs`、`src/postman-collection-runtime.mjs`、`src/variable-scopes.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/postman-collection-cancellation.test.mjs

tests/postman-collection-model.test.mjs

tests/postman-collection-scopes-pure.test.mjs

tests/postman-collection-workflows.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 128. `feat/postman-definition-export`

**结论：提交历史已纳入。** SHA：[`39a2a2ca9df9`](https://github.com/Hubujiu/local-api-workbench/tree/39a2a2ca9df93485214ea7ccb2406d0a4fdf7199)；PR：[#180](https://github.com/Hubujiu/local-api-workbench/pull/180)。

**范围：** feat: add bounded Postman collection definition export

实际审查比较基线 `62029bd19b2b`；比较增量：12 files changed, 2614 insertions(+), 9 deletions(-)。原 main 领先 1178 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43014512442)

**实际审查：**

新增明确选择的Postman2.1定义出口，窄合同仅静态URL、指定媒体raw/none和可表示Header，保持目录/请求顺序与字面占位符。

closed字段与默认值比较拒绝脚本、动态策略及未知行为；预览只给依赖/digest/大小，明确环境值未导出且不能独立重放，静态凭据原样保存；官方SDK脚本是独立可选oracle而非CI验收。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 129. `feat/postman-environment-import`

**结论：提交历史已纳入。** SHA：[`b0bb23ab64be`](https://github.com/Hubujiu/local-api-workbench/tree/b0bb23ab64be3c05123ce2a94c1177d0946de7d5)；PR：[#176](https://github.com/Hubujiu/local-api-workbench/pull/176)。

**范围：** feat: import bounded Postman environment JSON text

实际审查比较基线 `2e5c56c502b9`；比较增量：12 files changed, 826 insertions(+), 3 deletions(-)。原 main 领先 1173 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43003673761)

**实际审查：**

独立Postman环境以新身份追加，不切当前环境、不覆盖API；公共入口要求原始JSON文本，避免上游重复成员被JSON.parse折叠。

原token扫描覆盖Unicode转义重复键与被覆盖子树，4MiB/50000节点/50层有界；仅enabled=true普通字符串行，拒绝secret/vault/重复key/不支持字段和清除重绑操作，preview/apply保持原子。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 130. `feat/postman-graphql-body-import`

**结论：语义已整合或由后续实现替代。** SHA：[`0118e16c1f0b`](https://github.com/Hubujiu/local-api-workbench/tree/0118e16c1f0b2f949d7801d9590a8f878581d480)；PR：[#51](https://github.com/Hubujiu/local-api-workbench/pull/51)。

**范围：** Postman GraphQL/body modes 导入

实际审查比较基线 `88f70bb515c4`；比较增量：8 files changed, 1663 insertions(+), 5 deletions(-)。原 main 领先 398 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40666158938)

**实际审查：**

旧实现的 disabled body、active form selection、GraphQL 字节/深度预算已整合；当前候选还支持经过后续审查的变量字符串语义。owner→保存→freeze→CLI→restore 和无效混合导入零写入回归通过。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 8 个变化路径中 4 个与候选文件完全同 blob。

**重点路径：** `src/postman-graphql-body.mjs`、`src/core.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/postman-graphql-workflow.test.mjs

**available_branch_tests**：tests/postman-body-modes-workflow.test.mjs

tests/postman-body-modes.test.mjs

tests/postman-graphql-body.test.mjs

tests/postman-graphql-sdk.test.mjs

tests/postman-graphql-workflow.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 131. `feat/postman-oauth1-import`

**结论：语义已整合或由后续实现替代。** SHA：[`266f935de8fc`](https://github.com/Hubujiu/local-api-workbench/tree/266f935de8fc0f765265f00efe50da371487da07)；PR：[#95](https://github.com/Hubujiu/local-api-workbench/pull/95)。

**范围：** Postman OAuth1 无损导入

实际审查比较基线 `27ed173c9614`；比较增量：6 files changed, 991 insertions(+), 24 deletions(-)。原 main 领先 406 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41783348308)

**实际审查：**

import模块与owner tests同blob；core在认证类型分发时调用它，并在OpenAPI导出检验effective shared OAuth1 policy。原header/token策略及noauth切断继承回归通过。

**整合判断：** 非祖先且有 11 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 6 个变化路径中 4 个与候选文件完全同 blob。

**重点路径：** `src/postman-oauth1-import.mjs`、`src/core.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/postman-oauth1-workflow.test.mjs

**available_branch_tests**：tests/oauth1.test.mjs

tests/postman-oauth1-import.test.mjs

tests/postman-oauth1-workflow.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 132. `feat/postman-oauth2-policy`

**结论：语义已整合或由后续实现替代。** SHA：[`9ee11d1bbc8f`](https://github.com/Hubujiu/local-api-workbench/tree/9ee11d1bbc8f44a243e651257947e904cbc5d66e)；PR：[#78](https://github.com/Hubujiu/local-api-workbench/pull/78)。

**范围：** Postman OAuth2 注入策略

实际审查比较基线 `88f70bb515c4`；比较增量：17 files changed, 1449 insertions(+), 11 deletions(-)。原 main 领先 398 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41233277019)

**实际审查：**

policy 模块与 owner 测试同 blob；core importPostmanOAuth2 和运行时保存其标记。HTTP1/2、freeze、restart、项目隔离、无效导入零改动回归通过。MCP patch 不能绕过 owning validator。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 17 个变化路径中 2 个与候选文件完全同 blob。

**重点路径：** `src/postman-oauth2-token.mjs`、`src/core.mjs`、`src/mcp-request-input.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/postman-oauth2-owner.test.mjs

**available_branch_tests**：tests/postman-oauth2-model.test.mjs

tests/postman-oauth2-owner.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 133. `feat/postman-raw-media`

**结论：语义已整合或由后续实现替代。** SHA：[`d036a8d7afd9`](https://github.com/Hubujiu/local-api-workbench/tree/d036a8d7afd92d4961a47625e78c21219b45fbec)；PR：[#96](https://github.com/Hubujiu/local-api-workbench/pull/96)。

**范围：** Postman raw 媒体语义

实际审查比较基线 `0118e16c1f0b`；比较增量：10 files changed, 1777 insertions(+), 4 deletions(-)。原 main 领先 405 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41790078365)

**实际审查：**

media在最终脚本正文确定后应用，finalize不把XML默认偷偷降为text；空raw、显式空Content-Type、动态header、GET/HEAD等仍区分。owner wire/脚本/backup/static export回归全部通过。

**整合判断：** 非祖先且有 10 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 10 个变化路径中 4 个与候选文件完全同 blob。

**重点路径：** `src/postman-raw-body.mjs`、`src/script-final-body.mjs`、`src/runtime.mjs`、`src/core.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/postman-raw-media-workflow.test.mjs

**available_branch_tests**：tests/postman-raw-body.test.mjs

tests/postman-raw-media-workflow.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 134. `feat/protocol-history-filter`

**结论：提交历史已纳入。** SHA：[`ad2182e95824`](https://github.com/Hubujiu/local-api-workbench/tree/ad2182e9582421d3dfa38548ef80720f1e4c9bb7)；PR：[#235](https://github.com/Hubujiu/local-api-workbench/pull/235)。

**范围：** 已加载协议历史的本地筛选

实际审查比较基线 `2dffce796b82`；比较增量：5 files changed, 262 insertions(+), 2 deletions(-)。原 main 领先 1251 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43425542187)

**实际审查：**

协议类型、原始状态/会话状态和 JSON 字面搜索做 AND 筛选，只作用于已经加载的记录。

筛选是本地纯视图操作，保持稳定记录 ID；详情和导出在筛选后继续按唯一身份核对。

无服务器全历史查询或业务请求副作用，远端内容仍转义后呈现。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/protocol-history-view.js`、`public/app.js`、`tests/protocol-history-filter.test.mjs`、`tests/helpers/socketio-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：这不是服务端分页/全文搜索；大记录 JSON 搜索的性能未作独立基准。

### 135. `feat/protocol-history-ui`

**结论：提交历史已纳入。** SHA：[`8acb8b8adec8`](https://github.com/Hubujiu/local-api-workbench/tree/8acb8b8adec8b94800d3a5a4aa9271a09742a10a)；PR：[#233](https://github.com/Hubujiu/local-api-workbench/pull/233)。

**范围：** 协议终态历史详情显示

实际审查比较基线 `fa657641d79d`；比较增量：5 files changed, 166 insertions(+), 1 deletion(-)。原 main 领先 1249 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43407473266)

**实际审查：**

历史按稳定 record ID 和 project ID 查找，必须恰好一条，避免按变动索引读取错记录。

显示中的远端字符串经 escape；详情只读取已保存记录，不打开会话、不重发业务。

终态、保存状态、未知事件保持原始证据，未将 local accepted 当作远端成功。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/protocol-history-view.js`、`public/app.js`、`tests/protocol-history-view.test.mjs`、`tests/helpers/socketio-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：历史正文可能包含敏感字段；没有自动脱敏或全协议兼容性承诺。

### 136. `feat/protocol-record-export`

**结论：提交历史已纳入。** SHA：[`2dffce796b82`](https://github.com/Hubujiu/local-api-workbench/tree/2dffce796b8233b64d29a5a0d5ea0ff0d6305c5a)；PR：[#234](https://github.com/Hubujiu/local-api-workbench/pull/234)。

**范围：** 单条协议历史原始 JSON 导出

实际审查比较基线 `8acb8b8adec8`；比较增量：5 files changed, 202 insertions(+), 1 deletion(-)。原 main 领先 1250 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43415860765)

**实际审查：**

先捕获 project ID/record ID 和序列化记录，再显示确认；确认时必须仍为同项目同唯一记录且完整序列化内容未变。

取消不下载，确认只下载该条原始记录；操作不创建/停止/重发协议会话。

与详情读取相同稳定身份校验，防止确认期间切换项目或历史被替换后导出不同记录。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/protocol-history-view.js`、`public/app.js`、`tests/protocol-history-export.test.mjs`、`tests/helpers/socketio-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：明确导出原始证据，不宣称脱敏，也不将导出文件当成可重放请求。

### 137. `feat/protocol-request-semantics`

**结论：提交历史已纳入。** SHA：[`3da8f619f183`](https://github.com/Hubujiu/local-api-workbench/tree/3da8f619f183e7071d9fec44143c1cc67e24c2b9)；PR：[#12](https://github.com/Hubujiu/local-api-workbench/pull/12)。

**范围：** TCP/WebSocket/SSE 请求语义

实际审查比较基线 `88f70bb515c4`；比较增量：12 files changed, 1408 insertions(+), 11 deletions(-)。原 main 领先 400 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40908163455)

**实际审查：**

定义规范化与 delimiter 完成策略是共享 wire 执行前置条件；后续交互会话及计划脚本继承它。保留 one-shot 与 session 的差异，不把完整连接生命周期降为单次请求。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 887 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 12 个变化路径中 4 个与候选文件完全同 blob。

**重点路径：** `src/protocol-request-options.mjs`、`src/protocol-definitions.mjs`、`src/tcp-delimiter.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/protocol-request-semantics.test.mjs

tests/tcp-delimiter-pure.test.mjs

tests/tcp-delimiter-workflow.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 138. `feat/protocol-text-templates`

**结论：提交历史已纳入。** SHA：[`2dbe12c868aa`](https://github.com/Hubujiu/local-api-workbench/tree/2dbe12c868aa383850117a33528542e58c4972eb)；PR：[#23](https://github.com/Hubujiu/local-api-workbench/pull/23)。

**范围：** 协议文本模板

实际审查比较基线 `19731690bafa`；比较增量：11 files changed, 1361 insertions(+), 17 deletions(-)。原 main 领先 400 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40333840510)

**实际审查：**

文本模板在 protocol/wire 定义和执行链中共享；不把模板当 JS 执行，也不把二进制内容自动文本化。后续协议会话与 binary 进出回归共同保护这条边界。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 887 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 11 个变化路径中 4 个与候选文件完全同 blob。

**重点路径：** `src/protocol-text-templates.mjs`、`src/protocol-definitions.mjs`、`src/wire-plan.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/protocol-text-templates.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 139. `feat/redis-pinned-ssh`

**结论：提交历史已纳入。** SHA：[`85567408e83f`](https://github.com/Hubujiu/local-api-workbench/tree/85567408e83f8ba37d8a6fb0eeb04dc778e1c014)；PR：[#163](https://github.com/Hubujiu/local-api-workbench/pull/163)。

**范围：** feat: support canonical Redis reads and owner SET over pinned SSH

实际审查比较基线 `9662c161d7e0`；比较增量：26 files changed, 2127 insertions(+), 432 deletions(-)。原 main 领先 1157 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42861683258)

**实际审查：**

Redis新增固定SSH host key通道，目标端口/TLS CA/私钥/认证/命令在开网前验证；失败绝不降级直连，TLS验证逻辑Redis主机身份。

单3秒预算覆盖SSH/TLS/AUTH/SELECT/command，最终等待TLS、SSH channel和client实际close；native SET派发后仍保留未知写入语义。纯命令策略拆出避免惰性导入携带SSH依赖，CI增加真实Redis SSH集成。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 140. `feat/repeat-until-condition`

**结论：提交历史已纳入。** SHA：[`bfa5a74b845d`](https://github.com/Hubujiu/local-api-workbench/tree/bfa5a74b845d8f3d8852fc7ac2faf62dcb1c1bd3)；PR：[#110](https://github.com/Hubujiu/local-api-workbench/pull/110)。

**范围：** Add bounded repeat completion conditions

实际审查比较基线 `aa5a1fdcf551`；比较增量：9 files changed, 982 insertions(+), 12 deletions(-)。原 main 领先 1084 提交；原候选直接包含：是。

原分支精确 head 的 CI：**cancelled**。 [Validate Local API / cancelled](https://github.com/Hubujiu/local-api-workbench/actions/runs/41871138310)

**实际审查：**

repeat until在每轮后检查条件，达到count仍不满足产生明确repeat-condition-exhausted，不把false本身视为条件错误。

条件预算含所有潜在轮次、限制同组rows，嵌套只退出当前实例；授权/进度扩展到until tails，scope commit unknown强制停，证据上限或取消先于下一次条件/网络；native线性结果拒绝该元数据。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的最新历史工作流含取消，不能视作通过；最终整合必须依其自身 CI 判定。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 141. `feat/repeat-until-tcp-20261105`

**结论：提交历史已纳入。** SHA：[`fcc755fdcf2a`](https://github.com/Hubujiu/local-api-workbench/tree/fcc755fdcf2a2311adc70c15aba5c8775af037c1)；PR：[#141](https://github.com/Hubujiu/local-api-workbench/pull/141)。

**范围：** feat: support canonical TCP repeat-until plans

实际审查比较基线 `5c01bdb69819`；比较增量：9 files changed, 862 insertions(+), 16 deletions(-)。原 main 领先 1128 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42133866090)

**实际审查：**

TCP repeat-until开启canonical能力，并让条件执行授权遍历同时覆盖IF与until。

untilEnabled纳入提交未知识别，防止条件消费可能已提交但未确认值；引用/凭据预检与无重放回归齐备。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 142. `feat/request-code-generation`

**结论：语义已整合或由后续实现替代。** SHA：[`ac17ee9912a4`](https://github.com/Hubujiu/local-api-workbench/tree/ac17ee9912a49309b5732d5167749a52e0258367)；PR：[#101](https://github.com/Hubujiu/local-api-workbench/pull/101)。

**范围：** Generate bounded multi-language request examples

实际审查比较基线 `3875f89be57b`；比较增量：7 files changed, 579 insertions(+), 36 deletions(-)。原 main 领先 1057 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41842338276)

**实际审查：**

Node/Python/Go 代码生成、只读导出入口与安全拒绝已整合。当前 Python 实现新增 UTF-8 字节字面量，替代旧版只接受 ASCII 的限制。

**整合判断：** 不能用旧模块覆盖当前 Python 修复；本轮实际执行请求代码生成及 Unicode 线缆测试，Go 本机缺工具链单独跳过。空 JSON 缺口在 #129 项处理。

**重点路径：** `src/request-code-generation.mjs`、`src/core.mjs`、`src/server.mjs`、`tests/request-code-generation.test.mjs`

**验证及限制：**

不能用旧模块覆盖当前 Python 修复；本轮实际执行请求代码生成及 Unicode 线缆测试，Go 本机缺工具链单独跳过。空 JSON 缺口在 #129 项处理。

### 143. `feat/runtime-row-grpc-20261106`

**结论：提交历史已纳入。** SHA：[`759892a650a1`](https://github.com/Hubujiu/local-api-workbench/tree/759892a650a1d0e6eb2716da12bbc9ead59ea52d)；PR：[#148](https://github.com/Hubujiu/local-api-workbench/pull/148)。

**范围：** feat: admit canonical gRPC runtime rows

实际审查比较基线 `0e2d83067e54`；比较增量：13 files changed, 1123 insertions(+), 26 deletions(-)。原 main 领先 1137 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42151748576)

**实际审查：**

runtimeRows能力表增加gRPC，沿用同一行数据快照和祖先能力交集。

默认runtimeRows门禁未打开，凭据/executor需在producer前预检；空行也不能绕过授权。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 144. `feat/runtime-row-tcp-20261106`

**结论：提交历史已纳入。** SHA：[`62c442a351c8`](https://github.com/Hubujiu/local-api-workbench/tree/62c442a351c8ab9fb2105a6f8a4252cdda491c00)；PR：[#144](https://github.com/Hubujiu/local-api-workbench/pull/144)。

**范围：** feat: admit canonical TCP children in runtime row plans

实际审查比较基线 `99abb63588c9`；比较增量：12 files changed, 601 insertions(+), 47 deletions(-)。原 main 领先 1132 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42140334135)

**实际审查：**

runtimeRows显式允许HTTP/TCP叶子，不扩大其他协议。

覆盖malformed/超限行在网络前拒绝、嵌套条件与固定循环行上下文、禁用叶子校验。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 145. `feat/runtime-row-ws-20261106`

**结论：提交历史已纳入。** SHA：[`2021566bc780`](https://github.com/Hubujiu/local-api-workbench/tree/2021566bc780d0b1c3e95b8dbc9dac8bc5f3001d)；PR：[#146](https://github.com/Hubujiu/local-api-workbench/pull/146)。

**范围：** feat: admit canonical WebSocket runtime-row children

实际审查比较基线 `59d563369704`；比较增量：10 files changed, 943 insertions(+), 24 deletions(-)。原 main 领先 1134 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42145464970)

**实际审查：**

runtimeRows增加WebSocket，保留默认opt-in与冻结定义校验。

行变量绑定、有限payload、嵌套上下文和取消沿用统一逻辑，未另造可绕过授权执行路径。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 146. `feat/scoped-definition-export`

**结论：语义已整合或由后续实现替代。** SHA：[`5c90486e776a`](https://github.com/Hubujiu/local-api-workbench/tree/5c90486e776a02010649013bbf2783dab634988e)；PR：[#99](https://github.com/Hubujiu/local-api-workbench/pull/99)。

**范围：** 限定定义导出与依赖闭包

实际审查比较基线 `c7fbe040adba`；比较增量：12 files changed, 4230 insertions(+), 5 deletions(-)。原 main 领先 1038 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

preview/export两步使用显式scope和dependencies，HTTP/stdio/MCP共用产物检查。官方SDK测试确认rebind不带运行期凭据、取消排队请求不发布产物、encoded完整frame上限，20-file回归内全部通过。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 12 个变化路径中 4 个与候选文件完全同 blob。

**重点路径：** `src/definition-export-scope.mjs`、`src/scoped-definition-export.mjs`、`src/server.mjs`、`src/mcp.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/scoped-definition-export-sdk.test.mjs

**available_branch_tests**：tests/definition-export-scope.test.mjs

tests/mcp-expanded.test.mjs

tests/scoped-definition-export-contract.test.mjs

tests/scoped-definition-export-owner.test.mjs

tests/scoped-definition-export-sdk.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 147. `feat/scoped-export-ui-20261112`

**结论：提交历史已纳入。** SHA：[`5d0a983ab7a5`](https://github.com/Hubujiu/local-api-workbench/tree/5d0a983ab7a5c99e1632f39e1f2ad77d691960e0)；PR：[#228](https://github.com/Hubujiu/local-api-workbench/pull/228)。

**范围：** 选择资源范围的导出 UI

实际审查比较基线 `a84e00448706`；比较增量：8 files changed, 1126 insertions(+), 5 deletions(-)。原 main 领先 1240 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43309212393)

**实际审查：**

UI 显式选择资源类型与稳定 ID，不默认导出整个项目；Postman 选择限制为 API/folder，不提供原生 rebind。

选择去重并有数量上限；预览/确认按项目及当前选择核对，依赖闭包由服务端 exporter 判断。

当前入口通过 scoped-export-view 接入既有 owner export 路径，未把预览变成执行请求。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/scoped-export-view.js`、`public/app.js`、`docs/ADR-SCOPED-EXPORT-UI.md`、`tests/scoped-export-ui.test.mjs`、`tests/scoped-export-ui-server.test.mjs`、`tests/helpers/scoped-export-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：支持格式和资源子集有明确边界；不代表完整原版项目或非空 automated_testings 可迁移，也不承诺导出自动脱敏。

### 148. `feat/script-host-lifecycle`

**结论：提交历史已纳入。** SHA：[`5ea410ae43f8`](https://github.com/Hubujiu/local-api-workbench/tree/5ea410ae43f839ab70ea8c4990c329e91b241ee5)；PR：[#114](https://github.com/Hubujiu/local-api-workbench/pull/114)。

**范围：** Observe bounded host worker lifecycle timings

实际审查比较基线 `cab9728bea57`；比较增量：11 files changed, 932 insertions(+), 21 deletions(-)。原 main 领先 1078 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41880569511)

**实际审查：**

增加宿主worker生成、online、阶段、terminal、terminate、exit、settle及序列累计时间的只读诊断，成功观察放WeakMap避免产品结果扩张。

own data属性+枚举+有界整数投影拒绝proxy/getter；observer异常不得替代真实结果，terminal消息仍须等待worker exit，原活动/总预算及失败判定未降低。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 149. `feat/script-mock-templates`

**结论：提交历史已纳入。** SHA：[`023fdd27f2e8`](https://github.com/Hubujiu/local-api-workbench/tree/023fdd27f2e89bf12f01acd7d285ff8b6575e9cd)；PR：[#82](https://github.com/Hubujiu/local-api-workbench/pull/82)。

**范围：** 隔离脚本 Mock 模板

实际审查比较基线 `4f50dea63efd`；比较增量：22 files changed, 3048 insertions(+), 1 deletion(-)。原 main 领先 419 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41427920584)

**实际审查：**

模板执行是受限 sandbox 能力，含模板工作量、内存和执行时限，不应因合并把 vendor 代码视为普通主机 eval。候选已保留构建产物hash和 reference/runtime/workflow tests；完整 QuickJS 压测由CI专项负责。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 868 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 22 个变化路径中 16 个与候选文件完全同 blob。

**重点路径：** `src/script-mock-budget.mjs`、`src/script-mock-template.mjs`、`src/script-mock-core.mjs`、`src/script-worker.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/script-mock-artifact.test.mjs

tests/script-mock-pure.test.mjs

tests/script-mock-reference.test.mjs

tests/script-mock-runtime.test.mjs

tests/script-mock-workflow.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 150. `feat/script-startup-diagnostics`

**结论：提交历史已纳入。** SHA：[`cab9728bea57`](https://github.com/Hubujiu/local-api-workbench/tree/cab9728bea578d7a9e2fd9f7e626661615a35aa0)；PR：[#111](https://github.com/Hubujiu/local-api-workbench/pull/111)。

**范围：** Measure bounded script compatibility startup phases

实际审查比较基线 `0aca69513970`；比较增量：11 files changed, 530 insertions(+)。原 main 领先 1076 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41876847624)

**实际审查：**

把兼容初始化拆分为mock资源/安装、源码组装、执行四段时间与CPU计数，只增加观察与白名单错误投影。

新诊断保持既有2KiB/CI尺寸限制、严格版本/operation枚举且不暴露代码或上下文；mock加载仍计入原activity预算，无延长或重试，因此历史超时未被本分支修复。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 151. `feat/socketio-incoming-ack-ui`

**结论：提交历史已纳入。** SHA：[`fa657641d79d`](https://github.com/Hubujiu/local-api-workbench/tree/fa657641d79d8ac1c81dd2ac0e9587864103a9f1)；PR：[#232](https://github.com/Hubujiu/local-api-workbench/pull/232)。

**范围：** Socket.IO 入站 ACK 的显式一次响应

实际审查比较基线 `d2d0900b4de2`；比较增量：7 files changed, 448 insertions(+), 13 deletions(-)。原 main 领先 1247 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43391996332)

**实际审查：**

ACK 必须明确选中当前收到事件的 incomingAckId，验证属于会话且未出现 ack-sent 或本地回执。

回应参数是显式 JSON array；发送前保留未知证据，停止/记录问题不被 ACK 成功清除。

本地 ACK 回执数量有界；ACK 与 stop 的并发仍使用 owner busy token 与独立 stopping 状态。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/socketio-workbench.js`、`public/app.js`、`tests/socketio-workbench.test.mjs`、`tests/socketio-app-adapter.test.mjs`、`tests/socketio.test.mjs`、`tests/helpers/socketio-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：本地已提交/fixture 观察不是远端业务 exactly-once；继承 #230 unknown-start 的保守恢复限制。

### 152. `feat/socketio-runtime-rows-20261106`

**结论：提交历史已纳入。** SHA：[`f981d31555a7`](https://github.com/Hubujiu/local-api-workbench/tree/f981d31555a71b7891e846f8ca5d2f5d4ae99c4b)；PR：[#151](https://github.com/Hubujiu/local-api-workbench/pull/151)。

**范围：** feat: admit canonical Socket.IO runtime rows

实际审查比较基线 `bd57ba40cc88`；比较增量：15 files changed, 1473 insertions(+), 28 deletions(-)。原 main 领先 1141 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42158238971)

**实际审查：**

runtimeRows增加Socket.IO独立叶子能力。

回归覆盖producer前独立executor/稳定凭据检查、环境/全局抽取一次性提交、批抽取失败不泄露部分值。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 153. `feat/socketio-workbench-ui`

**结论：提交历史已纳入。** SHA：[`00e197c57477`](https://github.com/Hubujiu/local-api-workbench/tree/00e197c5747746af4d70993882c8503be645c6f1)；PR：[#230](https://github.com/Hubujiu/local-api-workbench/pull/230)。

**范围：** Socket.IO 工作台会话、保存和未知结果恢复

实际审查比较基线 `4fb255128763`；比较增量：13 files changed, 2004 insertions(+), 4 deletions(-)。原 main 领先 1244 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43332687577)

**实际审查：**

保存定义与 runtime auth/query/headers/TLS 分离；发送必须匹配当前会话冻结定义和已保存、未修改的本地定义。

connect/send 的未知标记在 dispatch 前保存；list/choose/poll 都是显式只读，不按 definition 自动认领未知连接。

stop 可与 pending send/ack 并发，用独立 stop token 保持 busy；终态保存回执、停止失败和远端发送未知分别保留。

实际检查发现 unknown-start 没有产品内闭环解除机制，列为 P2 非阻塞恢复限制，不能简单清 flag 或重放来修复。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/socketio-workbench.js`、`public/app.js`、`public/project-import-guard.js`、`tests/socketio-workbench.test.mjs`、`tests/socketio-app-adapter.test.mjs`、`tests/helpers/socketio-ui.mjs`

**发现/保留边界：**

**severity**：P2

**category**：non-blocking product recovery limitation

**path**：public/socketio-workbench.js

**line**：299

**title**：未知创建结果缺少可核对后结束该事件的产品流程

**repro_or_basis**：连接 POST 已可能发送，但回执丢失或因视图失效而晚到 -> uncertainStart=true -> 列出并手动选择会话、只读刷新甚至停止已知会话都不清该标记 -> 下次 connect 在行299即拒绝；唯一 false 赋值在正常 connect 成功之后。app 将该标记保存到当前项目 sessionStorage，重新载入后可持续存在。

**impact**：在当前项目恢复证据生命周期内可能长期只能读取/停止，无法创建新会话；保守防重放意图本身正确。

**recommendation**：后续引入绑定服务实例和创建操作 ID 的明确核对/终止流程，保留原未知业务结果证据；不能以任意清标记或自动重放绕过。

**merge_blocking**：否

**basis_scope**：当前行为与明确保守测试合同一致，不是被遗漏旧分支可以修复的回归。

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：当前保守限制会使同一项目恢复证据持续禁止新连接；需未来引入与实例/操作 ID 绑定的明确结束流程。

### 154. `feat/sqlserver-readonly-wip`

**结论：旧实现已被准备层替代。** SHA：[`29a6ceeff2d3`](https://github.com/Hubujiu/local-api-workbench/tree/29a6ceeff2d32426d7d509a1f19da3767aee83e1)；PR：[#45](https://github.com/Hubujiu/local-api-workbench/pull/45)。

**范围：** 旧 SQL Server 只读 WIP

实际审查比较基线 `88f70bb515c4`；比较增量：9 files changed, 2497 insertions(+), 1 deletion(-)。原 main 领先 401 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41010391322)

**实际审查：**

旧 read-wip/tedious-wip 已由异步 compiler worker、read-prep 和 transport/supervisor 重构替代。当前 runSQLServerReadPreparation 显式 await compileSQLServerRead，旧调用把 compiler 当同步函数；原样合旧实现会引入不匹配。当前仍未注册生产 provider，保留 WIP 档案，不宣称 SQLServer 已交付。

**整合判断：** 旧模块被后续 SQL Server preparation/transport/supervisor 重构替代。保留研究快照，不恢复旧文件；当前没有生产provider。

**重点路径：** `src/sqlserver-read-contract.mjs`、`src/sqlserver-read-prep.mjs`、`src/sqlserver-driver-contract.mjs`、`src/sqlserver-transport.mjs`

**发现/保留边界：**

**severity**：P1 if merged unchanged

**path**：src/sqlserver-read-wip.mjs

**summary**：旧入口假设 compileSQLServerRead 为同步，当前函数已是异步Worker编译；还原旧WIP会引入契约不匹配。

**evidence**：旧 runSQLServerReadWIP 中 plan=compileSQLServerRead(...) 随后读取plan.sql；当前runSQLServerReadPreparation使用 await compileSQLServerRead。候选DELIVERY-STATUS仍明确未注册provider。

**url**：https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/sqlserver-read-prep.mjs

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/sqlserver-read-contract.test.mjs

tests/sqlserver-read-wip.test.mjs

tests/sqlserver-tedious-wip.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 155. `feat/sse-runtime-rows-20261106`

**结论：提交历史已纳入。** SHA：[`c9350522a83b`](https://github.com/Hubujiu/local-api-workbench/tree/c9350522a83bd6bb6d1b07170c19402dc17f491f)；PR：[#154](https://github.com/Hubujiu/local-api-workbench/pull/154)。

**范围：** feat: admit canonical SSE runtime rows

实际审查比较基线 `600f29b0bf47`；比较增量：15 files changed, 1516 insertions(+), 24 deletions(-)。原 main 领先 1144 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42163818020)

**实际审查：**

runtimeRows补SSE能力，保持SSE捕获完成/部分结果区分。

覆盖失败第二次capture不覆盖上轮成功值、取消关闭当前流且不重连、空producer前授权。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 156. `feat/staged-collection-scopes-20261105`

**结论：提交历史已纳入。** SHA：[`f9b238160213`](https://github.com/Hubujiu/local-api-workbench/tree/f9b238160213f62ebeed00738e8725ab8a8d305a)；PR：[#136](https://github.com/Hubujiu/local-api-workbench/pull/136)。

**范围：** feat: isolate collection scopes in staged plan load

实际审查比较基线 `77bfc8081250`；比较增量：5 files changed, 484 insertions(+), 6 deletions(-)。原 main 领先 1123 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42120119136)

**实际审查：**

阶段压测允许collection，prepare和run都核查引用仍属于执行项目。

disabled叶子同样校验；run开始只捕获被引用collection，runPlan每迭代独立副本且无持久化hook，防止复用prepared对象越权。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 157. `feat/staged-plan-load`

**结论：提交历史已纳入。** SHA：[`e8f37c8b6a7b`](https://github.com/Hubujiu/local-api-workbench/tree/e8f37c8b6a7bd1889a66e9e8ab5dce41b9f613ca)；PR：[#104](https://github.com/Hubujiu/local-api-workbench/pull/104)。

**范围：** Stage bounded plan load runs

实际审查比较基线 `ff7cff175964`；比较增量：8 files changed, 1304 insertions(+), 15 deletions(-)。原 main 领先 1068 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41849898745)

**实际审查：**

引入0–10 VU、至多10阶段/60秒的单调时钟阶段压测，最多10展开HTTP步骤且总潜在步骤×迭代≤100。

每迭代私有scope/cookie，缩容只停止补位而不杀已准入工作，整体deadline在达到迭代上限后仍有效；SSE断开取消、异步observer拒绝、计时跳跃不补发过期VU，7分片后来被12分片替代。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 158. `feat/visual-plan-controls`

**结论：补丁等价已纳入。** SHA：[`f5826814bca4`](https://github.com/Hubujiu/local-api-workbench/tree/f5826814bca47d62b4b7035a6f9ffeb94e5f1980)；PR：[#219](https://github.com/Hubujiu/local-api-workbench/pull/219)。

**范围：** if/repeat 可视化控制字段编辑

实际审查比较基线 `12092b83b662`；比较增量：7 files changed, 879 insertions(+), 2 deletions(-)。原 main 领先 1227 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43201394668)

**实际审查：**

控制编辑器在 clone 中只改识别字段，保留节点 ID、层级和未显示元数据；未知形状不被静默规范化。

literal 与 variable 输入类型明确，数值须有限；repeat count 1–100、interval 0–10000，字符串字节上限与服务器合同一致。

#219 与祖先内 #220 的相对基线 diff 的 stable patch-id 完全相同；候选控制器、step-editor、样式及主要测试逐 blob 相同。

**整合判断：** 原 head 不在候选祖先中，但已通过 #220 整合；相对各自基线的 stable patch-id 相同，并核对实际实现/测试接线。

**重点路径：** `public/plan-control-editor.js`、`public/plan-view.js`、`public/step-editor.js`、`tests/plan-control-editor.test.mjs`、`tests/helpers/plan-control-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：数值/字符串输入检查不等于完整计划语义验证；服务端仍作权威准入。

### 159. `feat/visual-plan-structure-20261112`

**结论：提交历史已纳入。** SHA：[`c9606aefa6a9`](https://github.com/Hubujiu/local-api-workbench/tree/c9606aefa6a997532df6c6c9b7bb56bd854a47a1)；PR：[#223](https://github.com/Hubujiu/local-api-workbench/pull/223)。

**范围：** 计划步骤结构编辑与只读服务端预检

实际审查比较基线 `ae093e5a9770`；比较增量：9 files changed, 1152 insertions(+), 1 deletion(-)。原 main 领先 1233 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43279815701)

**实际审查：**

结构编辑使用隔离 clone、唯一 ID、最多 4 层控制嵌套、每层 200 节点及非空子节点限制；新增 HTTP 请求取选中请求快照。

add/remove/同层移动先做候选预检，pending 期间禁改；只有同 owner/plan/original object/editVersion/modalRevision 的结果才进入草稿。

POST plans-validate 走精确 owner 路径、projectConfigRevision 校验和规范化验证，仅返回 acknowledgement，不保存或执行；测试检查磁盘字节及 loopback 连接数保持。

最终提交仍经 savePlan/CAS，预检回执不作为日后永久写权限。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/plan-structure-editor.js`、`public/app.js`、`public/plan-view.js`、`src/server.mjs`、`tests/plan-structure-preview.test.mjs`、`tests/plan-structure-mutation.test.mjs`、`tests/plan-structure-ui-ownership.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：只读预检与最终保存之间允许并发状态变化，最终保存仍可能因版本冲突失败。

### 160. `feat/windows-first-install-candidate`

**结论：提交历史已纳入。** SHA：[`e77bb59e5214`](https://github.com/Hubujiu/local-api-workbench/tree/e77bb59e52144c70afdd6a043d6f0653121b8fe9)；PR：[#257](https://github.com/Hubujiu/local-api-workbench/pull/257)。

**范围：** build: add a Windows first-install candidate generator

实际审查比较基线 `407d724d02a2`；比较增量：3 files changed, 190 insertions(+)。原 main 领先 1279 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43719940901)

**实际审查：**

从固定 SHA 和独立 manifest hash 的载荷生成 NSIS 首装候选；current-user 固定目录、拒绝静默/覆盖、拒绝未知入口身份，生成过程不调用编译器、不运行安装器。

**整合判断：** 功能是可编译候选生成器；升级、卸载、签名、公证和干净机器验收均未完成。保持名称与文档限制，不将其当发布版。

**重点路径：** `scripts/prepare_windows_first_install.py`、`tests/test_portable_first_install.py`、`docs/WINDOWS-FIRST-INSTALL-CANDIDATE.md`

**验证及限制：**

功能是可编译候选生成器；升级、卸载、签名、公证和干净机器验收均未完成。保持名称与文档限制，不将其当发布版。

### 161. `feat/windows-first-install-inventory`

**结论：提交历史已纳入。** SHA：[`19bd7cbd57c9`](https://github.com/Hubujiu/local-api-workbench/tree/19bd7cbd57c99804fb712430ea6f8ede498938b0)；PR：[#259](https://github.com/Hubujiu/local-api-workbench/pull/259)。

**范围：** test: verify Windows first-install payload inventory read-only

实际审查比较基线 `7d7453b91a5c`；比较增量：5 files changed, 192 insertions(+), 4 deletions(-)。原 main 领先 1281 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43855660867)

**实际审查：**

只读核对已安装目录：独立载荷身份、完整文件 hash、入口、pending 不存在、无额外目录；不执行安装包或应用。

**整合判断：** verify_first_install 显式启用遍历错误失败。来源中的 Windows 用户报告只是历史报告；本轮未操作用户电脑。

**重点路径：** `scripts/verify_windows_first_install.py`、`scripts/stage_windows_payload.py`、`scripts/verify_portable_download.py`、`tests/test_portable_windows_installed_inventory.py`

**验证及限制：**

verify_first_install 显式启用遍历错误失败。来源中的 Windows 用户报告只是历史报告；本轮未操作用户电脑。

### 162. `feat/windows-first-install-pending-promotion`

**结论：提交历史已纳入。** SHA：[`7d7453b91a5c`](https://github.com/Hubujiu/local-api-workbench/tree/7d7453b91a5c12b4a731e08d6ecfa24a439306fb)；PR：[#258](https://github.com/Hubujiu/local-api-workbench/pull/258)。

**范围：** build: stage Windows first install before no-replace promotion

实际审查比较基线 `e77bb59e5214`；比较增量：3 files changed, 68 insertions(+), 14 deletions(-)。原 main 领先 1280 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43725050099)

**实际审查：**

先排他创建 .pending，逐文件写入，再用 MoveFileExW(flags=0)无覆盖提升。目标存在、reparse ancestor、复制失败均拒绝；失败保留 pending 供明确处理。

**整合判断：** 本轮静态核对拒绝覆盖与失败分支；既有 Python 生成器测试通过。NSIS 原生运行和竞态环境仍需要指定 Windows 场景验收，不以生成脚本测试替代。

**重点路径：** `scripts/prepare_windows_first_install.py`、`tests/test_portable_first_install.py`

**验证及限制：**

本轮静态核对拒绝覆盖与失败分支；既有 Python 生成器测试通过。NSIS 原生运行和竞态环境仍需要指定 Windows 场景验收，不以生成脚本测试替代。

### 163. `feat/windows-install-record-lifecycle-evidence`

**结论：提交历史已纳入。** SHA：[`2532d67136fb`](https://github.com/Hubujiu/local-api-workbench/tree/2532d67136fbc89000ecaf079f826ed229600e86)；PR：[#263](https://github.com/Hubujiu/local-api-workbench/pull/263)。

**范围：** feat: pin Windows install identity and verify retained files

实际审查比较基线 `6d34f7a2283b`；比较增量：11 files changed, 702 insertions(+), 15 deletions(-)。原 main 领先 1287 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921)

**实际审查：**

生成确定性的安装记录，独立 pin 记录 hash；读取生命周期 baseline 时校验 hash/重复字段/大小；保护数据目录须与应用/pending 不重叠，保留文件/目录/hash 精确比较。

**整合判断：** 只读文件证据工具不会执行卸载、删目录或签署应用。操作结果包含 operationExecuted=false/nativeLifecycleVerified=false；保持这个真实边界。71 项 Python 回归通过。

**重点路径：** `scripts/windows_install_record.py`、`scripts/verify_windows_lifecycle.py`、`scripts/verify_windows_first_install.py`、`scripts/prepare_windows_first_install.py`、`tests/test_portable_windows_lifecycle.py`、`tests/test_portable_install_record.py`

**验证及限制：**

只读文件证据工具不会执行卸载、删目录或签署应用。操作结果包含 operationExecuted=false/nativeLifecycleVerified=false；保持这个真实边界。71 项 Python 回归通过。

### 164. `feat/windows-installer-payload-stage`

**结论：提交历史已纳入。** SHA：[`68087048ddbd`](https://github.com/Hubujiu/local-api-workbench/tree/68087048ddbda905db15a90e3f97275ad8919faa)；PR：[#254](https://github.com/Hubujiu/local-api-workbench/pull/254)。

**范围：** build: stage verified Windows installer payloads

实际审查比较基线 `a2a084904694`；比较增量：3 files changed, 266 insertions(+)。原 main 领先 1276 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43706536563)

**实际审查：**

显式载荷 SHA/manifest、产品名/版本/架构、Windows 文件名、保留设备名、大小写冲突与符号链接校验后，向全新目录 materialize，不安装、不执行。

**整合判断：** 发现共同 inventory 扫描默认忽略遍历错误的缺口已统一修复；当前所有 staging 默认扫描都继承 fail-closed 行为。

**重点路径：** `scripts/stage_windows_payload.py`、`scripts/materialize_portable_download.py`、`scripts/verify_portable_download.py`、`tests/test_portable_windows_stage.py`

**验证及限制：**

发现共同 inventory 扫描默认忽略遍历错误的缺口已统一修复；当前所有 staging 默认扫描都继承 fail-closed 行为。

### 165. `feat/wire-plan-scripts`

**结论：提交历史已纳入。** SHA：[`29067dfc2579`](https://github.com/Hubujiu/local-api-workbench/tree/29067dfc257997b597b3e1fb1dfa059564fc737f)；PR：[#81](https://github.com/Hubujiu/local-api-workbench/pull/81)。

**范围：** TCP/WebSocket/SSE 计划脚本

实际审查比较基线 `d898e4b059fd`；比较增量：13 files changed, 2898 insertions(+), 129 deletions(-)。原 main 领先 442 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41260887329)

**实际审查：**

wire 与 gRPC 使用显式 shared script phases，保留协议原始证据与二进制拒绝边界。候选有对应 workflow/context tests；函数树和脚本预算由后续 QuickJS 约束继续收紧。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 845 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 13 个变化路径中 6 个与候选文件完全同 blob。

**重点路径：** `src/wire-plan-scripts.mjs`、`src/wire-script-context.mjs`、`src/plan-script-phases.mjs`、`src/core.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/wire-plan-scripts-workflow.test.mjs

tests/wire-plan-scripts.test.mjs

tests/wire-script-context-pure.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 166. `feat/wire-session-autosave`

**结论：提交历史已纳入。** SHA：[`b4a180b65ddc`](https://github.com/Hubujiu/local-api-workbench/tree/b4a180b65ddc1f068cb1e73994876bf8c9d501c9)；PR：[#40](https://github.com/Hubujiu/local-api-workbench/pull/40)。

**范围：** wire 会话证据自动落盘与关闭

实际审查比较基线 `7c5afb162c68`；比较增量：13 files changed, 1535 insertions(+), 69 deletions(-)。原 main 领先 411 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40604138726)

**实际审查：**

会话结果及持久化收据必须与发送成功分开；host shutdown 合并过程中仍保留 session evidence 测试。候选新增 UI 恢复流不能重新发送旧会话，根审查负责最新交互部分。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 876 个提交；保留候选即可带入历史，不再制造重复合并。 对照的 13 个变化路径中 9 个与候选文件完全同 blob。

**重点路径：** `src/wire-session-evidence.mjs`、`src/host-shutdown.mjs`、`src/protocol-sessions.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**available_branch_tests**：tests/host-shutdown-process.test.mjs

tests/host-shutdown.test.mjs

tests/project-session-receive-encoding.test.mjs

tests/protocol-sessions.test.mjs

tests/wire-session-evidence.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 167. `feat/workbench-digest-step-overrides`

**结论：提交历史已纳入。** SHA：[`6d34f7a2283b`](https://github.com/Hubujiu/local-api-workbench/tree/6d34f7a2283be2ccec96738642ff57066bca4ed2)；PR：[#262](https://github.com/Hubujiu/local-api-workbench/pull/262)。

**范围：** feat: support independent Digest overrides in HTTP steps

实际审查比较基线 `3a80f0af0122`；比较增量：5 files changed, 317 insertions(+), 6 deletions(-)。原 main 领先 1285 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/44092421807)

**实际审查：**

显式 workbench_digest 扩展只覆盖已有 Digest username/password，不改变类型、challenge policy或传输持有的nonce。逐重复步骤独立保存，保持 source request 和非本步骤不变。

**整合判断：** 当前计划快照会保存覆盖凭据，文档明确这一点；不宣称原厂 Digest schema。真实 challenge、保存/重启与重复步骤隔离回归通过。

**重点路径：** `src/native-mcp-plan.mjs`、`src/native-mcp-tools.mjs`、`tests/workbench-digest-step-overrides.test.mjs`

**验证及限制：**

当前计划快照会保存覆盖凭据，文档明确这一点；不宣称原厂 Digest schema。真实 challenge、保存/重启与重复步骤隔离回归通过。

### 168. `feature/canonical-if-sse-20261105`

**结论：提交历史已纳入。** SHA：[`288226c3412d`](https://github.com/Hubujiu/local-api-workbench/tree/288226c3412d7e9f7aced168fc5ae6e501a5c1cc)；PR：[#121](https://github.com/Hubujiu/local-api-workbench/pull/121)。

**范围：** Support canonical IF SSE via existing bounded capture

实际审查比较基线 `b1b550f633dc`；比较增量：7 files changed, 994 insertions(+), 28 deletions(-)。原 main 领先 1107 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42068695902)

**实际审查：**

IF SSE仅在canonical控制表扩展sse，沿用TCP/WebSocket通用预检与执行。

测试覆盖false/disabled仍静态校验、EOF/事件/时长、未知持久化停止、无重连与冻结恢复。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 169. `feature/canonical-if-tcp-20261104`

**结论：提交历史已纳入。** SHA：[`22efe52c618e`](https://github.com/Hubujiu/local-api-workbench/tree/22efe52c618e92f855470ba279dd08de42fefced)；PR：[#118](https://github.com/Hubujiu/local-api-workbench/pull/118)。

**范围：** Support canonical IF groups with TCP plan steps

实际审查比较基线 `de09a8a7349e`；比较增量：7 files changed, 1007 insertions(+), 7 deletions(-)。原 main 领先 1101 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41915673538)

**实际审查：**

IF TCP建立条件协议预检，区分IF条件与repeat-until限制，并递归检查protocol scripts。

遍历携带until限制避免嵌套假IF放宽HTTP-only父约束；当前后续能力表重构保留这一交集原则。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 170. `feature/canonical-if-websocket-20261105`

**结论：提交历史已纳入。** SHA：[`b1b550f633dc`](https://github.com/Hubujiu/local-api-workbench/tree/b1b550f633dc0527107304ee7ec5cc3063ea0806)；PR：[#120](https://github.com/Hubujiu/local-api-workbench/pull/120)。

**范围：** Support canonical IF WebSocket with preflight and scope safeguards

实际审查比较基线 `6b6add6c70dd`；比较增量：6 files changed, 1186 insertions(+), 51 deletions(-)。原 main 领先 1105 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42063874023)

**实际审查：**

IF WebSocket把分散判断集中到controlCapabilities，所有祖先分别约束叶子。

运行时按条件协议类型集合预检；references仅冻结前暂许，冻结后重验，不因disabled/false放宽结构。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 171. `feature/plan-history-manual-refresh`

**结论：提交历史已纳入。** SHA：[`9c44eca4dfd2`](https://github.com/Hubujiu/local-api-workbench/tree/9c44eca4dfd28bc3bbe5610bfe70483d7e1d7962)；PR：[#246](https://github.com/Hubujiu/local-api-workbench/pull/246)。

**范围：** 计划运行历史手动只读刷新

实际审查比较基线 `95c634acc2b0`；比较增量：11 files changed, 736 insertions(+), 17 deletions(-)。原 main 领先 1268 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43670765124)

**实际审查：**

刷新只发 owner project GET，采用前检查响应 project ID、runs 唯一 ID/results 数组和序列；只替换 runs，不替换配置/revision/fingerprint 或解除 reconciliation。

app handler 捕获 owner/openSequence/editVersion/lastRun/旧 runs/目标 DOM，项目切换、草稿变化、业务开始、页面或 DOM 替换后拒绝晚到结果。

当前 lastRun 仍优先显示/导出，不能以持久化旧结果覆盖本地未知执行证据。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/plan-history-refresh.js`、`public/app.js`、`public/plan-view.js`、`tests/plan-history-refresh.test.mjs`、`tests/plan-history-refresh-wiring.test.mjs`、`tests/helpers/plan-history-refresh-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：仅刷新已存运行历史；不轮询重放、不保存草稿，不自动修复全项目的存储或版本不确定性。

### 172. `feature/python-utf8-export-20261105`

**结论：提交历史已纳入。** SHA：[`4d822ba51a27`](https://github.com/Hubujiu/local-api-workbench/tree/4d822ba51a27162c90b0b3000ee0c7579be327ac)；PR：[#125](https://github.com/Hubujiu/local-api-workbench/pull/125)。

**范围：** Preserve literal UTF-8 bodies in Python request examples

实际审查比较基线 `5bdaebd87cee`；比较增量：4 files changed, 247 insertions(+), 26 deletions(-)。原 main 领先 1113 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42078759853)

**实际审查：**

Python请求代码导出把正文逐UTF8字节写成bytes literal，避免JSON重解析及Python源码插值。

保留HTTP方法/URL/headers/1MiB输入输出边界，GET/HEAD带body仍拒绝；非ASCII/控制字节有实际Python发送回归。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 173. `feature/sqlserver-contract-20261105`

**结论：提交历史已纳入。** SHA：[`53acffadde50`](https://github.com/Hubujiu/local-api-workbench/tree/53acffadde503e934751be14ca9495eb949aeac5)；PR：[#126](https://github.com/Hubujiu/local-api-workbench/pull/126)。

**范围：** Add inert bounded SQL Server query contract

实际审查比较基线 `4d822ba51a27`；比较增量：5 files changed, 650 insertions(+)。原 main 领先 1114 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42079642389)

**实际审查：**

SQLServer仅内部无网络SELECT合同编译器：独立有资源上限worker再生TOP1001、单本地表、显式列和@pN比较，拒绝函数/多语句/跨库/动态SQL。

参数为明确null/Unicode/bool/int32/精确int64，64参数1MiB与2并发2秒预算；不注册provider，不代表真实SQLServer连接或数据库只读性已验收。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 174. `feature/sqlserver-driver-prep-20261105`

**结论：提交历史已纳入。** SHA：[`de9b04764e03`](https://github.com/Hubujiu/local-api-workbench/tree/de9b04764e03be63f6e10f06d9649030bba4f63d)；PR：[#127](https://github.com/Hubujiu/local-api-workbench/pull/127)。

**范围：** Prepare disabled SQL Server driver and supervised cleanup

实际审查比较基线 `53acffadde50`；比较增量：14 files changed, 2822 insertions(+)。原 main 领先 1116 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42087345079)

**实际审查：**

SQLServer内部Tedious准备链要求显式验证TLS、固定连接器一次分配、零retry/reroute、目标库确认及READ_ONLY探针后才读编译SQL。

collector拒绝不精确类型、第二结果集与1000行/1MiB超限；supervisor独立10秒总预算、500mscleanup、1秒kill回执，缺OS close即隔离准入，IPC传凭据且无自动重放。仍未注册公共provider，真实服务器验收独立。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 175. `feature/staged-runtime-rows-20261104`

**结论：提交历史已纳入。** SHA：[`5289fce02a02`](https://github.com/Hubujiu/local-api-workbench/tree/5289fce02a027171a12098a152da5d11f13f274c)；PR：[#117](https://github.com/Hubujiu/local-api-workbench/pull/117)。

**范围：** Support transient runtime rows in staged HTTP load plans

实际审查比较基线 `de09a8a7349e`；比较增量：5 files changed, 1036 insertions(+), 48 deletions(-)。原 main 领先 1100 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41905839177)

**实际审查：**

阶段压测显式支持运行时数据行；prepare和run都重新准入并复制schedule/plan，预制对象不是授权，live引用须先被冻结。

所有潜在runtime工作先预算和HTTP-only检查，避免producer先执行才发现不支持DB；每VU私有行/cookie/scope，报告固定枚举不回显行值，正常旧计划的DB失败时序保留。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 176. `fix/apipost-native-query-import`

**结论：提交历史已纳入。** SHA：[`7167ce31e30e`](https://github.com/Hubujiu/local-api-workbench/tree/7167ce31e30ef356d51cc974c8b99940fe2cbe1e)；PR：[#5](https://github.com/Hubujiu/local-api-workbench/pull/5)。

**范围：** 原版 Offline2 导出中的 URL/query 双份镜像和真实脚本执行回归

实际审查比较基线 `88f70bb515c4`；比较增量：6 files changed, 1608 insertions(+), 1 deletion(-)。原 main 领先 398 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40199316420)

**实际审查：**

已读 apipost-modern 生产补丁；核对多重集匹配而非全局去重、重复参数与片段保留；检查原版导出/重导出 fixture 的历史保留。

**整合判断：** 分支头是候选祖先。导入只逐个消耗 raw URL 中已由启用 query 行表示的项，避免把原本合法的重复参数一起删掉。原版导出、导入后执行及脚本顺序测试仍在；恢复 fixture 后续改为显式 Store.restore，符合更新不能创建的新边界。

**重点路径：** `src/apipost-modern.mjs`

**代码锚点：** [src/apipost-modern.mjs:20](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/apipost-modern.mjs#L20)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：没有再次运行第三方原版应用或将其 UI 观察等同本次验证。

### 177. `fix/auth-header-case-20261105`

**结论：提交历史已纳入。** SHA：[`f715d6d0e939`](https://github.com/Hubujiu/local-api-workbench/tree/f715d6d0e939cfcf957eda18ce23c834e52c893d)；PR：[#130](https://github.com/Hubujiu/local-api-workbench/pull/130)。

**范围：** Fix case-insensitive API-key request headers

实际审查比较基线 `de9b04764e03`；比较增量：3 files changed, 449 insertions(+), 1 deletion(-)。原 main 领先 1117 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42100059111)

**实际审查：**

API Key header写入统一小写键，修复不同大小写导致认证覆盖/Content-Type/长度处理不一致。

只改header，不改区分大小写的query参数名；重复单值规则与签名行为仍由既有规范执行。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 178. `fix/base64-expansion-preflight`

**结论：提交历史已纳入。** SHA：[`1de4f4d7cbf5`](https://github.com/Hubujiu/local-api-workbench/tree/1de4f4d7cbf521dd17a2595f9e062a7687f402ee)；PR：[#32](https://github.com/Hubujiu/local-api-workbench/pull/32)。

**范围：** Base64 编码前检查 UTF-8 长度、非法代理项与扩张上限

实际审查比较基线 `88f70bb515c4`；比较增量：9 files changed, 1487 insertions(+), 20 deletions(-)。原 main 领先 397 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41258648572)

**实际审查：**

已读预分配检查与模板接线；核对先算编码后大小，再允许构造输出。

**整合判断：** 祖先已经含修复。UTF-8 字节数按码点计算并拒绝未配对 surrogate；Base64 扩张和 64 KiB JSON 输出边界在分配前判定。不会靠先生成超大结果再检查来规避预算。后续诊断只增加有界失败观察，不改变限额。

**重点路径：** `src/apipost-function-templates.mjs`、`src/base64-encoding-preflight.mjs`

**代码锚点：** [src/base64-encoding-preflight.mjs:3](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/base64-encoding-preflight.mjs#L3)；[src/apipost-function-templates.mjs:1](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/apipost-function-templates.mjs#L1)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 179. `fix/case-write-ownership`

**结论：提交历史已纳入。** SHA：[`41ca841a836a`](https://github.com/Hubujiu/local-api-workbench/tree/41ca841a836a099c00c7d3f49b69d2df9d078122)；PR：[#216](https://github.com/Hubujiu/local-api-workbench/pull/216)。

**范围：** 用例写操作的项目所有权

实际审查比较基线 `d61070323622`；比较增量：5 files changed, 452 insertions(+), 24 deletions(-)。原 main 领先 1224 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43187941217)

**实际审查：**

用例生成/保存/删除进入 prepareProjectWrite 和共享 projectImports 生命周期；在必要且明确的情况下先保存原草稿。

异步结果采用前检查 owner、编辑版本及导航序列；不确定写入要求重新读取，不盲目补发。

错误回滚仅限本次操作仍持有的草稿，不能撤销用户在请求期间产生的新编辑。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/app.js`、`public/project-import-guard.js`、`tests/case-write-ownership-ui.test.mjs`、`tests/helpers/case-write-ownership-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：应用层串行与所有权门禁不等同远端业务 exactly-once；外部进程并发仍由服务端 revision/CAS 负责。

### 180. `fix/clickhouse-decimal-precision`

**结论：语义已整合或由后续实现替代。** SHA：[`ff343854eb46`](https://github.com/Hubujiu/local-api-workbench/tree/ff343854eb46eccc86d5f99a28593105eb4f5b12)；PR：[#52](https://github.com/Hubujiu/local-api-workbench/pull/52)。

**范围：** ClickHouse Decimal 字符串精度和返回元数据验证

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 533 insertions(+), 2 deletions(-)。原 main 领先 398 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40670408344)

**实际审查：**

已读 clickhouse 全补丁和当前类型/值转换；逐个追踪包装类型、quoted labels、空结果元数据与重复列。

**整合判断：** 非祖先但 91 条有效新增源码行均保留。当前启用 Decimal 的 JSON 引号输出，用有界类型解析器区分 Decimal、Nullable、Array、LowCardinality 等允许组合；不把未知包装或 JSON/Dynamic 结果当作可精确保真的数值。精度/scale 验证使用字符串位数，空 rows 也检查元数据；原小数精度回归仍在。

**重点路径：** `src/clickhouse.mjs`

**代码锚点：** [src/clickhouse.mjs:70](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/clickhouse.mjs#L70)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 181. `fix/clickhouse-integer-precision`

**结论：提交历史已纳入。** SHA：[`50893afaa865`](https://github.com/Hubujiu/local-api-workbench/tree/50893afaa865a4b7eac72840ceabb32c849711d6)；PR：[#196](https://github.com/Hubujiu/local-api-workbench/pull/196)。

**范围：** fix: reject unsafe ClickHouse integer parameters before transport

实际审查比较基线 `70f97c6cec53`；比较增量：3 files changed, 183 insertions(+), 5 deletions(-)。原 main 领先 1199 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43071734474)

**实际审查：**

ClickHouse参数拒绝不安全整数，要求精确大整数用字符串传入。

验证发生在HTTP/HTTPS构造前；有限小数与安全边界保持，不声称能恢复已经JSON.parse舍入的小数。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 182. `fix/clickhouse-unicode-fidelity`

**结论：提交历史已纳入。** SHA：[`31db8fc74a3e`](https://github.com/Hubujiu/local-api-workbench/tree/31db8fc74a3e5b615743ba1bb8aecb610f937da0)；PR：[#193](https://github.com/Hubujiu/local-api-workbench/pull/193)。

**范围：** fix: reject lossy ClickHouse Unicode before request construction

实际审查比较基线 `0074631108be`；比较增量：3 files changed, 182 insertions(+), 3 deletions(-)。原 main 领先 1196 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43066297156)

**实际审查：**

ClickHouse SQL、database、认证文本和参数拒绝孤立UTF16代理项，防止UTF8替换改变请求。

输入边界在网络前，合法Unicode不归一化，既有单条SELECT/WITH与无自定义SETTINGS约束保持。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 183. `fix/cookie-request-cancellation`

**结论：语义已整合或由后续实现替代。** SHA：[`1f4598253ced`](https://github.com/Hubujiu/local-api-workbench/tree/1f4598253ced5d0ee8fad42335f96724910428b9)；PR：[#49](https://github.com/Hubujiu/local-api-workbench/pull/49)。

**范围：** HTTP Cookie 等待、捕获、发布与取消/超时的一致事务边界

实际审查比较基线 `88f70bb515c4`；比较增量：12 files changed, 1747 insertions(+), 46 deletions(-)。原 main 领先 397 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40649580395)

**实际审查：**

已读 cookie-jar、request-control、http-finalization 及 core/runtime/file-lock 调用链；核对排队取消和已完成 HTTP 后持久化失败。

**整合判断：** cookie-jar、request-control、http-finalization 与分支同 blob；共享文件经后续集成重排。单一单调截止时间覆盖 cookie 等待和网络，取消不会遗弃仍可能写入的 transaction；后置捕获失败仍保存已完成的响应，并给 retry_safe:false。旧 if(record.failure) 被当前 if(record.failure || record.redirectFailure) 扩展，停止语义未丢失。

**重点路径：** `src/cookie-jar.mjs`、`src/core.mjs`、`src/file-lock.mjs`、`src/http-finalization.mjs`、`src/request-control.mjs`、`src/runtime.mjs`、`src/server.mjs`

**代码锚点：** [src/request-control.mjs:4](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/request-control.mjs#L4)；[src/http-finalization.mjs:21](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/http-finalization.mjs#L21)；[src/core.mjs:1791](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/core.mjs#L1791)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 184. `fix/database-ui-numeric-fidelity`

**结论：提交历史已纳入。** SHA：[`df481ea29288`](https://github.com/Hubujiu/local-api-workbench/tree/df481ea29288afc26bd2d6f013bfeec1d931e948)；PR：[#197](https://github.com/Hubujiu/local-api-workbench/pull/197)。

**范围：** fix: reject lossy database UI numeric parameters before sending

实际审查比较基线 `50893afaa865`；比较增量：5 files changed, 151 insertions(+), 2 deletions(-)。原 main 领先 1201 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43073231796)

**实际审查：**

浏览器数据库参数使用JSON reviver拒绝Infinity及不安全整数，防止JSON.stringify静默变null或改值。

普通查询与保存操作双入口接线；明确有限小数舍入/下溢已发生，需精确值时应字符串。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 185. `fix/debug-variable-publication`

**结论：语义已整合或由后续实现替代。** SHA：[`c26d8b90cca6`](https://github.com/Hubujiu/local-api-workbench/tree/c26d8b90cca6f546e0d05d2d160ff6209d90caaa)；PR：[#65](https://github.com/Hubujiu/local-api-workbench/pull/65)。

**范围：** 异步调试变量发布的所有者、epoch 和 ABA 防护

实际审查比较基线 `88f70bb515c4`；比较增量：7 files changed, 531 insertions(+), 35 deletions(-)。原 main 领先 396 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40820343590)

**实际审查：**

已读 debug-publication helper、环境 ticket 建立与 HTTP/MCP 使用点。

**整合判断：** helper 与分支完全同 blob。发布需同时匹配当前条目身份、generation 和执行票据，用户清空或手工编辑后，较早执行结果不能覆盖新状态。MCP/HTTP 当前接线保留该检查，并附加更严格的 scope context。

**重点路径：** `src/debug-publication.mjs`、`src/environments.mjs`、`src/mcp.mjs`、`src/server.mjs`

**代码锚点：** [src/debug-publication.mjs:4](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/debug-publication.mjs#L4)；[src/environments.mjs:3](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/environments.mjs#L3)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 186. `fix/digest-entity-replay`

**结论：语义已整合或由后续实现替代。** SHA：[`9fd1d485695d`](https://github.com/Hubujiu/local-api-workbench/tree/9fd1d485695d8ca355a5ef713037b89dc040514d)；PR：[#20](https://github.com/Hubujiu/local-api-workbench/pull/20)。

**范围：** Digest challenge 解析、认证政策与精确实体重放

实际审查比较基线 `88f70bb515c4`；比较增量：14 files changed, 3116 insertions(+), 34 deletions(-)。原 main 领先 403 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41058924913)

**实际审查：**

已读 challenge/parser 全补丁、multipart 实体缓存、current executeRequest 私有递归；检查单一 deadline 和 Digest 在 load 模式的准入。

**整合判断：** digest helper 与分支相同；旧私有 Symbol 状态改成私有执行函数，不对外暴露重放控制。算法/challenge 选择有界，明确政策可禁止 retry，multipart 复用同一实体和 Content-Type，认证快照在 await 前隔离。loadNetworkBudget 未传到 Digest 二次请求不是可达绕过：load 准入明确拒绝 Digest，不能把这个表面差异报为漏洞。

**重点路径：** `src/core.mjs`、`src/digest.mjs`、`src/runtime.mjs`

**代码锚点：** [src/digest.mjs:4](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/digest.mjs#L4)；[src/runtime.mjs:146](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/runtime.mjs#L146)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：本次未接外部 Digest 服务；依据真实补丁和当前完整调用链判断等价。

### 187. `fix/document-import-metadata-closure`

**结论：提交历史已纳入。** SHA：[`83fe11dd0a1b`](https://github.com/Hubujiu/local-api-workbench/tree/83fe11dd0a1b0a1ee30654beb53535480323e5ec)；PR：[#158](https://github.com/Hubujiu/local-api-workbench/pull/158)。

**范围：** fix: retain metadata closure in selective document import

实际审查比较基线 `c462071dd822`；比较增量：5 files changed, 464 insertions(+), 3 deletions(-)。原 main 领先 1148 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42827393146)

**实际审查：**

手动导入依赖图补documents.statusId与attributes字段名的类型引用。

文件正文文本不当引用扫描；依赖冲突、悬空status/attribute必须在导入计划阶段拒绝，防部分写入。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 188. `fix/empty-json-export-20261105`

**结论：本轮补回遗漏功能和历史。** SHA：[`ccea109c6225`](https://github.com/Hubujiu/local-api-workbench/tree/ccea109c6225a1ebf2dcc72f2bd76670ebd982e1)；PR：[#129](https://github.com/Hubujiu/local-api-workbench/pull/129)。

**范围：** Fix empty JSON definition exports to match runtime bodies

实际审查比较基线 `5892fea015d8`；比较增量：11 files changed, 1548 insertions(+)。原 main 领先 1118 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42095609638)

**实际审查：**

P2：运行时把 bodyType=json 且正文为空解释为 {}，候选导出的 cURL/Node/Python/Go 却发送空正文。实测 prepareLiteralHTTPExport 返回空串，断言 {} 失败。

**整合判断：** 已三方合并原 PR #129 的三条提交，产品代码仅增加临时导出副本的空 JSON 归一化；保留文字、原始 raw、持久化定义和脚本无副作用边界。38 通过/0 失败/8 Go 跳过，含进程清理回归。

**重点路径：** `src/core.mjs`、`tests/empty-json-export.test.mjs`、`tests/codegen-fixture-process.test.mjs`、`tests/codegen-job-cleanup.test.mjs`、`tests/helpers/codegen-fixture-process.mjs`、`tests/helpers/codegen-windows-job.py`

**验证及限制：**

已三方合并原 PR #129 的三条提交，产品代码仅增加临时导出副本的空 JSON 归一化；保留文字、原始 raw、持久化定义和脚本无副作用边界。38 通过/0 失败/8 Go 跳过，含进程清理回归。

### 189. `fix/empty-multipart-curl-20261105`

**结论：本轮补回遗漏功能和历史。** SHA：[`40aa7dd26fc3`](https://github.com/Hubujiu/local-api-workbench/tree/40aa7dd26fc3f124370464efcdb4d2d4ec2950d0)；PR：[#128](https://github.com/Hubujiu/local-api-workbench/pull/128)。

**范围：** Fix empty multipart framing in POSIX cURL export

实际审查比较基线 `5892fea015d8`；比较增量：3 files changed, 249 insertions(+), 1 deletion(-)。原 main 领先 1116 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42087208461)

**实际审查：**

P2：候选对空或全禁用 multipart 生成没有 multipart 正文/边界的 cURL，和实际执行不等价。原分支文件缺失，移植原测试在修复前失败。

**整合判断：** 已三方合并 PR #128：生成固定 48 字符边界、54 字节结束帧，替换 framing headers；拒绝冲突 framing/API-key 注入。真实 POSIX cURL+runtime 回归 2/2 通过。Windows shell、非空 multipart 和其它语言 multipart 范围不扩大。

**重点路径：** `src/core.mjs`、`tests/curl-empty-multipart.test.mjs`、`docs/CURL-EMPTY-MULTIPART.md`

**验证及限制：**

已三方合并 PR #128：生成固定 48 字符边界、54 字节结束帧，替换 framing headers；拒绝冲突 framing/API-key 注入。真实 POSIX cURL+runtime 回归 2/2 通过。Windows shell、非空 multipart 和其它语言 multipart 范围不扩大。

### 190. `fix/execution-elapsed-clocks`

**结论：语义已整合或由后续实现替代。** SHA：[`7986621bffae`](https://github.com/Hubujiu/local-api-workbench/tree/7986621bffae509eb0573d9054ba0f3b8e650a72)；PR：[#76](https://github.com/Hubujiu/local-api-workbench/pull/76)。

**范围：** 动态值求值和负载运行的单调时间预算

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 244 insertions(+), 11 deletions(-)。原 main 领先 396 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41228131393)

**实际审查：**

已读 dynamic-values 与 load-runner 时间计算补丁。

**整合判断：** 非祖先变化已按语义落入当前实现。运行预算用 performance.now 的固定引用，动态值阶段前后检查整体 5 秒边界，load 时长/次数与经过时间不因系统时间回拨补充额度。Date.now 仍可用于真实时间戳，不应全局替换。

**重点路径：** `src/dynamic-values.mjs`、`src/load-runner.mjs`

**代码锚点：** [src/dynamic-values.mjs:54](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/dynamic-values.mjs#L54)；[src/load-runner.mjs:30](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/load-runner.mjs#L30)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 191. `fix/execution-save-receipts`

**结论：提交历史已纳入。** SHA：[`7c5afb162c68`](https://github.com/Hubujiu/local-api-workbench/tree/7c5afb162c6814964ea7cc7ce8047caddcadc603)；PR：[#30](https://github.com/Hubujiu/local-api-workbench/pull/30)。

**范围：** 执行证据保存结果、未确认提交与不可自动重放的收据

实际审查比较基线 `cdb9d2fee78c`；比较增量：17 files changed, 1482 insertions(+), 96 deletions(-)。原 main 领先 404 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40467260432)

**实际审查：**

已读 execution-evidence、plan-evidence、socketio-evidence 及 HTTP/MCP/CLI 调用变更。

**整合判断：** 祖先已经纳入。网络执行与 append 存储分离；失败保留 attemptedRecordId，只有已确认保存才设置 recordSaved/recordId，任何存储错误均不宣布网络重试安全。Socket.IO 冻结一份最终证据，重试只核对同 ID、完整证据哈希，不重连/重发；环境 ID 也成为执行证据的一部分。

**重点路径：** `scripts/run-plan.mjs`、`src/execution-evidence.mjs`、`src/mcp.mjs`、`src/plan-evidence.mjs`、`src/server.mjs`、`src/socketio-evidence.mjs`

**代码锚点：** [src/execution-evidence.mjs:9](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/execution-evidence.mjs#L9)；[src/socketio-evidence.mjs:6](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/socketio-evidence.mjs#L6)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 192. `fix/execution-write-ownership`

**结论：提交历史已纳入。** SHA：[`38717504f6b6`](https://github.com/Hubujiu/local-api-workbench/tree/38717504f6b6e7c508996ea551bfee2062b0689d)；PR：[#218](https://github.com/Hubujiu/local-api-workbench/pull/218)。

**范围：** 执行、计划及批量写入的异步所有权

实际审查比较基线 `12092b83b662`；比较增量：6 files changed, 1200 insertions(+), 75 deletions(-)。原 main 领先 1230 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43202770967)

**实际审查：**

prepareProjectWrite 在显式保存草稿后冻结 owner、editVersion、open sequence 和计划摘要，执行/保存前后均核对。

execution/import/native 生命周期共用写入 guard；busy/saving 防止新业务动作与未知结果并发。

结果晚到不在新项目写入记录或清除不相关 busy 状态；结果未知保留核对需求。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/app.js`、`public/project-import-guard.js`、`docs/gui-async-ownership-audit.md`、`tests/execution-write-ownership-ui.test.mjs`、`tests/helpers/execution-write-ownership-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：这是一组 UI 并发保证，不替代服务器取消/存储回执；收到请求取消也不证明远端未执行。

### 193. `fix/file-lock-recovery-ownership`

**结论：语义已整合或由后续实现替代。** SHA：[`2f8b665bb458`](https://github.com/Hubujiu/local-api-workbench/tree/2f8b665bb45873c1042336d964009d1b1adf6772)；PR：[#83](https://github.com/Hubujiu/local-api-workbench/pull/83)。

**范围：** 跨进程项目锁恢复时的所有权竞争和取消排队

实际审查比较基线 `1f4598253ced`；比较增量：6 files changed, 863 insertions(+), 24 deletions(-)。原 main 领先 404 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41584161550)

**实际审查：**

已读完整 file-lock 补丁和当前 guard、pid/nonce、排队/截止时间实现；检查跨进程用例保留。

**整合判断：** 非祖先变化已集成。父目录先同步 canonicalize，SQLite 持久 sibling guard 的 BEGIN IMMEDIATE 序列化恢复操作；只将 SQLITE_BUSY 作为可等待竞争，不删除 guard 本身。遗留 owner 的 pid/nonce 检查发生在 guard 内，失败清理仅移除本调用拥有的锁。当前 firstAttempt 保留一次真实尝试，但硬 10 秒边界不延长。

**重点路径：** `src/file-lock.mjs`

**代码锚点：** [src/file-lock.mjs:108](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/file-lock.mjs#L108)；[src/file-lock.mjs:98](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/file-lock.mjs#L98)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：这是本地文件系统及升级后进程间所有权保证；没有把静态审查外推为断电或网络文件系统耐久性证明。

### 194. `fix/generated-body-ownership`

**结论：提交历史已纳入。** SHA：[`d61070323622`](https://github.com/Hubujiu/local-api-workbench/tree/d61070323622a8c210c264fa93eac86004c63845)；PR：[#215](https://github.com/Hubujiu/local-api-workbench/pull/215)。

**范围：** 生成示例请求体的迟到响应隔离

实际审查比较基线 `6e27108c49bc`；比较增量：4 files changed, 257 insertions(+), 5 deletions(-)。原 main 领先 1223 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43184039149)

**实际审查：**

生成请求体前捕获 project/request 对象、editVersion、projectOpenSequence、generation、当前页面及 body 模式。

返回后重新检查所有权，只有仍在相同编辑上下文时才修改 body 并标记脏数据；切换项目/接口、编辑正文或旧请求晚到都不能覆写新草稿。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/app.js`、`tests/generated-body-ownership-ui.test.mjs`、`tests/helpers/generated-body-ownership-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：生成操作仍可能在后端完成；这里证明 UI 不错误接收晚到结果，不把取消 UI 视为取消后端工作。

### 195. `fix/git-local-history-roundtrip`

**结论：提交历史已纳入。** SHA：[`3a80f0af0122`](https://github.com/Hubujiu/local-api-workbench/tree/3a80f0af012287bf5be32792d66e426c4f16cee6)；PR：[#261](https://github.com/Hubujiu/local-api-workbench/pull/261)。

**范围：** fix: reopen Git clones without sharing local histories

实际审查比较基线 `65819ce3b937`；比较增量：6 files changed, 303 insertions(+), 32 deletions(-)。原 main 领先 1283 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/44078560248)

**实际审查：**

存储格式 3 将历史声明移至本地 manifest，Git 只共享定义；保留格式 2 读取、严格区分纯定义克隆与历史清单意外丢失；事务恢复仍由完整 journal 驱动。

**整合判断：** 默认 .gitignore 不会取消用户已追踪的秘密/历史；旧程序不能读格式 3，回退需完整备份。真实 Git clone/edit/restore/跨项目隔离与 project-files 相关回归已通过。

**重点路径：** `src/project-files.mjs`、`tests/project-git-roundtrip.test.mjs`、`tests/project-files.test.mjs`、`tests/request-definition-history-files.test.mjs`、`tests/load-report-storage-isolation.test.mjs`

**验证及限制：**

默认 .gitignore 不会取消用户已追踪的秘密/历史；旧程序不能读格式 3，回退需完整备份。真实 Git clone/edit/restore/跨项目隔离与 project-files 相关回归已通过。

### 196. `fix/http-content-encoding-case-20261105`

**结论：提交历史已纳入。** SHA：[`23a88ed06976`](https://github.com/Hubujiu/local-api-workbench/tree/23a88ed06976b238dde5ce7c7e98191a9711e14c)；PR：[#132](https://github.com/Hubujiu/local-api-workbench/pull/132)。

**范围：** Fix case-insensitive HTTP content-coding decoding

实际审查比较基线 `814920876e77`；比较增量：2 files changed, 107 insertions(+)。原 main 领先 1119 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42105846706)

**实际审查：**

HTTP解压选择对content-coding名称小写，支持混合大小写gzip/deflate/br。

仍不解码未知/叠加编码，HEAD/1xx/204/304例外保留，205继续按原编码检查，避免掩盖坏body。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 197. `fix/http-extract-atomic`

**结论：提交历史已纳入。** SHA：[`8f14ba761da6`](https://github.com/Hubujiu/local-api-workbench/tree/8f14ba761da673120a0b4864932301d2c19807dd)；PR：[#42](https://github.com/Hubujiu/local-api-workbench/pull/42)。

**范围：** HTTP 多条响应提取的原子发布

实际审查比较基线 `88f70bb515c4`；比较增量：3 files changed, 351 insertions(+), 12 deletions(-)。原 main 领先 397 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40497295089)

**实际审查：**

已读 core 提取阶段补丁和 staged values 提交顺序。

**整合判断：** 祖先已含。先完成整批 extraction 的解析，任一后续提取失败不会把前面变量泄漏到公开 scope；确认整批成功后再发布。此变化应随候选整体保留，不必重新 merge 原分支。

**重点路径：** `src/core.mjs`

**代码锚点：** [src/core.mjs:1160](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/core.mjs#L1160)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 198. `fix/http-no-body-decompression-20261105`

**结论：提交历史已纳入。** SHA：[`814920876e77`](https://github.com/Hubujiu/local-api-workbench/tree/814920876e772832a56e7ad0cd70544c460673f0)；PR：[#131](https://github.com/Hubujiu/local-api-workbench/pull/131)。

**范围：** Fix decompression of HTTP responses without message content

实际审查比较基线 `f715d6d0e939`；比较增量：4 files changed, 361 insertions(+), 20 deletions(-)。原 main 领先 1118 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42103425687)

**实际审查：**

抽取统一responseContentDecoder并给直连与redirect传method/status，避免无消息体响应尝试解压。

仍消费原流以处理end/error/取消；没有扩大CONNECT支持，也没有把零字节普通响应当成无消息体例外。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 199. `fix/http-proxy-request-target`

**结论：提交历史已纳入。** SHA：[`a59eba6b30c4`](https://github.com/Hubujiu/local-api-workbench/tree/a59eba6b30c4b4bb34b734559b6af20661690e94)；PR：[#48](https://github.com/Hubujiu/local-api-workbench/pull/48)。

**范围：** HTTP 代理 absolute-form 请求目标移除 fragment

实际审查比较基线 `88f70bb515c4`；比较增量：3 files changed, 411 insertions(+), 2 deletions(-)。原 main 领先 398 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40617738320)

**实际审查：**

已读 connection 补丁并核对 clone 后清空 hash 的顺序。

**整合判断：** 祖先已含。代理请求行使用复制 URL 的无片段绝对地址，原始定义保持不变，路径中编码的 %23 不会错误当作 fragment 删除。

**重点路径：** `src/connection.mjs`

**代码锚点：** [src/connection.mjs:52](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/connection.mjs#L52)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 200. `fix/http-response-protocol-20261105`

**结论：提交历史已纳入。** SHA：[`f7a510947508`](https://github.com/Hubujiu/local-api-workbench/tree/f7a510947508afe75eefc02853f4e069c712dcf7)；PR：[#134](https://github.com/Hubujiu/local-api-workbench/pull/134)。

**范围：** fix: select MessagePack responses by media subtype

实际审查比较基线 `e69e96037355`；比较增量：4 files changed, 84 insertions(+), 2 deletions(-)。原 main 领先 1121 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42111330798)

**实际审查：**

MessagePack检测改为合法media type的子类型/后缀，而非任意字符串包含msgpack。

直连与redirect统一调用，text/plain的参数note=msgpack不会触发解码；保留原始rawBodyBase64和codecError路径。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 201. `fix/import-preview-ownership-20261112`

**结论：提交历史已纳入。** SHA：[`a84e00448706`](https://github.com/Hubujiu/local-api-workbench/tree/a84e004487063bee32d4d4197fb140d5f49cb5bc)；PR：[#227](https://github.com/Hubujiu/local-api-workbench/pull/227)。

**范围：** 导入预览草稿及弹窗所有权

实际审查比较基线 `1e877c711967`；比较增量：8 files changed, 748 insertions(+), 37 deletions(-)。原 main 领先 1239 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43303915900)

**实际审查：**

预览捕获 project 对象、请求/草稿、editVersion、dialog revision 和导航上下文，晚到预览不能填充已关闭或改属其他资源的对话框。

预览和 apply 写入分开；apply 仍经 owner revision/共享写入 guard，单纯预览不会取得写权限。

测试 fixture 的认证与视图验证保留，避免通过修改等待方式绕过真正所有权检查。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/app.js`、`docs/gui-async-ownership-audit.md`、`tests/preview-draft-ownership-ui.test.mjs`、`tests/helpers/preview-draft-ownership-ui.mjs`、`tests/preview-fixture-auth.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：取消弹窗不表示后端预览任务从未执行，只保证结果不错误采用；预览本身不执行导入内容。

### 202. `fix/import-response-ownership`

**结论：提交历史已纳入。** SHA：[`6e27108c49bc`](https://github.com/Hubujiu/local-api-workbench/tree/6e27108c49bc46c2cd657526d0821cbc8ac0d7e4)；PR：[#214](https://github.com/Hubujiu/local-api-workbench/pull/214)。

**范围：** 导入/恢复响应所有权与项目重读协调

实际审查比较基线 `aadb49896579`；比较增量：7 files changed, 882 insertions(+), 41 deletions(-)。原 main 领先 1222 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43181043484)

**实际审查：**

导入前捕获项目对象、编辑版本及导航序列，晚到回执不能因同一 project ID 就覆盖新的草稿或已切换项目。

共享 guard 记录 pending mutation 和需要重新加载的项目；显式重读凭 checkpoint 确认，旧 GET 不得清除后来写操作产生的不确定性。

守卫允许导入内显式保存既有草稿但阻止其他并发写入；恢复为新项目与修改当前项目分别处理。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/app.js`、`public/project-import-guard.js`、`tests/helpers/project-import-ownership-ui.mjs`、`tests/project-import-ownership-ui.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：本次手工检查关键 guard、app 调用点和测试断言；浏览器导入持有响应旅程依赖固定候选 CI，未逐个旧分支重跑。

### 203. `fix/import-shutdown-read-drain`

**结论：提交历史已纳入。** SHA：[`1d91d3aea2a1`](https://github.com/Hubujiu/local-api-workbench/tree/1d91d3aea2a12b055be9d9236062640866a422cc)；PR：[#159](https://github.com/Hubujiu/local-api-workbench/pull/159)。

**范围：** fix: drain guarded reads during automatic import shutdown

实际审查比较基线 `83fe11dd0a1b`；比较增量：6 files changed, 400 insertions(+), 8 deletions(-)。原 main 领先 1149 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42830560179)

**实际审查：**

ActiveProjectImports集中跟踪所有Store.get promise，shutdown等待非running poll读锁释放。

#read关闭后拒绝新读、finally移出集合；activate/resume/tick/execute成功及失败重读均接线，真实interval+Store guard回归避免假定定时器已停就无读操作。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 204. `fix/load-disconnect`

**结论：语义已整合或由后续实现替代。** SHA：[`4d213e5a5b58`](https://github.com/Hubujiu/local-api-workbench/tree/4d213e5a5b5853a613a82b0bb00bb1f3e1022dec)；PR：[#102](https://github.com/Hubujiu/local-api-workbench/pull/102)。

**范围：** Cancel load runs when the caller disconnects

实际审查比较基线 `3875f89be57b`；比较增量：3 files changed, 198 insertions(+), 19 deletions(-)。原 main 领先 1056 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41840073198)

**实际审查：**

调用者断开时的负载任务取消已接入当前 server；对应 ADR 与 load-client-disconnect 测试和旧分支字节一致。

**整合判断：** 保留已执行请求证据并停止在途/后续调度，不将客户端断开等同远端业务回滚。旧 SHA 不在祖先不代表功能遗漏。

**重点路径：** `src/server.mjs`、`tests/load-client-disconnect.test.mjs`、`docs/ADR-LOAD-CALLER-DISCONNECT.md`

**验证及限制：**

保留已执行请求证据并停止在途/后续调度，不将客户端断开等同远端业务回滚。旧 SHA 不在祖先不代表功能遗漏。

### 205. `fix/lock-first-attempt`

**结论：提交历史已纳入。** SHA：[`38c927fd2b7d`](https://github.com/Hubujiu/local-api-workbench/tree/38c927fd2b7d931be371f02ad342826a18b0aa8c)；PR：[#113](https://github.com/Hubujiu/local-api-workbench/pull/113)。

**范围：** Attempt uncontended locks once within the hard deadline

实际审查比较基线 `cab9728bea57`；比较增量：2 files changed, 285 insertions(+), 3 deletions(-)。原 main 领先 1078 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41880227034)

**实际审查：**

file lock在idle预算已过但hard deadline未过时允许唯一非阻塞首次尝试。

SQLite/legacy目录两实现一致；若首次失败立即停，不读取/恢复他人owner也不延长等待；hard deadline和取消检查不放宽。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 206. `fix/mcp-config-publication`

**结论：语义已整合或由后续实现替代。** SHA：[`491d3821c277`](https://github.com/Hubujiu/local-api-workbench/tree/491d3821c2778025063a27ff509511b1db2fcc93)；PR：[#70](https://github.com/Hubujiu/local-api-workbench/pull/70)。

**范围：** MCP 设置的串行发布、令牌旋转和权限缩减 fence

实际审查比较基线 `faf6a660d7e7`；比较增量：8 files changed, 1707 insertions(+), 59 deletions(-)。原 main 领先 411 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41590359264)

**实际审查：**

已读队列 helper、持久化 helper、当前 server 设置入口与 archive 入口；比较 generation 与 HTTP/database session epoch。

**整合判断：** 两个独立 helper 与原分支同 blob。持久化前后均确认发布 generation；权限缩减先切断旧授权和活动工作，再串行保存最新记忆快照，失败不让旧完成回调重新授予权限。当前数据库和 HTTP 会话各有 epoch，取代早期单一 fence；归档阵列原位撤销避免在途 handler 持有旧引用。

**重点路径：** `src/mcp-config-publication.mjs`、`src/mcp-config-store.mjs`、`src/server.mjs`

**代码锚点：** [src/mcp-config-publication.mjs:3](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/mcp-config-publication.mjs#L3)；[src/mcp-config-store.mjs:4](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/mcp-config-store.mjs#L4)；[src/server.mjs:300](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/server.mjs#L300)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 207. `fix/mock-schema-unique-items`

**结论：语义已整合或由后续实现替代。** SHA：[`fef693ac2345`](https://github.com/Hubujiu/local-api-workbench/tree/fef693ac2345b12253e18d918b6dc4ca41d78d72)；PR：[#90](https://github.com/Hubujiu/local-api-workbench/pull/90)。

**范围：** JSON Schema Mock uniqueItems 的结构比较和累计预算

实际审查比较基线 `88f70bb515c4`；比较增量：3 files changed, 691 insertions(+), 31 deletions(-)。原 main 领先 401 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41762256998)

**实际审查：**

已读 schema-sample 全补丁，比较 -0、对象键序、数组次序及递归/预算拒绝路径。

**整合判断：** 当前 schema-sample 与原分支同 blob。JSON 结构等价不依赖对象属性顺序，拒绝 accessor/proxy/cycle，计入节点、文本及比较工作，预算耗尽状态不可通过 oneOf 重试复位。uniqueItems 的 tuple 和嵌套路径仍保留。

**重点路径：** `src/schema-sample.mjs`

**代码锚点：** [src/schema-sample.mjs:281](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/schema-sample.mjs#L281)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 208. `fix/mongo-cancellation-event-gate`

**结论：提交历史已纳入。** SHA：[`f1afa202d36e`](https://github.com/Hubujiu/local-api-workbench/tree/f1afa202d36e29e13fb6d996850a370633c674e1)；PR：[#182](https://github.com/Hubujiu/local-api-workbench/pull/182)。

**范围：** test: isolate Mongo handshake cancellation from polling

实际审查比较基线 `22029af311fb`；比较增量：3 files changed, 376 insertions(+), 159 deletions(-)。原 main 领先 1181 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43020690762)

**实际审查：**

Mongo取消测试从轮询改为每次调用独占listener/port的首data同步门，避免2秒真实总期限先到及前次晚连接误触下一次abort。

增加无取消对照必须保留failed/interrupted total-deadline；旧监听一直占位到teardown，未知早终态或5秒就绪超时必须失败，生产实现/预算未变。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 209. `fix/mongodb-direct-port`

**结论：提交历史已纳入。** SHA：[`a2170cf8c1b2`](https://github.com/Hubujiu/local-api-workbench/tree/a2170cf8c1b2e2121f48d8c2b871eccce7cfa3b2)；PR：[#201](https://github.com/Hubujiu/local-api-workbench/pull/201)。

**范围：** fix: reject ambiguous MongoDB direct-query ports

实际审查比较基线 `06d20a3a7a93`；比较增量：3 files changed, 254 insertions(+)。原 main 领先 1205 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43080093673)

**实际审查：**

MongoDB直连端口拒绝NaN、布尔/对象及非十进制字符串，防止Number转换选错目标。

保持既有空/0默认值与十进制兼容，后续范围/整数校验仍生效；会话端口仍严格整数，SSH未开放。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 210. `fix/mongodb-integer-filter-precision`

**结论：语义已整合或由后续实现替代。** SHA：[`244e7c2767b7`](https://github.com/Hubujiu/local-api-workbench/tree/244e7c2767b7da2f4a99e634f5bc05ecb85c1ad9)；PR：[#53](https://github.com/Hubujiu/local-api-workbench/pull/53)。

**范围：** MongoDB filter 的整数/EJSON 类型精度准入

实际审查比较基线 `88f70bb515c4`；比较增量：4 files changed, 842 insertions(+)。原 main 领先 398 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40688406213)

**实际审查：**

已读 mongodb 数值 wrapper 校验及原始整数过滤补丁。

**整合判断：** 30 条有效源码新增行仍在候选。裸不安全整数拒绝；$numberInt/$numberLong 等 wrapper 必须是独立字符串包装，int32/int64 用 BigInt 范围检查，不接受额外混合成员。避免 JavaScript 已经舍入的整数悄悄变成不同查询条件。

**重点路径：** `src/mongodb.mjs`

**代码锚点：** [src/mongodb.mjs:78](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/mongodb.mjs#L78)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 211. `fix/mongodb-port-ui`

**结论：提交历史已纳入。** SHA：[`236db2eada99`](https://github.com/Hubujiu/local-api-workbench/tree/236db2eada997255b08233931df93b785b777a62)；PR：[#203](https://github.com/Hubujiu/local-api-workbench/pull/203)。

**范围：** fix: validate MongoDB UI port text before numeric coercion

实际审查比较基线 `a29374777889`；比较增量：8 files changed, 189 insertions(+), 32 deletions(-)。原 main 领先 1208 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43083257362)

**实际审查：**

MongoDB UI在Number前使用十进制文本parser，避免16进制/指数被悄然接受。

复用MySQL纯parser保留各自错误文案；注册连接与直接查询均接线，其他provider规则保持。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 212. `fix/mongodb-unicode-fidelity`

**结论：提交历史已纳入。** SHA：[`502628ee1bab`](https://github.com/Hubujiu/local-api-workbench/tree/502628ee1babd811379ac5922ffd8a5bbd06c609)；PR：[#191](https://github.com/Hubujiu/local-api-workbench/pull/191)。

**范围：** fix: reject malformed MongoDB Unicode before worker admission

实际审查比较基线 `ed3c4d8428c7`；比较增量：3 files changed, 269 insertions(+), 3 deletions(-)。原 main 领先 1194 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43061550540)

**实际审查：**

MongoDB递归查询键/字符串、数据库及认证字段拒绝失真Unicode。

先于worker/网络，保留结构深度/节点限额、危险操作与JS禁用；合法Unicode透传真实driver wire。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 213. `fix/mysql-connection-unicode`

**结论：提交历史已纳入。** SHA：[`06d20a3a7a93`](https://github.com/Hubujiu/local-api-workbench/tree/06d20a3a7a93b244df5349215b3f8fe17b44b3a1)；PR：[#200](https://github.com/Hubujiu/local-api-workbench/pull/200)。

**范围：** fix: reject malformed MySQL connection text before admission

实际审查比较基线 `bea505026a7b`；比较增量：6 files changed, 271 insertions(+)。原 main 领先 1204 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43078940164)

**实际审查：**

MySQL认证和database的Unicode检验接到直读、写入解析、会话注册三处。

拒绝在Worker/SSH/写入slot授权前发生；只保护文本保真，不改变其他provider默认值或认证策略。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 214. `fix/mysql-port-ui`

**结论：提交历史已纳入。** SHA：[`70f97c6cec53`](https://github.com/Hubujiu/local-api-workbench/tree/70f97c6cec53052df19903dba19437b5d7b04393)；PR：[#195](https://github.com/Hubujiu/local-api-workbench/pull/195)。

**范围：** fix: validate raw MySQL port text before UI number conversion

实际审查比较基线 `a5e90f2abff1`；比较增量：7 files changed, 296 insertions(+), 3 deletions(-)。原 main 领先 1198 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43069307571)

**实际审查：**

MySQL UI注册/查询两入口在数值转换前验证端口文本。

空白/0保持既有默认，十进制范围0..65535；其他providers独立合同未因公共UI改写。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 215. `fix/mysql-read-port-validation`

**结论：提交历史已纳入。** SHA：[`a5e90f2abff1`](https://github.com/Hubujiu/local-api-workbench/tree/a5e90f2abff15621f5466fbc314e4437e237307d)；PR：[#194](https://github.com/Hubujiu/local-api-workbench/pull/194)。

**范围：** fix: reject invalid MySQL read ports before transport admission

实际审查比较基线 `31db8fc74a3e`；比较增量：3 files changed, 248 insertions(+)。原 main 领先 1197 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43067845816)

**实际审查：**

MySQL direct read对类型、有限性、十进制与整数范围先校验再生成连接配置。

read兼容默认sentinels不扩大write/session/SSH规则；错误端口不再落回3306。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 216. `fix/mysql-write-lifecycle`

**结论：提交历史已纳入。** SHA：[`567bc1ea1f03`](https://github.com/Hubujiu/local-api-workbench/tree/567bc1ea1f037558367f1fcb8b3daebb8c9aaf18)；PR：[#33](https://github.com/Hubujiu/local-api-workbench/pull/33)。

**范围：** MySQL 写入所有权、分阶段超时和 COMMIT 不确定性

实际审查比较基线 `9cde529a25c5`；比较增量：8 files changed, 1349 insertions(+), 87 deletions(-)。原 main 领先 401 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40392670629)

**实际审查：**

已读完整写入补丁；检查连接 owner、驱动 error sink、DML/committing 状态、KILL 与本地关闭等待。

**整合判断：** 祖先已纳入。整体 8 秒及阶段预算涵盖连接、元数据、DML 和收尾；只有仍活跃且尚未提交的 DML 才尝试 KILL。进入 COMMIT 后不再宣称回滚成功，不因关闭错误推翻已确认的 COMMIT ACK。容量 lease 直到自有 socket/tunnel 实际关闭后才释放。

**重点路径：** `src/mysql-write.mjs`

**代码锚点：** [src/mysql-write.mjs:111](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/mysql-write.mjs#L111)；[src/mysql-write.mjs:352](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/mysql-write.mjs#L352)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：未再次搭建 MySQL 服务；真实外部数据库整合 gate 的执行归主报告，不能用本次静态审查代替。

### 217. `fix/native-append-legacy-plans`

**结论：提交历史已纳入。** SHA：[`c462071dd822`](https://github.com/Hubujiu/local-api-workbench/tree/c462071dd822aedf059119151d36e1e9ba9df808)；PR：[#157](https://github.com/Hubujiu/local-api-workbench/pull/157)。

**范围：** fix: retain legacy plan admission in native append replay

实际审查比较基线 `7bf3e20d6c4b`；比较增量：5 files changed, 328 insertions(+), 3 deletions(-)。原 main 领先 1147 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42823392188)

**实际审查：**

原生append保留完整未归一化plan集合证明后只复用一次已验证归一化结果。

解决opaque和稀疏legacy plan被第二次snapshot改变ID/时间或拒绝；仍用整个replayed project深比较防夹带计划修改。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 218. `fix/native-mock-budgets`

**结论：提交历史已纳入。** SHA：[`a739f02c97e9`](https://github.com/Hubujiu/local-api-workbench/tree/a739f02c97e91e652e04d349c576dec0826f8186)；PR：[#75](https://github.com/Hubujiu/local-api-workbench/pull/75)。

**范围：** 原版 Mock QuickJS 的单调时间和尾部计费

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 341 insertions(+), 9 deletions(-)。原 main 领先 397 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41258808194)

**实际审查：**

已读 library 的 64 行生产补丁，核对结果字符串化/JSON parse/handle dispose 也计入耗时。

**整合判断：** 祖先已含。中断截止时间及 remaining 改为固定 monotonicNow；最后一次调用即使在 QuickJS polling 间隙完成，只要累计预算已经负数，就不能发布“成功”的值。dispose 在 finally 内，关闭开销仍计费。

**重点路径：** `src/native-mock-library.mjs`

**代码锚点：** [src/native-mock-library.mjs:175](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/native-mock-library.mjs#L175)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 219. `fix/oauth2-token-lifecycle`

**结论：提交历史已纳入。** SHA：[`6350e7ef07b1`](https://github.com/Hubujiu/local-api-workbench/tree/6350e7ef07b18ccef2956bdf793b2bde91419821)；PR：[#31](https://github.com/Hubujiu/local-api-workbench/pull/31)。

**范围：** OAuth2 token 交换、一次性 state、取消、关闭和响应验证

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 1525 insertions(+), 61 deletions(-)。原 main 领先 399 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40604083282)

**实际审查：**

已读完整 OAuth/server 补丁；核对 basic/body/none 认证、PKCE state claim、回调编码、连接关闭与 provider 文本隔离。

**整合判断：** 祖先已纳入。回调先同步把 pending 改为 exchanging，再进入 await，失败/取消也消费 state；令牌响应验证为有界 Bearer 字段，外部错误描述不直接透出。Basic 的每段 credentials 按 OAuth 的 form 编码生成；交换 15 秒、流 5 分钟、并发数有界。调用者断开和 server.close 启动会 abort 所属交换并擦除敏感临时态。

**重点路径：** `src/oauth.mjs`、`src/server.mjs`

**代码锚点：** [src/oauth.mjs:317](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/oauth.mjs#L317)；[src/oauth.mjs:64](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/oauth.mjs#L64)；[src/server.mjs:367](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/server.mjs#L367)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 220. `fix/openapi-auth-definition-export`

**结论：语义已整合或由后续实现替代。** SHA：[`de09ec25bd77`](https://github.com/Hubujiu/local-api-workbench/tree/de09ec25bd7753fa7d6ef970985ec1a3983ffe3f)；PR：[#58](https://github.com/Hubujiu/local-api-workbench/pull/58)。

**范围：** OpenAPI 认证定义的无凭据导出和显式继承关闭

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 682 insertions(+), 40 deletions(-)。原 main 领先 398 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40751420089)

**实际审查：**

已读 helper 与 core 接线，检查 schemes、security、inheritAuth:false 和命名碰撞。

**整合判断：** helper 与原分支完全相同。只导出认证结构，不把 Bearer/API key/JWT 实际秘密写入 securitySchemes。显式 override 与继承关闭优先；未知认证类型直接报错。对已有导入 security 的保留有条件，不无依据改写到另一认证语义。

**重点路径：** `src/core.mjs`、`src/openapi-auth-definition.mjs`

**代码锚点：** [src/openapi-auth-definition.mjs:6](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/openapi-auth-definition.mjs#L6)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 221. `fix/openapi-nullable-source`

**结论：提交历史已纳入。** SHA：[`068a5f751429`](https://github.com/Hubujiu/local-api-workbench/tree/068a5f7514299aa6e795fb8a093762b2d6cf5e5b)；PR：[#165](https://github.com/Hubujiu/local-api-workbench/pull/165)。

**范围：** fix: preserve nullable source dialect through OpenAPI export

实际审查比较基线 `c24537538fdb`；比较增量：6 files changed, 500 insertions(+), 8 deletions(-)。原 main 领先 1160 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42973610187)

**实际审查：**

持久保留nullable的源方言，3.0保持语义、3.1删除无效关键字；不能从3.0目标方言倒推源语义。

只走Schema位置，保留literal样例；外部保留扩展冲突、失效/不明来源、跨方言共享组件替换和3.0 ref nullable兄弟拒绝，顶层不支持Schema位置不静默穿透。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 222. `fix/openapi-object-header-cookie`

**结论：提交历史已纳入。** SHA：[`71e2bb69d912`](https://github.com/Hubujiu/local-api-workbench/tree/71e2bb69d912d2b8a5e0952b3e80c273ab9275be)；PR：[#161](https://github.com/Hubujiu/local-api-workbench/pull/161)。

**范围：** fix: reject unsupported OpenAPI Header and Cookie objects

实际审查比较基线 `1f9a6630eee3`；比较增量：12 files changed, 1072 insertions(+), 4 deletions(-)。原 main 领先 1154 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42848339684)

**实际审查：**

阻止OAS3 Header/Cookie对象或嵌套对象被通用标量fallback转成普通文本，检验schema正向组合及实际选中值/委派默认。

循环安全遍历且不把literal注释或未选default误认合同；content参数独立拒绝，旧Swagger/手工行/primitive数组保持。后续明确Header对象与Cookie dialect分支在该安全基线扩展。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 223. `fix/openapi-query-array-serialization`

**结论：语义已整合或由后续实现替代。** SHA：[`919a0b63d0fe`](https://github.com/Hubujiu/local-api-workbench/tree/919a0b63d0fef2ec8441d77da0393d2ee4d0df1c)；PR：[#57](https://github.com/Hubujiu/local-api-workbench/pull/57)。

**范围：** OpenAPI query 数组 form/explode 的精确序列化

实际审查比较基线 `88f70bb515c4`；比较增量：15 files changed, 1532 insertions(+), 21 deletions(-)。原 main 领先 397 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40742269939)

**实际审查：**

已读完整当前 openapi-query-arrays 与 query-serialization，并比较原补丁、script URL/MCP/runtime 接线。

**整合判断：** 原标量数组语义完整保留。version1 元数据区分 explode；数组文本 64 KiB、1000 项受限，scalar 类型严格；真实逗号与已编码分隔符不混淆，保留无关 raw query 拼写。之后对象支持由另一个严格模块扩展，不表示旧分支丢失。SDK URL mode 与 AWS CSV presign 的不支持组合仍显式拒绝。

**重点路径：** `src/core.mjs`、`src/dynamic-values.mjs`、`src/mcp-request-input.mjs`、`src/openapi-query-arrays.mjs`、`src/query-serialization.mjs`、`src/runtime.mjs`、`src/script-url-export.mjs`、`src/script-url-openapi.mjs`、`src/script-url-runtime.mjs`、`src/vendor/url-sdk-facade-manifest.json`

**代码锚点：** [src/openapi-query-arrays.mjs:5](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/openapi-query-arrays.mjs#L5)；[src/query-serialization.mjs:18](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/query-serialization.mjs#L18)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 224. `fix/openapi-scalar-allow-reserved`

**结论：提交历史已纳入。** SHA：[`1f9a6630eee3`](https://github.com/Hubujiu/local-api-workbench/tree/1f9a6630eee33fca37ec5c0b22aeb9d265086e75)；PR：[#160](https://github.com/Hubujiu/local-api-workbench/pull/160)。

**范围：** fix: reject unsupported scalar query allowReserved semantics

实际审查比较基线 `1d91d3aea2a1`；比较增量：8 files changed, 561 insertions(+), 6 deletions(-)。原 main 领先 1152 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42840081876)

**实际审查：**

allowReserved检查前移到数组/标量分支之前，关闭scalar参数绕过拒绝门禁。

true支持由后续显式feature分支开放；此修复阶段对inherited/resolved参数同样生效，absent/false保持编码语义。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 225. `fix/openapi-scalar-parameter-values`

**结论：语义已整合或由后续实现替代。** SHA：[`64f3762a9f8c`](https://github.com/Hubujiu/local-api-workbench/tree/64f3762a9f8c4259a656f14bd498cd12b1b3528b)；PR：[#62](https://github.com/Hubujiu/local-api-workbench/pull/62)。

**范围：** OpenAPI 标量参数 example/examples/default 的准确优先级

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 757 insertions(+), 3 deletions(-)。原 main 领先 396 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40783901121)

**实际审查：**

已读 scalar-values 全补丁及迁移后的 query/header-cookie 调用处。

**整合判断：** 独立 helper 同 blob。用 own-property 存在性保留 0、false、空字符串；拒绝歧义、多例外部引用、缺失或不保真的数值。旧 core 中调用移到专门参数模块是结构重排，不能仅凭旧行不在 core 就判断缺失。

**重点路径：** `src/core.mjs`、`src/openapi-scalar-values.mjs`、`src/openapi-query-arrays.mjs`

**代码锚点：** [src/openapi-scalar-values.mjs:11](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/openapi-scalar-values.mjs#L11)；[src/openapi-query-arrays.mjs:14](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/openapi-query-arrays.mjs#L14)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 226. `fix/openapi-scalar-path-serialization`

**结论：语义已整合或由后续实现替代。** SHA：[`0cb7f42f4eb4`](https://github.com/Hubujiu/local-api-workbench/tree/0cb7f42f4eb4ba49db60293eb4b001315dfe041a)；PR：[#60](https://github.com/Hubujiu/local-api-workbench/pull/60)。

**范围：** OpenAPI scalar path 的 simple/label/matrix 编码

实际审查比较基线 `88f70bb515c4`；比较增量：14 files changed, 997 insertions(+), 30 deletions(-)。原 main 领先 401 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40765839712)

**实际审查：**

已读完整 path-serialization 和 current runtime/core/dynamic/MCP/script URL 使用点。

**整合判断：** helper 与原分支同 blob。只承认完整 path segment 中带类型的参数，拒绝复合值和不安全点路径；simple、label、matrix 有不同标点/编码规则。服务相对 URL 被允许但不能把 // 作为新的 authority。旧 SDK 名称迁移到 canonical native 工具，回归并未消失。

**重点路径：** `src/core.mjs`、`src/dynamic-values.mjs`、`src/mcp-request-input.mjs`、`src/path-serialization.mjs`、`src/runtime.mjs`、`src/script-url-export.mjs`、`src/script-url-openapi.mjs`、`src/script-url-runtime.mjs`、`src/vendor/url-sdk-facade-manifest.json`

**代码锚点：** [src/path-serialization.mjs:10](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/path-serialization.mjs#L10)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 227. `fix/openapi-unsupported-trace`

**结论：语义已整合或由后续实现替代。** SHA：[`8e55115c47bb`](https://github.com/Hubujiu/local-api-workbench/tree/8e55115c47bb2839019970b625a29cad7f05a591)；PR：[#61](https://github.com/Hubujiu/local-api-workbench/pull/61)。

**范围：** OpenAPI TRACE 操作拒绝，避免静默丢失定义

实际审查比较基线 `88f70bb515c4`；比较增量：7 files changed, 407 insertions(+), 3 deletions(-)。原 main 领先 396 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40776063571)

**实际审查：**

已读 operation-admission、reference-context 与 import/sync 接线。

**整合判断：** 两个 helper 同 blob。先验证整份文档再开始导入/同步，发现不支持 TRACE 就拒绝而不是只跳过这个 operation；Paths 下 x-* 按扩展语义处理。此事在当前候选已完整集成。

**重点路径：** `src/core.mjs`、`src/mcp-openapi-sync.mjs`、`src/openapi-operation-admission.mjs`、`src/openapi-reference-context.mjs`

**代码锚点：** [src/openapi-operation-admission.mjs:9](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/openapi-operation-admission.mjs#L9)；[src/mcp-openapi-sync.mjs:41](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/mcp-openapi-sync.mjs#L41)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 228. `fix/ordinary-mock-condition-budget`

**结论：语义已整合或由后续实现替代。** SHA：[`d4a7e700d58b`](https://github.com/Hubujiu/local-api-workbench/tree/d4a7e700d58bfd7612cd48ee10dac4979a0a52e4)；PR：[#85](https://github.com/Hubujiu/local-api-workbench/pull/85)。

**范围：** 普通 Mock 条件的请求级总预算与不可观察对象拒绝

实际审查比较基线 `88f70bb515c4`；比较增量：4 files changed, 724 insertions(+), 6 deletions(-)。原 main 领先 398 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41592621005)

**实际审查：**

已读 mock-condition-budget 和 mock.mjs 补丁，验证缓存复用仍计费。

**整合判断：** 两个当前文件同 blob。单请求累计 1 MiB/100000 节点；读取不触发 getter/toJSON/proxy，不缓存可变对象；即使复用已解析 primitive，每次比较仍扣总预算。任一分支条件不能独立重置额度形成无界组合。

**重点路径：** `src/mock-condition-budget.mjs`、`src/mock.mjs`

**代码锚点：** [src/mock-condition-budget.mjs:6](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/mock-condition-budget.mjs#L6)；[src/mock.mjs:2](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/mock.mjs#L2)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 229. `fix/parameter-schema-source`

**结论：提交历史已纳入。** SHA：[`7209638aede4`](https://github.com/Hubujiu/local-api-workbench/tree/7209638aede4e5c114355b9dd9fd6dfb72342af3)；PR：[#169](https://github.com/Hubujiu/local-api-workbench/pull/169)。

**范围：** fix: isolate replaced Query-array and Header-object schema sources

实际审查比较基线 `8e00aa35e9ca`；比较增量：9 files changed, 955 insertions(+), 1 deletion(-)。原 main 领先 1164 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42982521828)

**实际审查：**

动态请求插值暂存有显式序列化标记的query array/header object schema，插值后还原。

schema examples/defaults是来源元数据不应执行旧变量；runtime value仍验证，其余普通schema/auth/assertion插值路径未改。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 230. `fix/plan-history-refresh-focus`

**结论：提交历史已纳入。** SHA：[`cfbacf067163`](https://github.com/Hubujiu/local-api-workbench/tree/cfbacf067163e94367f84bed86b73c0ef31bc66a)；PR：[#249](https://github.com/Hubujiu/local-api-workbench/pull/249)。

**范围：** 计划历史刷新后的焦点归属

实际审查比较基线 `b5e4899b27e3`；比较增量：11 files changed, 354 insertions(+), 11 deletions(-)。原 main 领先 1272 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43690047490)；[Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43686244023)

**实际审查：**

在替换 DOM 的瞬间捕获焦点而非发起 GET 时；只恢复原先位于记录区的焦点，期间移到外部编辑器则不抢回。

通过 DOM data ID 直接比较匹配记录/步骤/证据控件，避免把远端 ID 插入 CSS selector；无对应元素时回到已重新启用的 refresh 按钮。

request evidence 仅豁免同源精确 /api/mcp/config GET 轮询，不豁免 query 变体、跨源请求、任意读或写。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/plan-history-focus.js`、`public/app.js`、`public/plan-view.js`、`tests/plan-history-focus.test.mjs`、`tests/helpers/plan-history-focus-ui.mjs`、`tests/helpers/history-request-evidence.mjs`、`tests/history-request-evidence.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：处理当前已覆盖键盘焦点路径；本次未额外运行人工辅助技术/全部浏览器可访问性审查。

### 231. `fix/portable-package-integrity`

**结论：语义已整合或由后续实现替代。** SHA：[`6678ddc808a9`](https://github.com/Hubujiu/local-api-workbench/tree/6678ddc808a96917f25bee5f8b0dc91fb6cb7494)；PR：[#63](https://github.com/Hubujiu/local-api-workbench/pull/63)。

**范围：** 构建端完整 portable 包的文件/符号链接图与清单验证

实际审查比较基线 `88f70bb515c4`；比较增量：7 files changed, 623 insertions(+), 23 deletions(-)。原 main 领先 396 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40797886057)

**实际审查：**

已读 build-desktop、build-manifest、portable-integrity、verify-portable 完整补丁；核对相对链接、root escape、cycle、完整文件集和 manifest 自引用。

**整合判断：** 这四个 JS 文件与原分支同 blob。先 lstat 建立完整图，不遍历符号链接；限制深度/数量并解析每个相对目标，拒绝外逃、悬空、环及 manifest 目标。哈希使用解析后树内普通路径，打包前重新检查；CI Windows 隐藏文件纳入上传。另一个后续 Python 下载验包模块曾忽略不可遍历子树，主审查新增 af753d3 并发布到 59463aa 已修复；该发现不能归咎于本 PR 的 JS 遍历实现。

**重点路径：** `scripts/build-desktop.mjs`、`scripts/build-manifest.mjs`、`scripts/portable-integrity.mjs`、`scripts/verify-portable.mjs`

**代码锚点：** [scripts/portable-integrity.mjs:8](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/scripts/portable-integrity.mjs#L8)；[scripts/portable-integrity.mjs:140](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/scripts/portable-integrity.mjs#L140)

**发现/保留边界：**

**severity**：P2

**path**：scripts/verify_portable_download.py

**line**：140

**title**：关联的后续下载验包器曾忽略不可遍历额外子树（跨范围发现，已修）

**evidence**：父级 CI 审查复现：inventory_directory 默认 fail_on_walk_error=False；真实 os.walk 配 scandir PermissionError 可忽略含未登记 unexpected.exe 的子目录，使完整下载验证通过。该 Python 文件不是本 PR 原 JS 变更。

**reproduction**：主审查新增 test_unreadable_extra_subtree_cannot_pass_complete_download_verification，修复默认 True；主审查报告 71 个 Python 回归通过。子代理只复核补丁与同树标识，没有重复执行71项。

**status**：resolved

**resolution_commit**：af753d35032e8ece4a888146bf79512c54e691f9

**published_integrated_commit**：59463aa2dea720f1b817cf69720d4a0e76992002

**attribution**：parent/CI review

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：构建树要求静止；未把这些检查误称作敌对并发目录替换下的通用文件系统沙盒。未本机重打三平台安装包。

### 232. `fix/postgres-explicit-credentials`

**结论：提交历史已纳入。** SHA：[`9a99f763159e`](https://github.com/Hubujiu/local-api-workbench/tree/9a99f763159ed05f23e3bac46b714d51fe0a10c9)；PR：[#18](https://github.com/Hubujiu/local-api-workbench/pull/18)。

**范围：** PostgreSQL 请求显式 credentials 不被环境/pgpass 改写

实际审查比较基线 `88f70bb515c4`；比较增量：10 files changed, 612 insertions(+), 18 deletions(-)。原 main 领先 397 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40280356717)

**实际审查：**

已读 postgres-client、局部类型转换和读写接线，检查 options/replication 哨兵处理。

**整合判断：** 祖先已包含。连接采用明确 user/database/password 与受控 config，绕过 PG* 环境、pgpass 等隐式来源；不修改全局 process.env，因而不会跨项目污染并发调用。startup 参数 allowlist 和受限 constructor 哨兵在连接前移除；值类型解析使用局部配置。

**重点路径：** `src/database-sessions.mjs`、`src/postgres-client.mjs`、`src/postgres-values.mjs`、`src/postgres-write.mjs`、`src/remote-database.mjs`

**代码锚点：** [src/postgres-client.mjs:3](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/postgres-client.mjs#L3)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：不意味着自动继承本机 psql 凭据；正是显式请求边界的预期行为。

### 233. `fix/postgres-write-lifecycle`

**结论：提交历史已纳入。** SHA：[`6238c56456dd`](https://github.com/Hubujiu/local-api-workbench/tree/6238c56456dd3509c55487ed856ff8ff521015fb)；PR：[#34](https://github.com/Hubujiu/local-api-workbench/pull/34)。

**范围：** PostgreSQL 写入后实际本地 socket/SSH 关闭确认

实际审查比较基线 `9cde529a25c5`；比较增量：7 files changed, 708 insertions(+), 8 deletions(-)。原 main 领先 402 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40396463789)

**实际审查：**

已读 transport owner 与 finally 关闭等待的完整改动。

**整合判断：** 祖先已包含。应用持有 directSocket/SSH stream 的真实 close Promise，超时/失败会关闭自有资源；不再等待可能受远端 FIN 控制的 pg.end 才完成清理。COMMIT 已确认后的成功不因附属 shutdown 被错误降级。

**重点路径：** `src/postgres-write.mjs`

**代码锚点：** [src/postgres-write.mjs:26](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/postgres-write.mjs#L26)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 234. `fix/postman-event-script-import`

**结论：语义已整合或由后续实现替代。** SHA：[`24ab203d4269`](https://github.com/Hubujiu/local-api-workbench/tree/24ab203d42697f4bc3e981a5273f8b7344c61d6d)；PR：[#54](https://github.com/Hubujiu/local-api-workbench/pull/54)。

**范围：** Postman 层级 prerequest/test 事件导入的顺序及预算

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 731 insertions(+), 9 deletions(-)。原 main 领先 398 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40693186193)

**实际审查：**

已读 event-scripts helper 全补丁与递归导入挂接。

**整合判断：** helper 同 blob。collection/folder/request 从外到内保留事件序列，disabled 事件跳过；远端 script.src 不会隐式拉取或退回空脚本。每 phase 累计 100000 字符、已知字段与惰性数据验证防止不完整导入悄悄变换执行。

**重点路径：** `src/core.mjs`、`src/postman-event-scripts.mjs`

**代码锚点：** [src/postman-event-scripts.mjs:71](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/postman-event-scripts.mjs#L71)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 235. `fix/postman-path-variable-segments`

**结论：提交历史已纳入。** SHA：[`2e5c56c502b9`](https://github.com/Hubujiu/local-api-workbench/tree/2e5c56c502b9035f32a19fd4f547d96863b569d8)；PR：[#175](https://github.com/Hubujiu/local-api-workbench/pull/175)。

**范围：** fix: preserve complete Postman path variable identities

实际审查比较基线 `7aec51b68430`；比较增量：4 files changed, 531 insertions(+), 4 deletions(-)。原 main 领先 1172 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42997631190)

**实际审查：**

Postman path变量按完整segment和首点suffix解析，支持:user-id.json不误变:user。

相同enabled字符串重复可接受，disabled/不同值/非字符串歧义拒绝；raw URL优先及encoding策略不宣称完整SDK等价。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 236. `fix/postman-request-shorthand`

**结论：提交历史已纳入。** SHA：[`28c6590cdf93`](https://github.com/Hubujiu/local-api-workbench/tree/28c6590cdf930f7d0725b8df7b0e4e37f83c476f)；PR：[#47](https://github.com/Hubujiu/local-api-workbench/pull/47)。

**范围：** Postman 字符串请求与结构化 URL 的导入

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 825 insertions(+), 8 deletions(-)。原 main 领先 399 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40624163583)

**实际审查：**

已读 core 与完整 postman-url helper，检查 raw 优先、authority 边界、模板和 IPv6。

**整合判断：** 祖先已包含。字符串 request 明确转换为 url；存在 raw 时保持优先并区分 query/fragment。结构化 host/path 只接受可准确表达的值，嵌入 credentials、含糊 scheme/port、非法 IPv6 被拒绝；:path 变量只在路径转换，不误改 authority。

**重点路径：** `src/core.mjs`、`src/postman-url.mjs`

**代码锚点：** [src/postman-url.mjs:65](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/postman-url.mjs#L65)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 237. `fix/postman-response-example-headers`

**结论：语义已整合或由后续实现替代。** SHA：[`8463f0227cef`](https://github.com/Hubujiu/local-api-workbench/tree/8463f0227cef4efb2676f6c23be56bbe160d1f1e)；PR：[#66](https://github.com/Hubujiu/local-api-workbench/pull/66)。

**范围：** Postman response examples 的响应头和实体保留

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 623 insertions(+), 5 deletions(-)。原 main 领先 396 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40854500504)

**实际审查：**

已读 response-examples helper 的完整补丁。

**整合判断：** helper 同 blob。保留启用头行和 media type，大小写相同的重复头不悄悄合并；body/status/headers 类型检查有界，1000 例/8 MiB 限额仍在，不能用伪造文本代替不支持二进制例子。

**重点路径：** `src/core.mjs`、`src/postman-response-examples.mjs`

**代码锚点：** [src/postman-response-examples.mjs:33](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/postman-response-examples.mjs#L33)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 238. `fix/preserve-native-request-lifecycle-ui`

**结论：提交历史已纳入。** SHA：[`80cb576cfac8`](https://github.com/Hubujiu/local-api-workbench/tree/80cb576cfac865a17d471267837f2abdb72027aa)；PR：[#209](https://github.com/Hubujiu/local-api-workbench/pull/209)。

**范围：** fix(ui): preserve native request lifecycle and drafts across reloads

实际审查比较基线 `c402ce3e1d69`；比较增量：3 files changed, 751 insertions(+), 4 deletions(-)。原 main 领先 1215 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43147844278)

**实际审查：**

原生继承项目GUI回收/恢复接上带configRevision的专用原子命令，目录成员恢复须明确确认整批，旧普通保存仍不能伪造身份变动。

异步保存后重新检查范围；pending双击/普通save阻断，丢响应或新草稿到达只保留草稿并要求新GET对账，不自动重发。openProject用generation/序号/编辑版本阻止旧GET覆盖。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 239. `fix/project-archive-grant-atomicity`

**结论：语义已整合或由后续实现替代。** SHA：[`faf6a660d7e7`](https://github.com/Hubujiu/local-api-workbench/tree/faf6a660d7e7b66990200b135119bf2dd12a2117)；PR：[#64](https://github.com/Hubujiu/local-api-workbench/pull/64)。

**范围：** 项目归档保存和 MCP 授权撤销的原子结果

实际审查比较基线 `82336c421e97`；比较增量：5 files changed, 595 insertions(+), 3 deletions(-)。原 main 领先 403 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40809675929)

**实际审查：**

已读 helper 与当前 archive/persist 队列路径，区分明确拒绝、成功和 typed uncertain。

**整合判断：** project-archive-grants helper 同 blob。只有归档已提交或此项目提交结果不确定时才撤销授权；确定的写前拒绝不误撤销。typed 原始错误保留。后续 MCP publication 把多个活跃数组原位撤销并排队保存，是加强该修复，非遗漏。

**重点路径：** `src/project-archive-grants.mjs`、`src/server.mjs`

**代码锚点：** [src/project-archive-grants.mjs:5](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/project-archive-grants.mjs#L5)；[src/server.mjs:66](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/server.mjs#L66)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 240. `fix/project-commit-outcomes`

**结论：业务已整合，本轮补回SDK回归。** SHA：[`621122a2c91b`](https://github.com/Hubujiu/local-api-workbench/tree/621122a2c91ba28512555835b6d6ac08bc0bff52)；PR：[#17](https://github.com/Hubujiu/local-api-workbench/pull/17)。

**范围：** 项目创建/更新/恢复的提交结果和 required-file 缺失保护

实际审查比较基线 `88f70bb515c4`；比较增量：19 files changed, 3216 insertions(+), 91 deletions(-)。原 main 领先 410 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41765903066)

**实际审查：**

已读 783 行生产补丁，检查 project-files journal、durable creation intent、registry/file 锁、显式 restore 和 optimistic revisions；实际补跑遗漏的 SDK 回归。

**整合判断：** 产品语义已集成：更新缺文件不能变成创建，恢复必须新 identity，持久化发布后的异常返回 PROJECT_COMMIT_UNCERTAIN，不允许自动重放。真正遗漏的是末端两份官方 SDK HTTP/stdio 恢复回归。已仅复制测试并按当前“restore 摘要/export 完整历史”和“拒绝授权损坏归档项目”边界更新断言，858d562 上 4/4 通过；主审查 cherry-pick a41ec83，已发布在 59463aa 同树。不要 merge 整条旧分支。

**重点路径：** `src/core.mjs`、`src/mcp.mjs`、`src/project-commit-outcome.mjs`、`src/project-files.mjs`、`src/runtime.mjs`、`src/server.mjs`、`tests/project-missing-file-sdk.test.mjs`

**代码锚点：** [src/project-commit-outcome.mjs:2](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/project-commit-outcome.mjs#L2)；[src/project-files.mjs:236](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/project-files.mjs#L236)；[src/runtime.mjs:965](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/runtime.mjs#L965)；[tests/project-missing-file-sdk.test.mjs:478](https://github.com/Hubujiu/local-api-workbench/blob/59463aa2dea720f1b817cf69720d4a0e76992002/tests/project-missing-file-sdk.test.mjs#L478)；[tests/fixtures/mcp-missing-file-save-gate.mjs:1](https://github.com/Hubujiu/local-api-workbench/blob/59463aa2dea720f1b817cf69720d4a0e76992002/tests/fixtures/mcp-missing-file-save-gate.mjs#L1)

**发现/保留边界：**

**severity**：P2

**path**：tests/project-missing-file-sdk.test.mjs

**line**：1

**title**：原候选缺失官方 MCP SDK HTTP/stdio required-file 恢复回归

**evidence**：候选 2532d67 中该文件与 tests/fixtures/mcp-missing-file-save-gate.mjs 均不存在；PR17 头 621122a 保留。已有 HTTP 测试直接 createMCP，不能覆盖官方 transport+重启授权/恢复路径。

**reproduction**：只恢复两文件，按当前 restore summary/export 完整对象与 archived-project grant 拒绝规则调整断言；node --test tests/project-missing-file-sdk.test.mjs：4/4 通过、0 skip、0 fail。

**status**：resolved

**resolution_commit**：858d562c50df0b9e492bc7e7169b11ad383822a3

**integrated_local_commit**：a41ec83

**published_integrated_commit**：59463aa2dea720f1b817cf69720d4a0e76992002

**验证及限制：**

**this_review_execution**：**command**：node --test tests/project-missing-file-sdk.test.mjs

**working_tree_commit**：858d562c50df0b9e492bc7e7169b11ad383822a3

**base_commit**：2532d67136fbc89000ecaf079f826ed229600e86

**environment**：Node v24.22.1, Linux x64

**tests**：4

**pass**：4

**fail**：0

**skipped**：0

**duration_ms**：5674.970127

**evidence_file**：storage-sdk-regression-final.tap

**reuse_note**：同一组真实SDK补强场景覆盖三条关联历史；不计为每条分支各自重新运行。

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：只实跑缺失回归的四种组合；未重演全部断电情景。原测试 4 失败与中间版本 2 失败日志均保留，失败来自当前 API 合约变化，不掩盖为原测试直接通过。

### 241. `fix/project-draft-save-recovery-20261112`

**结论：提交历史已纳入。** SHA：[`ae093e5a9770`](https://github.com/Hubujiu/local-api-workbench/tree/ae093e5a9770b4b442d0aec9655742aaae952814)；PR：[#221](https://github.com/Hubujiu/local-api-workbench/pull/221)。

**范围：** 草稿保存回执、冲突恢复与安全回滚

实际审查比较基线 `90683f02c8eb`；比较增量：11 files changed, 859 insertions(+), 31 deletions(-)。原 main 领先 1232 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43274799487)

**实际审查：**

save 捕获 owner/snapshot/editVersion；有效回执需 project ID、递增 revision/configRevision、disk fingerprint 及必需集合字段一致。

保存期间出现新编辑时只推进版本/运行记录元数据，保留新草稿；同 ID 新对象不归旧回执所有。

服务器为 owner PUT 标注 not_committed 或 unknown；客户端只为明确 not_committed 且 owner/version 一致的回执开放局部回滚。

unknown 或无效回执保留草稿并要求显式重读；重读 checkpoint 不允许旧 GET 消除后来写入的不确定性；所有错误均不暗示 retry_safe。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/app.js`、`public/project-import-guard.js`、`src/owner-project-put-outcome.mjs`、`src/server.mjs`、`tests/project-draft-save-ui.test.mjs`、`tests/owner-project-put-outcome.test.mjs`、`tests/helpers/project-draft-save-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：not_committed 仅说明项目提交边界，不证明此前任何业务动作均无副作用；客户端无自动重试。

### 242. `fix/project-export-query-contract`

**结论：提交历史已纳入。** SHA：[`4fb12a92b086`](https://github.com/Hubujiu/local-api-workbench/tree/4fb12a92b0860b48dbb941f56e5979cd98c74d05)；PR：[#177](https://github.com/Hubujiu/local-api-workbench/pull/177)。

**范围：** fix: reject ambiguous project export query options

实际审查比较基线 `b0bb23ab64be`；比较增量：3 files changed, 262 insertions(+), 16 deletions(-)。原 main 领先 1175 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43007450326)

**实际审查：**

项目导出严格识别format/modelNameMode/databaseMode，未知/重复query与无效format拒绝。

防拼错format悄然导出完整备份；owner认证先于校验，backup/native保留合法别名，固定错误不回显敏感参数。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 243. `fix/protocol-draft-unload-guard`

**结论：提交历史已纳入。** SHA：[`85a0b717ab52`](https://github.com/Hubujiu/local-api-workbench/tree/85a0b717ab522707f28af872762290d4416464a7)；PR：[#241](https://github.com/Hubujiu/local-api-workbench/pull/241)。

**范围：** 协议定义未保存草稿的关闭/刷新保护

实际审查比较基线 `c1048acd527c`；比较增量：6 files changed, 281 insertions(+), 1 deletion(-)。原 main 领先 1263 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43495526798)

**实际审查：**

beforeunload 保留普通 dirty 并添加当前项目 gRPC/Socket.IO definition draftDirty；不同项目缓存不能错误触发。

Socket.IO 无效 raw events JSON 仍被视为草稿；仅临时 metadata/auth 变化不当作可保存定义。

handler 只阻止卸载，不主动保存、重发或变更草稿；保存/明确丢弃定义后解除。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/app.js`、`tests/protocol-draft-unload.test.mjs`、`tests/protocol-draft-unload-ui.test.mjs`、`tests/helpers/protocol-draft-unload-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：浏览器/桌面关闭提示受宿主行为影响；真实 Electron 关闭取消的特定覆盖由 #244 补充。

### 244. `fix/protocol-elapsed-clocks`

**结论：语义已整合或由后续实现替代。** SHA：[`97651ea4495e`](https://github.com/Hubujiu/local-api-workbench/tree/97651ea4495e9ab94536456a51caa57681f43b1d)；PR：[#77](https://github.com/Hubujiu/local-api-workbench/pull/77)。

**范围：** gRPC reflection 总时限及 Socket.IO acknowledgement TTL

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 312 insertions(+), 7 deletions(-)。原 main 领先 396 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41228334327)

**实际审查：**

已读 reflection/socketio elapsed 替换补丁和当前剩余 deadline 计算。

**整合判断：** grpc-reflection 同 blob，Socket.IO 后续扩展仍保留 monotonicNow。reflection 每一子 RPC 只得到总时限剩余时间；ackTTL 与清理不受系统时钟调整续期。

**重点路径：** `src/grpc-reflection.mjs`、`src/socketio.mjs`

**代码锚点：** [src/grpc-reflection.mjs:9](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/grpc-reflection.mjs#L9)；[src/socketio.mjs:11](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/socketio.mjs#L11)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 245. `fix/protocol-extract-atomic`

**结论：提交历史已纳入。** SHA：[`c9b902ecde84`](https://github.com/Hubujiu/local-api-workbench/tree/c9b902ecde8448da1b344de9cdfdf530f1763d4b)；PR：[#41](https://github.com/Hubujiu/local-api-workbench/pull/41)。

**范围：** 协议流提取与变量持久化的原子发布

实际审查比较基线 `7c5afb162c68`；比较增量：3 files changed, 743 insertions(+), 7 deletions(-)。原 main 领先 406 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40495941454)

**实际审查：**

已读 core 的协议 extraction staging、scope commit、取消分支。

**整合判断：** 祖先已含。先在 detached nextScopes/extracted 构建批量变更并完成持久化，失败不部分发布；typed 提交不确定结果带 retrySafe:false。取消发生在已经确认的存储边界之后时，确认后的整批写入仍是事实，不伪称回滚。

**重点路径：** `src/core.mjs`

**代码锚点：** [src/core.mjs:1338](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/core.mjs#L1338)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 246. `fix/quickjs-heap-accounting`

**结论：提交历史已纳入。** SHA：[`355bf9a2c687`](https://github.com/Hubujiu/local-api-workbench/tree/355bf9a2c68766a56769ba5359922dbff9432f5b)；PR：[#36](https://github.com/Hubujiu/local-api-workbench/pull/36)。

**范围：** QuickJS Emscripten 堆计量修复与固定构建输入

实际审查比较基线 `88f70bb515c4`；比较增量：7 files changed, 9534 insertions(+), 9059 deletions(-)。原 main 领先 397 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40434252890)

**实际审查：**

已读 build-quickjs 改动和 25 行 heap-accounting C patch；核对 wasm/manifest 为生成产物。

**整合判断：** 祖先已含。修正 Emscripten 条件和 malloc_usable_size 计量，避免 guest 实际分配未被 runtime 限额扣除。构建固定源码、补丁和修改路径集合；不能再用旧 wasm 覆盖当前已修补资产。

**重点路径：** `scripts/build-quickjs.mjs`、`src/vendor/quickjs-tracked/heap-accounting.patch`、`src/vendor/quickjs-tracked/manifest.json`

**代码锚点：** [src/vendor/quickjs-tracked/heap-accounting.patch:10](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/vendor/quickjs-tracked/heap-accounting.patch#L10)；[scripts/build-quickjs.mjs:22](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/scripts/build-quickjs.mjs#L22)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：二进制本体未逐字反编译，也未重新编译 engine；源码补丁和固定构建链已审，跨平台构建/CI 证据由主报告统一归档。

### 247. `fix/quickjs-regexp-interrupt`

**结论：提交历史已纳入。** SHA：[`05c8f5834285`](https://github.com/Hubujiu/local-api-workbench/tree/05c8f5834285b0dce866f4b8703fc4d7ba63c94e)；PR：[#38](https://github.com/Hubujiu/local-api-workbench/pull/38)。

**范围：** QuickJS 正则中断和 Unicode 编译 OOM 清理

实际审查比较基线 `355bf9a2c687`；比较增量：11 files changed, 10156 insertions(+), 9095 deletions(-)。原 main 领先 401 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40443229089)

**实际审查：**

已读 build-quickjs、219 行 regexp-interrupt C patch 和 Unicode 清理补丁。

**整合判断：** 祖先已含。正则匹配/回溯循环定期轮询中断，TIMEOUT 与普通 OOM 的返回值分开并传为不可捕获中断；失败路径做资源清理。Unicode 编译失败路径改为释放后 return -1，避免再次进入 fail 标签重复清理。与实验 bytecode 分支的未解 parser assertion 是不同层次，不能由这两项修补推断实验安全。

**重点路径：** `scripts/build-quickjs.mjs`、`src/vendor/quickjs-tracked/manifest.json`、`src/vendor/quickjs-tracked/regexp-interrupt.patch`、`src/vendor/quickjs-tracked/unicode-script-oom.patch`

**代码锚点：** [src/vendor/quickjs-tracked/regexp-interrupt.patch:32](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/vendor/quickjs-tracked/regexp-interrupt.patch#L32)；[src/vendor/quickjs-tracked/unicode-script-oom.patch:9](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/vendor/quickjs-tracked/unicode-script-oom.patch#L9)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：未重编译 engine 或单独重跑极端 OOM；本次为源补丁与候选资产/测试存在性的核对。

### 248. `fix/read-database-cancellation`

**结论：补丁等价已纳入。** SHA：[`19f7833eb376`](https://github.com/Hubujiu/local-api-workbench/tree/19f7833eb3764818a527a0b011b837e43639d96f)；PR：[#24](https://github.com/Hubujiu/local-api-workbench/pull/24)。

**范围：** 只读数据库操作的调用者取消和真实传输关闭边界

实际审查比较基线 `295cccb5b9ab`；比较增量：13 files changed, 1360 insertions(+), 77 deletions(-)。原 main 领先 413 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41229533124)

**实际审查：**

已读 696 行跨 SQLite/ClickHouse/Redis/PostgreSQL/MySQL/SSH 生产补丁及当前 owner 组合。

**整合判断：** 分支非祖先但独有提交全部 patch 等价；源码和 tests 也确认保留。SQLite read 使用独立子进程 SIGKILL 并等 close；socket/tunnel 由本调用持有并在关闭完成后结算，不通过取消 Promise 遗弃仍运行资源。写操作保留自己的“提交未知”契约，不强套读取取消。MCP grant 不因本次调用取消而被全局删除。

**重点路径：** `src/clickhouse.mjs`、`src/database-process.mjs`、`src/database-read-cancellation.mjs`、`src/database-sessions.mjs`、`src/database-ssh.mjs`、`src/database.mjs`、`src/redis.mjs`、`src/remote-database.mjs`、`src/server.mjs`

**代码锚点：** [src/database-read-cancellation.mjs:11](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/database-read-cancellation.mjs#L11)；[src/database-process.mjs:17](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/database-process.mjs#L17)；[src/remote-database.mjs:54](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/remote-database.mjs#L54)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：原分支没有为 MongoDB 添加 signal 取消支持，不能称所有数据库同等支持；当前产品对 Mongo 的具体限制由相应功能范围约束。

### 249. `fix/recoverable-protocol-intents-20261112`

**结论：提交历史已纳入。** SHA：[`1e877c711967`](https://github.com/Hubujiu/local-api-workbench/tree/1e877c7119679b823099e0b3dd48e912362f91c7)；PR：[#226](https://github.com/Hubujiu/local-api-workbench/pull/226)。

**范围：** TCP/WebSocket/SSE 启动意图恢复

实际审查比较基线 `c8c1b4d7d148`；比较增量：9 files changed, 1648 insertions(+), 58 deletions(-)。原 main 领先 1236 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43290522650)

**实际审查：**

控制器将 instanceId/intentId/sessionId/type/phase 持久化；回执严格匹配实例、intent、session 身份以及 retry_safe=false。

读取可保留 uncertain-send 等状态；恢复不自动重连或重发，停止是独立可执行恢复动作。

终态 expired/cancelled 关闭本机 intent，但不清除未知远端发送语义；pending/polling 用 generation 隔离晚到响应。

该入口合同只涵盖 tcp/websocket/sse，未推广到后续 Socket.IO/gRPC 独立工作台。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/protocol-session-controller.js`、`src/protocol-session-intents.mjs`、`src/protocol-sessions.mjs`、`public/app.js`、`src/server.mjs`、`tests/protocol-session-intents.test.mjs`、`tests/protocol-session-ui-lifecycle.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：复用主审查者对 server intents 的深入审阅；本补充核对前端实际接线和 receipt 验证。单实例单 intent 至多一次启动尝试不等于远端业务 exactly-once。

### 250. `fix/redis-auth-unicode-fidelity`

**结论：提交历史已纳入。** SHA：[`ed3c4d8428c7`](https://github.com/Hubujiu/local-api-workbench/tree/ed3c4d8428c7cea1fcbd46a11d5f85fd8697e902)；PR：[#190](https://github.com/Hubujiu/local-api-workbench/pull/190)。

**范围：** fix: reject malformed Redis AUTH Unicode before transport

实际审查比较基线 `4914962b180b`；比较增量：3 files changed, 181 insertions(+), 1 deletion(-)。原 main 领先 1193 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43059471237)

**实际审查：**

Redis AUTH user/password新增Unicode合法性检验，先于direct/TLS/SSH与写入授权消耗。

保持字节限额和空/省略语义，合法Unicode实际AUTH字节不改变。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 251. `fix/redis-read-argument-fidelity`

**结论：提交历史已纳入。** SHA：[`4914962b180b`](https://github.com/Hubujiu/local-api-workbench/tree/4914962b180bf87f43321235c21ce8f3f0e48bb4)；PR：[#189](https://github.com/Hubujiu/local-api-workbench/pull/189)。

**范围：** fix: reject lossy Redis read command arguments

实际审查比较基线 `bb5e58df2805`；比较增量：3 files changed, 155 insertions(+), 1 deletion(-)。原 main 领先 1192 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43058482014)

**实际审查：**

Redis read参数在字符串Unicode及数字有限/安全整数上fail-closed。

write仍string-only，read允许有限小数/安全整数；native任务normalization也继承相同门禁，错误输入不连接。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 252. `fix/redis-write-lifecycle`

**结论：语义已整合或由后续实现替代。** SHA：[`cc917637a6e7`](https://github.com/Hubujiu/local-api-workbench/tree/cc917637a6e7640f5ba5ec1b56919da74babb6c3)；PR：[#71](https://github.com/Hubujiu/local-api-workbench/pull/71)。

**范围：** Redis 写入分派前后取消、unknown outcome 与传输清理

实际审查比较基线 `5e78cf27d561`；比较增量：5 files changed, 639 insertions(+), 3 deletions(-)。原 main 领先 403 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41586418220)

**实际审查：**

已读原 30 行补丁和当前 redis 执行主链 220–440 行。

**整合判断：** 原分支“所有 SSH 都拒绝”后来被明确、校验主机指纹的 SSH 功能替代，不应回退当前特性。原修复的真实 close 等待、writeSent 后结果不确定、无自动重试仍保留；现在 TLS/socket 和 SSH channel/client 都有自己的清理所有者。

**重点路径：** `src/redis.mjs`

**代码锚点：** [src/redis.mjs:277](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/redis.mjs#L277)；[src/redis.mjs:6](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/redis.mjs#L6)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：不能只看旧拒绝语句消失就判断 unsafe direct fallback；已追踪当前传输分派。

### 253. `fix/reject-unknown-plan-steps`

**结论：语义已整合或由后续实现替代。** SHA：[`35ee36470938`](https://github.com/Hubujiu/local-api-workbench/tree/35ee364709386fc69bf47bd4df6521ffa5e6972e)；PR：[#88](https://github.com/Hubujiu/local-api-workbench/pull/88)。

**范围：** 计划未知 discriminator 拒绝与可保留旧磁盘记录

实际审查比较基线 `88f70bb515c4`；比较增量：7 files changed, 613 insertions(+), 1 deletion(-)。原 main 领先 401 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41599397153)

**实际审查：**

已读 plan-step-types 当前实现和旧补丁、sameStoredPlan 判定；核对 repeat/if 的后续合法扩展。

**整合判断：** 原修复按语义集成。拒绝未知 type、访问器、Proxy、稀疏数组及超界递归；合法 repeat/if 来自随后明确新增支持，不是放宽任意步骤。旧磁盘 opaque 计划仅可在有界全值相等时随项目原样保留，不能借 stale save 重写未知结构。

**重点路径：** `scripts/run-plan.mjs`、`src/core.mjs`、`src/plan-step-types.mjs`、`src/plan-version.mjs`、`src/runtime.mjs`

**代码锚点：** [src/plan-step-types.mjs:9](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/plan-step-types.mjs#L9)；[src/plan-step-types.mjs:117](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/plan-step-types.mjs#L117)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 254. `fix/run-service-context`

**结论：提交历史已纳入。** SHA：[`a6e62ee34237`](https://github.com/Hubujiu/local-api-workbench/tree/a6e62ee34237ab8032995a37cececef3a0d353d4)；PR：[#46](https://github.com/Hubujiu/local-api-workbench/pull/46)。

**范围：** 运行期间服务地址绑定与变量写入刷新隔离

实际审查比较基线 `88f70bb515c4`；比较增量：7 files changed, 622 insertions(+), 13 deletions(-)。原 main 领先 396 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40595195067)

**实际审查：**

已读 createServiceRequestResolver 和 HTTP/MCP/CLI 调用变更。

**整合判断：** 祖先已含。开始执行时复制选中环境的 serverUrls、server IDs 与 folderServices，scope commit 刷新 project 对象不会让同一计划下一步突然换路由；变量仍按原执行语义更新，不把整个项目或变量状态盲目冻结。

**重点路径：** `scripts/run-plan.mjs`、`src/environments.mjs`、`src/mcp.mjs`、`src/server.mjs`

**代码锚点：** [src/environments.mjs:121](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/environments.mjs#L121)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 255. `fix/runtime-row-scope-failstop-20261106`

**结论：提交历史已纳入。** SHA：[`99abb63588c9`](https://github.com/Hubujiu/local-api-workbench/tree/99abb63588c904e9bb243dca7c7456d61f0a88c9)；PR：[#143](https://github.com/Hubujiu/local-api-workbench/pull/143)。

**范围：** fix: stop runtime-row plans on uncertain protocol scope commits

实际审查比较基线 `817d071b21ac`；比较增量：2 files changed, 225 insertions(+)。原 main 领先 1130 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42137321248)

**实际审查：**

runtimeRows加入协议scope提交未知错误code识别，确保producer完成后的不确定证据不继续驱动消费者。

同时接受真实异常类型和固定code；record保存/重启保留证据，不暴露私有异常；未启用rows的legacy行为保持。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 256. `fix/script-sequence-budgets`

**结论：提交历史已纳入。** SHA：[`d28127c0a88f`](https://github.com/Hubujiu/local-api-workbench/tree/d28127c0a88fae15cdf7dc45c6fed7a5da25187a)；PR：[#3](https://github.com/Hubujiu/local-api-workbench/pull/3)。

**范围：** 多阶段脚本共享额度、尾部计费和有界 bootstrap/CPU 诊断

实际审查比较基线 `88f70bb515c4`；比较增量：17 files changed, 1020 insertions(+), 45 deletions(-)。原 main 领先 406 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41227363946)

**实际审查：**

已读全 474 行生产补丁，核对 scriptBudgets、sequence remaining、monotonic worker deadline 和诊断 allowlist。

**整合判断：** 祖先已含。单脚本与序列共用 options 验证，不再把 sequence 默认常量覆盖调用者明确预算；每阶段扣耗时/请求/计时器/faker/jobs/assertions 总额度。最终 JSON parse/serialization 尾部也计费，超额结果不能成功发布。CPU/阶段观察只作为失败诊断，不反过来控制准入或延长预算。

**重点路径：** `src/script-bootstrap-diagnostics.mjs`、`src/script-compatibility.mjs`、`src/script-diagnostics.mjs`、`src/script-worker.mjs`、`src/scripts.mjs`

**代码锚点：** [src/scripts.mjs:67](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/scripts.mjs#L67)；[src/script-worker.mjs:1023](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/script-worker.mjs#L1023)；[src/script-bootstrap-diagnostics.mjs:32](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/script-bootstrap-diagnostics.mjs#L32)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 257. `fix/socketio-safe-errors-20261106`

**结论：提交历史已纳入。** SHA：[`cd7f96497890`](https://github.com/Hubujiu/local-api-workbench/tree/cd7f9649789022d5bc58823b5bafea3a41cdcfea)；PR：[#149](https://github.com/Hubujiu/local-api-workbench/pull/149)。

**范围：** fix: prevent Socket.IO peer diagnostic retention

实际审查比较基线 `759892a650a1`；比较增量：8 files changed, 465 insertions(+), 52 deletions(-)。原 main 领先 1138 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42154279085)

**实际审查：**

Socket.IO持久错误只取本地WeakMap来源或固定类别/errno映射，远端message/description/cause不直接串入历史、MCP或CLI。

握手、polling及预算拒绝使用本地受信错误；远端仿造本地文字只能映为固定诊断，事件和ACK仍是显式应用数据。真实owner/MCP/CLI/重开Store测试检查私密sentinel不入错误。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 258. `fix/sql-unicode-fidelity`

**结论：提交历史已纳入。** SHA：[`0074631108be`](https://github.com/Hubujiu/local-api-workbench/tree/0074631108be4a6a87bdb077aa433f119fd2ae43)；PR：[#192](https://github.com/Hubujiu/local-api-workbench/pull/192)。

**范围：** fix: reject malformed SQL Unicode before database execution

实际审查比较基线 `502628ee1bab`；比较增量：10 files changed, 227 insertions(+), 2 deletions(-)。原 main 领先 1195 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43065515102)

**实际审查：**

SQLite/PG/MySQL SQL以及plan binding/native任务统一拒绝失真Unicode，避免替换字符改变执行语义。

关键入口在fork/Worker/slot前校验；没有trim/规范化合法SQL，写入/查询既有子集不扩大。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 259. `fix/sqlite-filename-fidelity`

**结论：提交历史已纳入。** SHA：[`bea505026a7b`](https://github.com/Hubujiu/local-api-workbench/tree/bea505026a7be843bbd77c12709f7b9299c3ee45)；PR：[#199](https://github.com/Hubujiu/local-api-workbench/pull/199)。

**范围：** fix: reject malformed SQLite filenames before selecting a file

实际审查比较基线 `eb60367347d6`；比较增量：8 files changed, 183 insertions(+), 6 deletions(-)。原 main 领先 1203 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43078271620)

**实际审查：**

SQLite filename统一纯校验，在读/写/会话注册/进程前拒绝失真Unicode。

避免孤立代理项实际打开U+FFFD同名文件；合法Unicode路径保持，写入失败不顺带创建新文件策略继续保留。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 260. `fix/sqlite-process-diagnostics`

**结论：补丁等价已纳入。** SHA：[`72f27d678de0`](https://github.com/Hubujiu/local-api-workbench/tree/72f27d678de00ae11e917ad36a5585de77db6023)；PR：[#15](https://github.com/Hubujiu/local-api-workbench/pull/15)。

**范围：** SQLite 进程/worker/操作阶段的有界诊断

实际审查比较基线 `5e1354b1b5a4`；比较增量：15 files changed, 1813 insertions(+), 101 deletions(-)。原 main 领先 411 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41441664838)

**实际审查：**

已读 660 行生产补丁及当前 tracker/helper，区分 sqlite-stage、operation-stage 与 result envelope。

**整合判断：** 独有提交全 patch 等价，独立 worker/entry/progress/diagnostics 模块同 blob。只有合法结果 envelope 加上正常进程关闭才算成功；诊断丢包、乱序、耗尽或 IPC 失败不会替换执行结果。阶段图最多 16 条、只允许前进子序列，写入失败仍保持 SQLITE_WRITE_OUTCOME_UNKNOWN；公开数据仅白名单代码、阶段、数值，不含 SQL/路径/任意异常对象。

**重点路径：** `src/database-execution-worker.mjs`、`src/database-process-entry.mjs`、`src/database-process.mjs`、`src/database.mjs`、`src/server.mjs`、`src/sqlite-operation-progress.mjs`、`src/sqlite-process-diagnostics.mjs`

**代码锚点：** [src/sqlite-operation-progress.mjs:4](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/sqlite-operation-progress.mjs#L4)；[src/database-process-entry.mjs:79](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/database-process-entry.mjs#L79)；[src/sqlite-process-diagnostics.mjs:60](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/sqlite-process-diagnostics.mjs#L60)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 261. `fix/sqlite-ssh-dispatch-boundary`

**结论：语义已整合或由后续实现替代。** SHA：[`8457f020f550`](https://github.com/Hubujiu/local-api-workbench/tree/8457f020f550a00f3621fcc45e34637e8d1d1c93)；PR：[#84](https://github.com/Hubujiu/local-api-workbench/pull/84)。

**范围：** SQLite owner API 对 unsupported SSH 的前置拒绝

实际审查比较基线 `88f70bb515c4`；比较增量：3 files changed, 239 insertions(+)。原 main 领先 397 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41587420145)

**实际审查：**

已读完整 server guard 补丁和当前 dispatch 顺序。

**整合判断：** 非祖先变化已在当前分派入口保留：默认 type 或 sqlite 且 ssh 非 undefined 时，读写分支前就拒绝。不会把用户要求的 SSH 操作误解释为本机 SQLite 路径操作。

**重点路径：** `src/server.mjs`

**代码锚点：** [src/server.mjs:2136](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/server.mjs#L2136)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 262. `fix/structured-plan-editor`

**结论：提交历史已纳入。** SHA：[`12092b83b662`](https://github.com/Hubujiu/local-api-workbench/tree/12092b83b662631fe3b9801c5194ee036a87c244)；PR：[#217](https://github.com/Hubujiu/local-api-workbench/pull/217)。

**范围：** 结构化计划步骤显示和类型安全编辑

实际审查比较基线 `41ca841a836a`；比较增量：8 files changed, 471 insertions(+), 30 deletions(-)。原 main 领先 1226 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43194983394)

**实际审查：**

HTTP 步骤明确识别 request 对象；repeat/if/grpc/socketio/protocol 使用独立摘要，未知类型保留原始定义。

单步 JSON 编辑限制 4 MiB 且要求保留原 id/type，避免把控制节点误当 HTTP 请求或静默丢失嵌套结构。

视图与 step-editor 按类型选择入口，最终 graph admission 仍由服务端负责。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `public/plan-step-types.js`、`public/plan-view.js`、`public/step-editor.js`、`tests/plan-structure-editor.test.mjs`、`tests/helpers/plan-structure-ui.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：UI 只支持明确列出的结构化字段；完整 JSON 编辑和服务端验证仍是未知/高级结构的必要边界。

### 263. `fix/swagger2-request-body-import`

**结论：语义已整合或由后续实现替代。** SHA：[`00459cd60aaf`](https://github.com/Hubujiu/local-api-workbench/tree/00459cd60aaf9f3e0702f0b7b36338c7eaf2052d)；PR：[#55](https://github.com/Hubujiu/local-api-workbench/pull/55)。

**范围：** Swagger 2 body/formData/consumes 到 OpenAPI body 的保真导入

实际审查比较基线 `88f70bb515c4`；比较增量：8 files changed, 1759 insertions(+), 41 deletions(-)。原 main 领先 400 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40702399516)

**实际审查：**

已读完整 swagger2-request-body 当前 helper、原补丁和 openapi-body 接口。

**整合判断：** helper 与原分支同 blob。body 与 formData 互斥，参数按 in/name 合并并遵守 operation 覆盖；空 consumes 不偷用默认值。JSON schema 保守转换，文件只在显式 multipart 承认，表单/媒体类型/字段名无法保真就拒绝。转换后用现有 body importer 预检，没有另一套隐式下载或编码路径。

**重点路径：** `src/core.mjs`、`src/openapi-body.mjs`、`src/swagger2-request-body.mjs`

**代码锚点：** [src/swagger2-request-body.mjs:64](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/swagger2-request-body.mjs#L64)；[src/swagger2-request-body.mjs:1](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/swagger2-request-body.mjs#L1)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 264. `fix/swagger2-security-definitions`

**结论：语义已整合或由后续实现替代。** SHA：[`94ceaf3839b5`](https://github.com/Hubujiu/local-api-workbench/tree/94ceaf3839b5fa3b78a561d4f5c4e94e7d53f386)；PR：[#59](https://github.com/Hubujiu/local-api-workbench/pull/59)。

**范围：** Swagger 2 securityDefinitions 的定义级转换

实际审查比较基线 `88f70bb515c4`；比较增量：5 files changed, 1224 insertions(+), 5 deletions(-)。原 main 领先 397 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40759455165)

**实际审查：**

已读完整 swagger2-security helper、security requirement 遍历及 core 接线。

**整合判断：** helper 与原分支同 blob。basic/apiKey/oauth2 各 flow 转成 OAS3 securitySchemes，必需 URL/scopes 严格验证；混用 registries 时只接受同义定义，检查 root/operation security 引用，不装入运行凭据也不抓取远端授权资源。

**重点路径：** `src/core.mjs`、`src/swagger2-security.mjs`

**代码锚点：** [src/swagger2-security.mjs:150](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/swagger2-security.mjs#L150)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 265. `integration/backend-ci-hardening`

**结论：提交历史已纳入。** SHA：[`ee47529c052a`](https://github.com/Hubujiu/local-api-workbench/tree/ee47529c052a5116ea27ae3a923e0dd73bf9347a)；PR：[#115](https://github.com/Hubujiu/local-api-workbench/pull/115)。

**范围：** Integrate backend and CI hardening

实际审查比较基线 `2118b96814b7`；比较增量：17 files changed, 1747 insertions(+), 24 deletions(-)。原 main 领先 1092 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41881767364)

**实际审查：**

逐个比较 Git blob：7 个生产文件分别与已审的 script-host-lifecycle、script-startup-diagnostics、lock-first-attempt 分支完全相同，集成提交没有另造脚本执行或锁语义。保留终端消息必须等待 worker 退出、相对生命周期时钟、严格有界诊断投影与硬截止期限内的第一次无竞争锁尝试。

检查集成后的观测/CLI/restore 诊断测试，私有字段与访问器/Proxy 不进入诊断，2KiB 既有 cap 不变，测试没有放宽超时预算；此集成基于 12 分片分支，后续 CI 需对最终合并树重跑，不能把分片改动或诊断输出当成时序故障已经修好。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低至中：生产改动及专用回归已逐项审阅，保留现有验证与执行预算，最终整合树仍须完整 CI。

### 266. `integration/if-protocol-chain-20261105`

**结论：提交历史已纳入。** SHA：[`5bdaebd87cee`](https://github.com/Hubujiu/local-api-workbench/tree/5bdaebd87cee034f62efb7da89c1bfdb9c8467a2)；PR：[#124](https://github.com/Hubujiu/local-api-workbench/pull/124)。

**范围：** Integrate IF protocol chains and fail-closed scope contract

实际审查比较基线 `b1b550f633dc`；比较增量：18 files changed, 3535 insertions(+), 48 deletions(-)。原 main 领先 1111 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42074194133)

**实际审查：**

核对 SSE、gRPC、Socket.IO 的独立 executor/凭据预检与祖先能力交集，false IF 仍要求潜在能力，禁用祖先只免执行授权、不免静态结构校验；grpcScripts 递归穿过 IF，Socket.IO 仍无脚本扩权。

重点审最后一个额外提交：任意 enabled IF（包括条件为 false 或已走过的 IF）使整个计划在 scope commit unknown 时停止，既识别异常实例也识别 PROJECT_COMMIT_UNCERTAIN code，禁用 IF 保留旧策略。真实 Store 成功写入后模拟确认丢失、HTTP loopback 与注入协议执行器的组合测试证明保留已完成证据且不重放/不执行尾部；它不冒充真实所有协议或日志崩溃测试。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 267. `integration/staged-runtime-rows-if-tcp-20261104`

**结论：提交历史已纳入。** SHA：[`6b6add6c70dd`](https://github.com/Hubujiu/local-api-workbench/tree/6b6add6c70ddc5d92f97ec3642e7df5970d10cf4)；PR：[#119](https://github.com/Hubujiu/local-api-workbench/pull/119)。

**范围：** Integrate staged runtime rows and IF TCP boundary tests

实际审查比较基线 `de09a8a7349e`；比较增量：13 files changed, 2158 insertions(+), 55 deletions(-)。原 main 领先 1103 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41920617538)

**实际审查：**

逐 blob 证实 5 个生产文件分别直接来自已审 #117 阶段压测动态行和 #118 canonical IF TCP：没有额外生产改写；组合同时保留每 VU 独立快照/作用域、schedule 入口重验、潜在预算以及 IF TCP 执行前授权。

新增组合测试在 prepare 和 direct run 两入口、true/false IF、嵌套 fixed repeat 下均先拒绝阶段压测的 enabled TCP，Proxy project 断言没有提前读取作用域；动态行的初版 HTTP 限制连禁用 TCP 叶子也约束，而禁用的独立 IF TCP 仍不激活传输。后续多协议动态行由各独立分支显式扩展，不能用本次集成推断全部消费者已经开放。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：涉及控制图、作用域/授权或消费者能力边界；保留后续已纳入的组合回归，最终整合树仍须完整 CI。

### 268. `main`

**结论：提交历史已纳入。** SHA：[`5af2f63913e0`](https://github.com/Hubujiu/local-api-workbench/tree/5af2f63913e097efd6fb3325103bd5fd2ee0f6a1)；PR：无独立 PR。

**范围：** Initial commit

实际审查比较基线 `5af2f63913e0`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 0 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

默认主线只有初始化 README，没有可运行应用、workflow 或测试。保留此提交为历史根，通过正常整合 PR 加入完整候选。

**整合判断：** 不重写 main、不将旧空树作为后续功能的覆盖来源。

**重点路径：** `README.md`

**验证及限制：**

不重写 main、不将旧空树作为后续功能的覆盖来源。

### 269. `perf/intrinsic-snapshot-descriptors-20261105`

**结论：提交历史已纳入。** SHA：[`66c7ec2f5926`](https://github.com/Hubujiu/local-api-workbench/tree/66c7ec2f59268c2108a2fa3a2492a3ae73a024f8)；PR：[#139](https://github.com/Hubujiu/local-api-workbench/pull/139)。

**范围：** perf: reduce intrinsic snapshot descriptor overhead

实际审查比较基线 `4412e15166ac`；比较增量：4 files changed, 85 insertions(+), 16 deletions(-)。原 main 领先 1126 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42129531986)

**实际审查：**

intrinsic快照优化为已捕获hasOwn+原生descriptor字段读取，减少重复descriptor调用。

不调用accessor，忽略继承的value/get/set污染，symbol和嵌套function图检查不删减；它是性能局部改进，不宣称修复所有wall预算失败。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

低：主要为测试或诊断/历史文档；不能据此推断未覆盖的协议、服务或平台行为。

### 270. `review/integration-2026-11-15`

**结论：提交历史已纳入。** SHA：[`cfbacf067163`](https://github.com/Hubujiu/local-api-workbench/tree/cfbacf067163e94367f84bed86b73c0ef31bc66a)；PR：[#250](https://github.com/Hubujiu/local-api-workbench/pull/250)。

**范围：** review: freeze Workbench integration candidate for develop

实际审查比较基线 `88f70bb515c4`；比较增量：1498 files changed, 369380 insertions(+), 11846 deletions(-)。原 main 领先 1272 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43690047490)；[Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43686244023)

**实际审查：**

PR #250 是到 #249 的累计整合快照，和 fix/plan-history-refresh-focus 指向同一 cfbacf06；最新 #263 继续包含此历史。

**整合判断：** 不需要先合并旧 review 到 develop 再重复并新堆栈。直接审查最终候选和真实独立增量，避免重复计数 1498 文件累计变化。

**重点路径：** `.github/workflows/ci.yml`、`docs/DELIVERY-STATUS.md`、`public/app.js`、`src/core.mjs`

**验证及限制：**

不需要先合并旧 review 到 develop 再重复并新堆栈。直接审查最终候选和真实独立增量，避免重复计数 1498 文件累计变化。

### 271. `test/agent-register-login-evidence`

**结论：补丁等价已纳入。** SHA：[`93853092713e`](https://github.com/Hubujiu/local-api-workbench/tree/93853092713e6b8ba2af67c61f6b03b3b497acdb)；PR：[#242](https://github.com/Hubujiu/local-api-workbench/pull/242)。

**范围：** 官方 MCP 注册后使用返回值登录的可审计证据

实际审查比较基线 `c1048acd527c`；比较增量：5 files changed, 310 insertions(+)。原 main 领先 1262 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43495591235)

**实际审查：**

使用官方 MCP client/StreamableHTTP transport、临时服务器和 synthetic loopback 账号；计划提取 register userId 用于 login header。

failurePolicy=stop 的失败路径断言只有 register 一次、没有 login；成功路径恰为 register/login 两次。

浏览器读相同持久化 run、plan hash、提取变量与导出，断言查看/导出不增加业务请求。

#242 与 #243 相对基线 stable patch-id 相同；候选 fixture 后续只增加 beforeRun 观察钩子及保存尚未执行时的断言，原测试语义保留。

**整合判断：** 原 head 不在候选祖先中，但已通过 #243 整合；相对各自基线的 stable patch-id 相同，并核对实际实现/测试接线。

**重点路径：** `tests/helpers/agent-register-login-fixture.mjs`、`tests/helpers/agent-register-login-ui.mjs`、`tests/agent-register-login.test.mjs`、`tests/ui-smoke.mjs`、`docs/agent-register-login-acceptance.md`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：合成受控服务证据不是任何真实注册站点的兼容/幂等保证；已发生注册无法由 stop 撤回。

### 272. `test/bounded-cookie-capture-fixture-20261112`

**结论：提交历史已纳入。** SHA：[`c8c1b4d7d148`](https://github.com/Hubujiu/local-api-workbench/tree/c8c1b4d7d14811373b141e605e21add3e3c24682)；PR：[#225](https://github.com/Hubujiu/local-api-workbench/pull/225)。

**范围：** cookie capture 测试进入点的有界等待

实际审查比较基线 `192c6985934d`；比较增量：3 files changed, 225 insertions(+), 1 deletion(-)。原 main 领先 1235 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43283941991)

**实际审查：**

observeCaptureEntry 记录第一执行是否进入 capture；如果已完成或失败但 capture 不再可能发生，立即 abort 并 resolve 等待门，避免 fixture 永久等待。

后续 execute 被 stoppedBeforeCapture 阻断，不会因测试超时继续发送真正请求；只收集白名单错误码，保留原异常。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `tests/helpers/cookie-capture-entry.mjs`、`tests/cookie-capture-entry.test.mjs`、`tests/cookie-request-cancellation.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：修正测试调度与清理，不改变生产 Cookie 处理或宣布历史 macOS XML 时间预算问题已解决。

### 273. `test/canonical-windows-stage-fixture`

**结论：提交历史已纳入。** SHA：[`407d724d02a2`](https://github.com/Hubujiu/local-api-workbench/tree/407d724d02a2d0b8272f905bf2693a63bf3b40ed)；PR：[#256](https://github.com/Hubujiu/local-api-workbench/pull/256)。

**范围：** test: use a canonical temp root in the staging CLI fixture

实际审查比较基线 `448691ebd035`；比较增量：1 file changed, 3 insertions(+), 1 deletion(-)。原 main 领先 1278 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43715075989)

**实际审查：**

仅将 staging CLI fixture 的临时根解析为规范路径，防止 macOS /var 与 /private/var 等路径别名误差。

**整合判断：** 测试修复保留产品的真实父目录/路径限制，未削弱 payload identity 或文件清单断言。

**重点路径：** `tests/test_portable_windows_stage_ci.py`

**验证及限制：**

测试修复保留产品的真实父目录/路径限制，未削弱 payload identity 或文件清单断言。

### 274. `test/combined-protocol-draft-agent-evidence`

**结论：提交历史已纳入。** SHA：[`e8138dad4ac9`](https://github.com/Hubujiu/local-api-workbench/tree/e8138dad4ac902e4fa04479a00564b5907eb90fa)；PR：[#243](https://github.com/Hubujiu/local-api-workbench/pull/243)。

**范围：** 协议草稿保护与 MCP 注册登录证据整合

实际审查比较基线 `85a0b717ab52`；比较增量：5 files changed, 310 insertions(+)。原 main 领先 1264 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43505446461)

**实际审查：**

把 #242 原补丁完整放到 #241 基线上，保留协议草稿关闭保护和新 MCP→UI 历史证据。

stable patch-id 与 #242 相同，候选继承实际测试入口；无需再合并非祖先 #242。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `tests/helpers/agent-register-login-fixture.mjs`、`tests/helpers/agent-register-login-ui.mjs`、`tests/agent-register-login.test.mjs`、`tests/ui-smoke.mjs`、`docs/agent-register-login-acceptance.md`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：复用 #242 fixture/官方 MCP/浏览器证据审查；测试型分支未新增产品协议能力。

### 275. `test/cookie-budget-deterministic-20261105`

**结论：提交历史已纳入。** SHA：[`5c01bdb69819`](https://github.com/Hubujiu/local-api-workbench/tree/5c01bdb69819766c46ebbeee652b90b5238b4afc)；PR：[#140](https://github.com/Hubujiu/local-api-workbench/pull/140)。

**范围：** test: make Cookie request deadline coverage deterministic

实际审查比较基线 `66c7ec2f5926`；比较增量：1 file changed, 76 insertions(+), 21 deletions(-)。原 main 领先 1127 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42131295378)

**实际审查：**

Cookie预算测试以模拟单调时钟精确消耗130/220ms并保留真实loopbackHTTP，验证原220ms剩余90ms及已耗尽零派发。

只截获该请求的总timer/socket timeout，不增加生产预算；未改变存储字节并在复原mock后健康检查，避免用调度sleep近似语义。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低：主要为测试或诊断/历史文档；不能据此推断未覆盖的协议、服务或平台行为。

### 276. `test/cookie-clock-integer-20261106`

**结论：提交历史已纳入。** SHA：[`817d071b21ac`](https://github.com/Hubujiu/local-api-workbench/tree/817d071b21acc279627d4f94ee5ba00a1f001da5)；PR：[#142](https://github.com/Hubujiu/local-api-workbench/pull/142)。

**范围：** test: use integer clock origin for cookie request budgets

实际审查比较基线 `fcc755fdcf2a`；比较增量：1 file changed, 2 insertions(+), 1 deletion(-)。原 main 领先 1129 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42135058276)

**实际审查：**

把上述确定性Cookie测试时钟原点改成整数1000，消除浮点减法造成90ms精确断言漂移。

仅一行fixture数据变化，不改生产时钟、超时、请求数或任何成功/失败断言。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

低：主要为测试或诊断/历史文档；不能据此推断未覆盖的协议、服务或平台行为。

### 277. `test/database-real-tls`

**结论：提交历史已纳入。** SHA：[`89835079f1ed`](https://github.com/Hubujiu/local-api-workbench/tree/89835079f1ed58ffa8db2fd055e0cf2500792a4b)；PR：[#187](https://github.com/Hubujiu/local-api-workbench/pull/187)。

**范围：** test: isolated real PostgreSQL MySQL Redis TLS CI acceptance

实际审查比较基线 `4be550df4a27`；比较增量：7 files changed, 876 insertions(+)。原 main 领先 1188 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43042473274)

**实际审查：**

CI增PostgreSQL/MySQL/Redis真实TLS专用容器，复用服务镜像digest且pull=never、loopback随机端口、独占目录和记录ID清理。

良好CA/错CA/错主机/明文/错认证走实际产品入口，每次负例后健康正例；明文拒绝必须同时具数据库政策证据，拒绝把EOF/timeout当TLS通过。签名key不入挂载，always cleanup。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 278. `test/desktop-cleanup-stages-20261106`

**结论：提交历史已纳入。** SHA：[`600f29b0bf47`](https://github.com/Hubujiu/local-api-workbench/tree/600f29b0bf47bba6d11299d6b172c2ae10bd3915)；PR：[#153](https://github.com/Hubujiu/local-api-workbench/pull/153)。

**范围：** test: observe bounded desktop smoke cleanup stages

实际审查比较基线 `c1f8aa65cc80`；比较增量：3 files changed, 156 insertions(+), 1 deletion(-)。原 main 领先 1143 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42161700047)

**实际审查：**

仅给桌面测试cleanup七个固定阶段添加begin/completed/failed与有界耗时标记，用于定位实际卡在哪个await。

observer无timer、重试、进程控制或任意payload，报告异常不影响原cleanup；应用kill原有、close失败处理仍保持，不能当修复退出卡顿。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：桌面生命周期和三平台差异依赖完整打包 CI；测试范围及正常退出/强制终止证据不得混淆。

### 279. `test/desktop-lifecycle-observations`

**结论：提交历史已纳入。** SHA：[`846e62416269`](https://github.com/Hubujiu/local-api-workbench/tree/846e62416269157e9b8f16b858a9776bbcdfd8ea)；PR：[#155](https://github.com/Hubujiu/local-api-workbench/pull/155)。

**范围：** test: observe desktop exit lifecycle without altering cleanup

实际审查比较基线 `c9350522a83b`；比较增量：3 files changed, 168 insertions(+), 1 deletion(-)。原 main 领先 1145 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42164693942)

**实际审查：**

桌面测试观测进程exit/close/kill发送与Electron quit/unload事件，只打印固定枚举与布尔，一次去重。

prependOnceListener在原生阻塞对话框前记录但不preventDefault或改生命周期；标记可在Playwright断连后由stderr保留，不增加预算或改变终态。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：桌面生命周期和三平台差异依赖完整打包 CI；测试范围及正常退出/强制终止证据不得混淆。

### 280. `test/downloaded-portable-launch`

**结论：提交历史已纳入。** SHA：[`1382554d7d2a`](https://github.com/Hubujiu/local-api-workbench/tree/1382554d7d2a8452717be4f18610c954846f4015)；PR：[#238](https://github.com/Hubujiu/local-api-workbench/pull/238)。

**范围：** 从 CI 实际下载便携产物并启动的验收链

实际审查比较基线 `74762c5c4a28`；比较增量：7 files changed, 424 insertions(+), 7 deletions(-)。原 main 领先 1259 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43455751604)

**实际审查：**

downloaded-portable 消费同一 workflow 的 desktop artifacts，先验证 manifest/head/platform，再安全 materialize，然后真实启动及正常/崩溃重启旅程。

验收脚本与原构建目录路径分离，避免把构建目录已通过误写为下载文件已通过。

跨平台脚本/路径安全专项复用 CI 审查者 ci-review.json；本补充核对 workflow 到 journey 的接线及范围声明。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `.github/workflows/ci.yml`、`scripts/materialize_portable_download.py`、`tests/desktop-restart-journey.mjs`、`tests/helpers/desktop-journey-options.mjs`、`tests/test_portable_materialize.py`、`docs/ADR-DOWNLOADED-PORTABLE-JOURNEY.md`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：固定候选远端 CI 可用；本次未重新下载并在三个 OS 启动，不代表签名、安装器或人工 OS 对话框验收。

### 281. `test/electron-restart-download-events`

**结论：提交历史已纳入。** SHA：[`adf8dbbf2efc`](https://github.com/Hubujiu/local-api-workbench/tree/adf8dbbf2efc35bf41128404cc7887f08cbade42)；PR：[#210](https://github.com/Hubujiu/local-api-workbench/pull/210)。

**范围：** test: enable Electron restart journey download events

实际审查比较基线 `80cb576cfac8`；比较增量：1 file changed, 2 insertions(+)。原 main 领先 1216 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43148687129)

**实际审查：**

打包Electron重启测试launch显式acceptDownloads=true，使Playwright接收备份download事件。

两行测试启动选项及说明，无产品下载逻辑、安全设置或预算修改；#210成功可以验证旅程但不能把#209原失败改记green。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：桌面生命周期和三平台差异依赖完整打包 CI；测试范围及正常退出/强制终止证据不得混淆。

### 282. `test/first-use-import-recovery`

**结论：语义已整合或由后续实现替代。** SHA：[`6f977444c899`](https://github.com/Hubujiu/local-api-workbench/tree/6f977444c899bb4e51569f20dda156d5ebe046d3)；PR：[#237](https://github.com/Hubujiu/local-api-workbench/pull/237)。

**范围：** 首次导入失败恢复及重启持久化证据

实际审查比较基线 `74762c5c4a28`；比较增量：3 files changed, 159 insertions(+)。原 main 领先 1260 提交；原候选直接包含：否。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43455555915)

**实际审查：**

真实临时服务器/项目先发送无效 OpenAPI，比较导出项目未变化，再导入修正内容；重启后校验保存内容与前一进程一致。

浏览器首次使用恢复 helper 保留；这三个改动文件在 #239 和候选逐 blob 相同。

**整合判断：** 原 head 不在候选祖先中，但已通过 #239 整合；该分支全部改动文件与整合分支及候选逐 blob 相同；整合分支另加诊断覆盖，因此整体 patch-id 不同。

**重点路径：** `tests/first-use-import-recovery.test.mjs`、`tests/helpers/restart-journey-ui.mjs`、`tests/project-import-ownership-ui.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：覆盖受控无效输入和纠正流程，不是所有导入格式或同源完整迁移证明。

### 283. `test/gui-restart-journey`

**结论：提交历史已纳入。** SHA：[`ef01b56fcc41`](https://github.com/Hubujiu/local-api-workbench/tree/ef01b56fcc41fbde4591b4face63238308c29f4d)；PR：[#206](https://github.com/Hubujiu/local-api-workbench/pull/206)。

**范围：** test: add isolated GUI restart restore and reauthorization journey

实际审查比较基线 `fefcf7baa9ff`；比较增量：5 files changed, 560 insertions(+)。原 main 领先 1212 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43092371229)

**实际审查：**

以真实 UI 完成导入、鉴权/脚本、HTTP 执行、SQLite 临时授权、冻结计划与原生备份，再关闭并启动独立后端进程；检查 PID/token 更新、旧端口关闭和旧 token 拒绝，不能以页面 reload 冒充重启。

跨进程核对冻结历史及导出完全一致，旧 SQLite 授权在重启/恢复后均拒绝且不发 HTTP，重新授权/绑定后才执行；正常关闭要求退出码 0、signal 为空，强杀只用于失败清理。覆盖合成 HTTP+SQLite，不代表外部数据库或掉电场景。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：桌面生命周期和三平台差异依赖完整打包 CI；测试范围及正常退出/强制终止证据不得混淆。

### 284. `test/heap-workflow-failure-diagnostics-20261112`

**结论：补丁等价已纳入。** SHA：[`7097bb74ad30`](https://github.com/Hubujiu/local-api-workbench/tree/7097bb74ad30c4707e0c19ace32c514b9d25f4d3)；PR：[#222](https://github.com/Hubujiu/local-api-workbench/pull/222)。

**范围：** QuickJS heap 失败诊断信息

实际审查比较基线 `ae093e5a9770`；比较增量：3 files changed, 120 insertions(+), 9 deletions(-)。原 main 领先 1233 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43277984291)

**实际审查：**

只在原断言失败后附加白名单 phase 与 bounded worker metadata，不序列化请求/响应/变量正文。

保留 failed/out of memory/script/250ms 原断言，诊断异常不能吞掉或替代原失败。

所有三文件在候选逐 blob 完全相同；#224 相对基线 stable patch-id 与 #222 相同。

**整合判断：** 原 head 不在候选祖先中，但已通过 #224 整合；相对各自基线的 stable patch-id 相同，并核对实际实现/测试接线。

**重点路径：** `tests/helpers/heap-workflow-diagnostics.mjs`、`tests/quickjs-heap-workflow.test.mjs`、`tests/worker-rejection-diagnostics.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：此分支改善失败可观测性，没有修复历史 OOM/预算偶发失败，也没有延长预算。

### 285. `test/integrated-download-import-recovery`

**结论：提交历史已纳入。** SHA：[`3a8d9ee8e66b`](https://github.com/Hubujiu/local-api-workbench/tree/3a8d9ee8e66b1744e11256396635663621f32b35)；PR：[#239](https://github.com/Hubujiu/local-api-workbench/pull/239)。

**范围：** 下载启动、首次导入恢复与响应头失败诊断整合

实际审查比较基线 `1382554d7d2a`；比较增量：6 files changed, 274 insertions(+), 3 deletions(-)。原 main 领先 1260 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43466017423)

**实际审查：**

三个 #237 文件在 #239 与候选完全相同，首次导入恢复未因整合遗漏。

额外 response header completion 诊断保留原失败语义，不放宽 native pick header 断言。

测试与下载旅程集成，不改变产品导入接口。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `tests/first-use-import-recovery.test.mjs`、`tests/helpers/restart-journey-ui.mjs`、`tests/project-import-ownership-ui.test.mjs`、`tests/helpers/header-completion-diagnostics.mjs`、`tests/header-completion-diagnostics.test.mjs`、`tests/native-pick-header-boundaries.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：复用 #237 初次使用恢复审查；诊断输出改善不能用作历史 XML/HTTP2 问题已修复的证明。

### 286. `test/native-automation-rejection`

**结论：提交历史已纳入。** SHA：[`8e00aa35e9ca`](https://github.com/Hubujiu/local-api-workbench/tree/8e00aa35e9cad2deb06927efd43640c443087501)；PR：[#168](https://github.com/Hubujiu/local-api-workbench/pull/168)。

**范围：** test: verify native automation import rejection without inferred semantics

实际审查比较基线 `50476cfcab8b`；比较增量：3 files changed, 316 insertions(+), 4 deletions(-)。原 main 领先 1163 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42981270472)

**实际审查：**

新增完整合成原生automation负例并修正文档“没有非空样本”的过时表述；明确现有公开样本尚不能证明同版本往返语义。

空automation阳性壳可导入7API，再测direct/owner/MCP拒绝非空、排序冲突和未知schedule，逐次比较两个项目/全盘字节/零HTTP；旧有效token不得挪用换源apply，不启用原生automation。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 287. `test/native-automation-semantic-boundaries`

**结论：提交历史已纳入。** SHA：[`afefbef328c7`](https://github.com/Hubujiu/local-api-workbench/tree/afefbef328c793e0ccd4a4a0957b3718080a121b)；PR：[#252](https://github.com/Hubujiu/local-api-workbench/pull/252)。

**范围：** test: lock native automation semantic refusal boundaries

实际审查比较基线 `f9b5b996d03f`；比较增量：5 files changed, 166 insertions(+), 24 deletions(-)。原 main 领先 1274 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43698163465)

**实际审查：**

非空原生 automated_testings 的 11 类合成变体锁定明确拒绝；覆盖 direct、owner preview/apply 与 MCP，失败不发布可用 token，不改两项目磁盘字节，不发送业务请求。

**整合判断：** 这是拒绝边界的验证，不是成功导入/执行兼容的证据。本次边界回归通过，保持现有保守入口。

**重点路径：** `tests/native-automation-boundaries.test.mjs`、`tests/native-automation-rejection.test.mjs`、`tests/fixtures/native-automation-boundaries.mjs`、`docs/native-automation-semantic-acceptance.md`

**验证及限制：**

这是拒绝边界的验证，不是成功导入/执行兼容的证据。本次边界回归通过，保持现有保守入口。

### 288. `test/native-restart-cli-diagnostics-20261105`

**结论：提交历史已纳入。** SHA：[`e69e96037355`](https://github.com/Hubujiu/local-api-workbench/tree/e69e96037355d55a5a495d4b29a62f1f293c1d7b)；PR：[#133](https://github.com/Hubujiu/local-api-workbench/pull/133)。

**范围：** Retain native comparator restart CLI failure diagnostics

实际审查比较基线 `23a88ed06976`；比较增量：1 file changed, 4 insertions(+), 1 deletion(-)。原 main 领先 1120 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/42108525861)

**实际审查：**

仅给原生比较器restore后CLI退出码断言包上现有白名单诊断helper。

退出码仍必须0，successfulRun与精确wire断言保留；无重新执行、回退、预算或产品修改。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注入口授权、会话关闭/取消与持久化证据；不把静态定义支持等同于每个消费者均可执行。

### 289. `test/packaged-electron-restart-journey`

**结论：提交历史已纳入。** SHA：[`c402ce3e1d69`](https://github.com/Hubujiu/local-api-workbench/tree/c402ce3e1d699efa5b38494c2ada94264f99b957)；PR：[#208](https://github.com/Hubujiu/local-api-workbench/pull/208)。

**范围：** test: validate packaged Electron restart with shared GUI journey

实际审查比较基线 `9d151f533973`；比较增量：7 files changed, 618 insertions(+), 275 deletions(-)。原 main 领先 1214 提交；原候选直接包含：是。

原分支精确 head 的 CI：**cancelled**。 [Validate Local API / cancelled](https://github.com/Hubujiu/local-api-workbench/actions/runs/43095668942)

**实际审查：**

把同一真实 UI 重启旅程接到三平台打包后的 Electron 可执行文件，两次启动复用 userData，并检查 sandbox/contextIsolation 开启、nodeIntegration 关闭；正常退出必须同时收到 exit/close、0/空 signal 和 LOCAL_API_SHUTDOWN_SAVED，不能把 cleanup 强杀当作成功。

新进程验证旧端口关闭、token 轮换、旧 token/数据库授权被拒绝及网络命中数不增，记录每代 trace/历史/截图；后续 #210 的 acceptDownloads 修复已在候选中。这里验证正常退出恢复，突发终止由独立 #212 覆盖。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的最新历史工作流含取消，不能视作通过；最终整合必须依其自身 CI 判定。

**验证及限制：**

中：桌面生命周期和三平台差异依赖完整打包 CI；测试范围及正常退出/强制终止证据不得混淆。

### 290. `test/packaged-hard-stop-recovery`

**结论：提交历史已纳入。** SHA：[`ab41891679e6`](https://github.com/Hubujiu/local-api-workbench/tree/ab41891679e60a8738ccfc3d283bc3b68570feb3)；PR：[#212](https://github.com/Hubujiu/local-api-workbench/pull/212)。

**范围：** test(desktop): verify packaged hard-stop recovery without masking data loss

实际审查比较基线 `adc150c481b0`；比较增量：9 files changed, 305 insertions(+), 6 deletions(-)。原 main 领先 1219 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43172153879)

**实际审查：**

增加三平台打包 Electron 非正常终止旅程：POSIX 对所拥有的活进程发 SIGKILL，Windows 以 shell:false 调 taskkill /PID /T /F 并校验正整数 PID/存活状态和超时；严格要求 forced/sent/closed 且无 saved 回执，清理阶段的终止不会被算作测试成功。

重启后在任何保存、执行或恢复外部备份之前，立即只读导出原项目并与终止前完整导出深比较，同时验证旧授权/token 失效；真实子进程回归覆盖后代继承 stdio 的 Windows 退出情况。边界为已经提交的数据恢复，不承诺未保存编辑、在途写入或掉电原子性。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：桌面生命周期和三平台差异依赖完整打包 CI；测试范围及正常退出/强制终止证据不得混淆。

### 291. `test/plan-history-refresh-delayed-get`

**结论：提交历史已纳入。** SHA：[`794cff388991`](https://github.com/Hubujiu/local-api-workbench/tree/794cff388991bcb4535aebc3810e8bac118ddaca)；PR：[#247](https://github.com/Hubujiu/local-api-workbench/pull/247)。

**范围：** 浏览器延迟 GET 和旧 DOM 响应的可观察验收

实际审查比较基线 `9c44eca4dfd2`；比较增量：4 files changed, 221 insertions(+), 2 deletions(-)。原 main 领先 1269 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43674731764)

**实际审查：**

测试持有真实上游 GET，并观察实际异步 click listener 完成，不用任意 sleep 当作 UI 已处理。

tab 切换后旧 DOM disconnected；释放响应并等待完成，再重新渲染检查缓存未被隐藏采用。

禁用按钮的原生点击不发送第二请求；请求证据校验没有隐式写或重复 GET。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `tests/helpers/plan-history-refresh-held-ui.mjs`、`tests/helpers/plan-history-refresh-ui.mjs`、`tests/plan-history-refresh-observer.test.mjs`、`docs/plan-history-refresh-candidate.md`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：只加强 #246 某些并发路径验收，不修改生产刷新逻辑；不能替代所有页面并发测试。

### 292. `test/project-save-conflict-browser`

**结论：提交历史已纳入。** SHA：[`95c634acc2b0`](https://github.com/Hubujiu/local-api-workbench/tree/95c634acc2b02d15441f21d828ef8913e3423a33)；PR：[#245](https://github.com/Hubujiu/local-api-workbench/pull/245)。

**范围：** 实际保存冲突及浏览器草稿保留

实际审查比较基线 `420acf74edd2`；比较增量：4 files changed, 341 insertions(+)。原 main 领先 1266 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43523045587)

**实际审查：**

fixture 用真实另一 owner CAS 写入产生冲突；浏览器旧 PUT 必须被拒绝，保留本地未保存草稿。

断言无自动重试、无自动 GET；显式重读取消保留草稿，明确接受重读才丢弃。

记录实际请求与 loopback peer hits=0，防止以重放业务或无条件覆盖来伪装修复冲突。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `tests/helpers/project-save-conflict-fixture.mjs`、`tests/helpers/project-save-conflict-ui.mjs`、`tests/project-save-conflict-fixture.test.mjs`、`tests/ui-smoke.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：覆盖真实受控 revision 冲突，不代表断电、任意文件损坏、跨进程锁所有组合均已独立验证。

### 293. `test/protocol-draft-electron-close-cancel`

**结论：提交历史已纳入。** SHA：[`420acf74edd2`](https://github.com/Hubujiu/local-api-workbench/tree/420acf74edd271651154cc0e14c1f8fa3737caf9)；PR：[#244](https://github.com/Hubujiu/local-api-workbench/pull/244)。

**范围：** 真实 Electron 关闭时取消保留协议草稿

实际审查比较基线 `e8138dad4ac9`；比较增量：3 files changed, 250 insertions(+)。原 main 领先 1265 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43514971791)

**实际审查：**

实际调用 BrowserWindow.close 并观察 beforeunload，替换的仅是宿主对话框选择结果；核对窗口未关闭/未导航且草稿仍在。

关闭取消过程不发生保存、执行、连接等额外业务操作；测试接入 desktop restart journey。

**整合判断：** 固定分支 SHA 已是候选祖先；按本 PR 的实际差异及当前实现接线审查，无需重合旧分支。

**重点路径：** `tests/helpers/protocol-draft-close-electron.mjs`、`tests/desktop-restart-journey.mjs`、`tests/protocol-draft-close-electron.test.mjs`

**验证及限制：**

**fixed_candidate_ci**：**candidate_sha**：2532d67136fbc89000ecaf079f826ed229600e86

**candidate_tree**：a46b06ae47a828ad533d641f0bf951f641bef1b7

**ci_merge_sha**：9fd6913b4bbeafda02b1e3acac574276c0346ca0

**same_tree**：是

**run_id**：44092428921

**jobs**：46/46 success

**url**：https://github.com/Hubujiu/local-api-workbench/actions/runs/44092428921

**review_source**：/workspace/scratch/01aad5b30f1d/ci-review.json

**limits**：引用 CI 专项审查者核实的固定候选同树远端证据；本补充未逐个历史 head 重新运行，也未在本机重跑浏览器/Electron/三平台。

**local_new_tests**：此补充未新增本地测试运行；原生/协议专项165/165通过另见 native-protocol-targeted.tap，不把它冒作本UI范围全量验证。

**risk_boundaries**：这是 Electron 实际关闭生命周期与取消分支证据，不是人手点击 OS 原生模态按钮或全部系统安装体验。

### 294. `test/socketio-fixture-diagnostics`

**结论：提交历史已纳入。** SHA：[`a29374777889`](https://github.com/Hubujiu/local-api-workbench/tree/a29374777889a94e597614d76b53657d1c6711f5)；PR：[#202](https://github.com/Hubujiu/local-api-workbench/pull/202)。

**范围：** test: retain bounded Socket.IO cancellation fixture diagnostics

实际审查比较基线 `a2170cf8c1b2`；比较增量：3 files changed, 198 insertions(+), 50 deletions(-)。原 main 领先 1206 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43080522644)

**实际审查：**

Socket.IO repeat取消fixture增加固定计数与生命周期布尔诊断，失败/abort只输出一次且成功静默。

保留原promise、await次序、取消接口及100ms deadline、旧结果数/晚ACK/下一run断言；不打印消息、token或行值，不宣称解决偶发失败。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低：主要为测试或诊断/历史文档；不能据此推断未覆盖的协议、服务或平台行为。

### 295. `test/sqlite-commit-boundary-evidence-20261105`

**结论：提交历史已纳入。** SHA：[`4412e15166ac`](https://github.com/Hubujiu/local-api-workbench/tree/4412e15166acdedb147dca2e1cb3da3fd373edcb)；PR：[#138](https://github.com/Hubujiu/local-api-workbench/pull/138)。

**范围：** test: demonstrate SQLite commit boundary outcome ambiguity

实际审查比较基线 `9cc387488a17`；比较增量：2 files changed, 154 insertions(+)。原 main 领先 1125 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/42125794404)

**实际审查：**

三个独占SQLite fixture分别卡COMMIT前、后、result后，通过真实2秒supervisor期限证明同“commit”观察可对应0/1持久值。

每库只增量执行一次，等真实child close后独立只读回查；相同unknown不能推断回滚，不重放用户写入、不增生产故障开关或预算。历史Windows未知写入仍未定位。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 296. `test/sqlserver-input-contract`

**结论：提交历史已纳入。** SHA：[`fefcf7baa9ff`](https://github.com/Hubujiu/local-api-workbench/tree/fefcf7baa9ff89264beeb5d978c25bad75c1afe8)；PR：[#205](https://github.com/Hubujiu/local-api-workbench/pull/205)。

**范围：** test: define inert SQL Server read input adaptation contract

实际审查比较基线 `ff327295253f`；比较增量：3 files changed, 392 insertions(+)。原 main 领先 1210 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43089796163)

**实际审查：**

新增纯SQLServer read输入适配层，严格plain nonproxy own-data字段再编译。

返回config+plan候选不授执行能力；pre-abort不接触输入，编译后检查取消，固定错误避免泄露credentials/SQL；所有公开provider入口仍关闭。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 297. `test/sqlserver-real-service-gate`

**结论：提交历史已纳入。** SHA：[`f9b5b996d03f`](https://github.com/Hubujiu/local-api-workbench/tree/f9b5b996d03f223245c413e23205fcfaf0de6a1e)；PR：[#251](https://github.com/Hubujiu/local-api-workbench/pull/251)。

**范围：** test: gate SQL Server preparation against an opt-in real service

实际审查比较基线 `cfbacf067163`；比较增量：5 files changed, 388 insertions(+)。原 main 领先 1273 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43694081398)

**实际审查：**

显式 opt-in 的真实 SQL Server 准备层验收：只读/可写数据库分别验证，限制账户权限、同主机、TLS/CA、参数化 SELECT 和 READ_WRITE 拒绝。

**整合判断：** 普通 CI 未设置真实服务门槛时会跳过，不应宣称 SQL Server provider 已完成。本轮 gate/config/相关边界共 23 通过、1 实库跳过；没有启用未注册 provider。

**重点路径：** `tests/sqlserver-real-service.test.mjs`、`tests/helpers/sqlserver-real-gate.mjs`、`tests/sqlserver-real-gate-config.test.mjs`、`src/sqlserver-read-prep.mjs`

**验证及限制：**

普通 CI 未设置真实服务门槛时会跳过，不应宣称 SQL Server provider 已完成。本轮 gate/config/相关边界共 23 通过、1 实库跳过；没有启用未注册 provider。

### 298. `test/sqlserver-synthetic-protocol`

**结论：提交历史已纳入。** SHA：[`9d151f533973`](https://github.com/Hubujiu/local-api-workbench/tree/9d151f533973e60d5f20b836bf14e0a424ba2913)；PR：[#207](https://github.com/Hubujiu/local-api-workbench/pull/207)。

**范围：** test: validate SQL Server adapter TLS with a synthetic TDS peer

实际审查比较基线 `ef01b56fcc41`；比较增量：3 files changed, 292 insertions(+)。原 main 领先 1213 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43094696449)

**实际审查：**

合成loopback TDS peer驱动真实固定Tedious和TLS，拒绝OFF/NOT_SUP/缺失/未知加密响应时无后续LOGIN7；正确TLS才可在解密流看虚构身份。

错CA/错hostname不发送解密LOGIN7、每例仅1socket且原固定错误/close合同成立；刻意不回LOGINACK、不执行SQL，因此仅协议回归，不能宣称真实SQLServer可用，MIT来源已记录。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

该分支头的历史工作流仍有失败；本次审查没有把它改记为成功，也未重新运行这条旧分支。最终整合必须依其自身 CI 判定。

**验证及限制：**

中：关注授权、连接/查询参数、Unicode 与数值保真；合成契约测试与真实服务验证的覆盖边界必须分别保留。

### 299. `test/text-cli-failure-diagnostics`

**结论：提交历史已纳入。** SHA：[`eb60367347d6`](https://github.com/Hubujiu/local-api-workbench/tree/eb60367347d6c021ee961bc893131024f068782b)；PR：[#198](https://github.com/Hubujiu/local-api-workbench/pull/198)。

**范围：** test: retain safe Text CLI failure diagnostics without changing assertions

实际审查比较基线 `df481ea29288`；比较增量：2 files changed, 81 insertions(+), 3 deletions(-)。原 main 领先 1202 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43073837023)

**实际审查：**

Text CLI失败断言增加现有有界诊断包裹，断言对象identity/actual/expected/operator和一次调用保留。

新回归只允许失败step的白名单scriptStage等≤4KiB元数据，排除正文/URL/变量/完整stdout；预算和退出码未变。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低：主要为测试或诊断/历史文档；不能据此推断未覆盖的协议、服务或平台行为。

### 300. `test/windows-native-payload-stage`

**结论：提交历史已纳入。** SHA：[`448691ebd035`](https://github.com/Hubujiu/local-api-workbench/tree/448691ebd035e1f5126e493fe78a67d28fea455d)；PR：[#255](https://github.com/Hubujiu/local-api-workbench/pull/255)。

**范围：** test: stage actual downloaded payload on the Windows runner

实际审查比较基线 `68087048ddbd`；比较增量：4 files changed, 102 insertions(+), 1 deletion(-)。原 main 领先 1277 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/43710553530)

**实际审查：**

下载的真实 Windows 产物在 Windows runner 上验证、暂存并比对身份/manifest；在 CI 中接入而非仅验证合成压缩包。

**整合判断：** 证据仅覆盖下载后 staging，不扩大到安装器运行、签名或卸载。71 项 portable Python 回归覆盖相关文件边界。

**重点路径：** `.github/workflows/ci.yml`、`tests/test_portable_windows_stage_ci.py`、`scripts/stage_windows_payload.py`

**验证及限制：**

证据仅覆盖下载后 staging，不扩大到安装器运行、签名或卸载。71 项 portable Python 回归覆盖相关文件边界。

### 301. `test/xml-cli-exit-diagnostics`

**结论：提交历史已纳入。** SHA：[`ff327295253f`](https://github.com/Hubujiu/local-api-workbench/tree/ff327295253f2549a9e07967a63c469b0726ad7c)；PR：[#204](https://github.com/Hubujiu/local-api-workbench/pull/204)。

**范围：** test: retain safe diagnostics at XML CLI exit assertions

实际审查比较基线 `236db2eada99`；比较增量：1 file changed, 13 insertions(+), 3 deletions(-)。原 main 领先 1209 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/43087559463)

**实际审查：**

XML入口三处CLI退出码断言接入同一白名单helper，保留失败code1、恢复成功code0与完整XML语义断言。

仅诊断接线，不扩执行budget、不改产品、不自动重跑或把历史失败视为已修复。

**整合判断：** 已包含在候选；保留当前实现，随整合分支统一进入 main，不逐条重放旧分支。

**发现/保留边界：**

分支头为候选 2532d67136fbc89000ecaf079f826ed229600e86 的真实祖先；内容已纳入，重放旧 PR 会重复引入历史中间态。

历史 CI 的 head_sha 与分支头相符；pull_request 事件实际 checkout 可能是测试合并提交，因此这里没有额外声称其 checkout tree 与 head tree 相同。

**验证及限制：**

低：主要为测试或诊断/历史文档；不能据此推断未覆盖的协议、服务或平台行为。

### 302. `wip/attribute-mock-integration`

**结论：提交历史已纳入。** SHA：[`835251263cdd`](https://github.com/Hubujiu/local-api-workbench/tree/835251263cdd841715abdb75fcf3a045fbf96429)；PR：无独立 PR。

**范围：** 历史组合检查点：attribute-mock-integration

实际审查比较基线 `835251263cdd`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 1018 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41763910200)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 269 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 303. `wip/attribute-oauth-integration`

**结论：语义已整合或由后续实现替代。** SHA：[`01b169f869e2`](https://github.com/Hubujiu/local-api-workbench/tree/01b169f869e22d4bf605535ac69289bb83015be1)；PR：无独立 PR。

**范围：** 历史组合检查点：attribute-oauth-integration

实际审查比较基线 `6883818be91e`；比较增量：13 files changed, 1870 insertions(+), 4 deletions(-)。原 main 领先 1012 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 1 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 13 个变化路径中 9 个与候选文件完全同 blob。

**重点路径：** `src/apipost-sample-export.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/apipost-attribute-roundtrip.test.mjs

**available_branch_tests**：tests/apipost-attribute-catalogues-owner.test.mjs

tests/apipost-attribute-catalogues.test.mjs

tests/apipost-attribute-export-unit.test.mjs

tests/apipost-attribute-export.test.mjs

tests/apipost-attribute-plan-types.test.mjs

tests/apipost-attribute-roundtrip.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 304. `wip/attribute-plan-integration`

**结论：语义已整合或由后续实现替代。** SHA：[`7062e906786b`](https://github.com/Hubujiu/local-api-workbench/tree/7062e906786b3951b0dcce038ee009fee85595ea)；PR：无独立 PR。

**范围：** 历史组合检查点：attribute-plan-integration

实际审查比较基线 `5362b7cea886`；比较增量：13 files changed, 1761 insertions(+), 4 deletions(-)。原 main 领先 1011 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享控制图使用当前 plan-step-types/plan-repeat/core；旧依赖选择性测试文件的等价断言位于 tests/plan-step-types-root.test.mjs，另保留生命周期测试。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 2 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 13 个变化路径中 8 个与候选文件完全同 blob。

**重点路径：** `src/apipost-sample-export.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/apipost-attribute-roundtrip.test.mjs

**available_branch_tests**：tests/apipost-attribute-catalogues-owner.test.mjs

tests/apipost-attribute-catalogues.test.mjs

tests/apipost-attribute-export-unit.test.mjs

tests/apipost-attribute-export.test.mjs

tests/apipost-attribute-plan-types.test.mjs

tests/apipost-attribute-roundtrip.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 305. `wip/auto-import-session-integration`

**结论：提交历史已纳入。** SHA：[`4be142f2e739`](https://github.com/Hubujiu/local-api-workbench/tree/4be142f2e739313a6ea6a30fa6c26e7b7fef074f)；PR：无独立 PR。

**范围：** 自动导入 session ownership 修复的整合 merge checkpoint

实际审查比较基线 `dbdb29f6ee43`；比较增量：4 files changed, 731 insertions(+), 50 deletions(-)。原 main 领先 992 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41431332090)

**实际审查：**

已读 merge 的 first-parent 生产 diff（active-project-import/server 272 行），以及真实 HTTP delayed-save 测试核心。

**整合判断：** 该 merge 是祖先，包含另一个 race 分支的完整实现。opaque 单次 lease 及 owner 身份跨 pending/suspended 阶段保持；stop、切项目、新 credentials 或新 save 都会替换旧 owner。旧 save 完成只能恢复自己的 lease，不能夺回用户更新的会话；成功持久化后也再次核对当前 epoch。

**重点路径：** `src/active-project-import.mjs`、`src/server.mjs`、`tests/auto-import-session-ownership.test.mjs`

**代码锚点：** [src/active-project-import.mjs:187](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/active-project-import.mjs#L187)；[src/active-project-import.mjs:312](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/active-project-import.mjs#L312)；[tests/auto-import-session-ownership.test.mjs:312](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/auto-import-session-ownership.test.mjs#L312)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 306. `wip/auto-import-session-races`

**结论：提交历史已纳入。** SHA：[`07a86468726e`](https://github.com/Hubujiu/local-api-workbench/tree/07a86468726ef1bf5aaa47070890b0abf19f8330)；PR：无独立 PR。

**范围：** 自动导入延迟读取/保存/取消的回归 checkpoint

实际审查比较基线 `c30706cbcf42`；比较增量：2 files changed, 609 insertions(+)。原 main 领先 405 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41430628296)

**实际审查：**

已读该分支相邻实现 c30706c 的等同 merge diff；检查 auto-import-session-ownership 中 gateCall、真实 HTTP、磁盘与授权断言。

**整合判断：** 祖先且被 auto-import-session-integration 整合。测试按 gated Store.get/save 分别让 switch/stop/credentials/failure 插入等待点；断言旧 lease 不能恢复，新的认证头仍是 fresh，且没有意外 HTTP 请求或迟到历史写入。不是仅依赖 sleep 的概率竞争回归。

**重点路径：** `tests/auto-import-session-ownership.test.mjs`、`src/active-project-import.mjs`

**代码锚点：** [tests/auto-import-session-ownership.test.mjs:25](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/auto-import-session-ownership.test.mjs#L25)；[src/active-project-import.mjs:299](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/active-project-import.mjs#L299)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 307. `wip/backend-integration`

**结论：提交历史已纳入。** SHA：[`3875f89be57b`](https://github.com/Hubujiu/local-api-workbench/tree/3875f89be57bc6cc0c9cb8c0708773b7799bcf13)；PR：无独立 PR。

**范围：** XML 结果诊断和 binary/scoped/history 后端组合 checkpoint

实际审查比较基线 `c7a06402727e`；比较增量：4 files changed, 1024 insertions(+), 28 deletions(-)。原 main 领先 1054 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41830574952)

**实际审查：**

已读最后一提交的 diagnostics helper 关键实现及断言边界，核对与同 SHA xml-result 分支重复。

**整合判断：** 与 wip/xml-result-diagnostics-integration 完全同 SHA；最后 delta 仅测试和 bounded helper。失败诊断复制固定枚举/数值，拒绝 getter/proxy、动态字段与任意正文，不把观察失败替换成测试通过。继承的大量后端功能不需从该 checkpoint 再次 merge。

**重点路径：** `tests/helpers/execution-result-diagnostics.mjs`、`tests/execution-result-diagnostics.test.mjs`

**代码锚点：** [tests/helpers/execution-result-diagnostics.mjs:11](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/helpers/execution-result-diagnostics.mjs#L11)；[tests/execution-result-diagnostics.test.mjs:394](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/execution-result-diagnostics.test.mjs#L394)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：此 checkpoint 的独立审查针对 first-parent 最后变更，不声称逐一重审此前所有祖先累计业务代码。

### 308. `wip/core-weights-integration`

**结论：提交历史已纳入。** SHA：[`c7a06402727e`](https://github.com/Hubujiu/local-api-workbench/tree/c7a06402727ed48437604b2905a736bcfc775340)；PR：无独立 PR。

**范围：** 核心测试完整文件调度权重整合

实际审查比较基线 `5f7ebe26d125`；比较增量：4 files changed, 962 insertions(+), 643 deletions(-)。原 main 领先 1053 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/41826108935)

**实际审查：**

已读 allocation metadata diff、SHA 和来源 run/file 白名单，检查当前配置仍完整分配文件。

**整合判断：** 祖先已含。冻结权重文件有内容哈希，记录确切历史 run/commit 与 whole-file 时间，不拆分测试文件或隐去慢测试。旧 4/6 shard 来源是历史采样，当前 12-shard 配置属于后续 CI 演进，不能为合并本分支而还原旧矩阵。

**重点路径：** `scripts/core-test-allocation.mjs`、`scripts/core-test-weights.json`

**代码锚点：** [scripts/core-test-allocation.mjs:4](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/scripts/core-test-allocation.mjs#L4)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：历史 timing 权重不是本次性能基准；当前全套运行结果由 CI 主审查提供。

### 309. `wip/core-worker-observations`

**结论：提交历史已纳入。** SHA：[`5e1354b1b5a4`](https://github.com/Hubujiu/local-api-workbench/tree/5e1354b1b5a4885a7c66a734a8a67f044412a572)；PR：无独立 PR。

**范围：** 核心测试 worker 失败在 IPC 序列化前的有界采集

实际审查比较基线 `1c4f61a96fbd`；比较增量：8 files changed, 1106 insertions(+), 174 deletions(-)。原 main 领先 404 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41265438413)

**实际审查：**

已读 536 行 reporter/projector/preload/runner 生产差异，检查 captured builtins 与准入。

**整合判断：** 祖先已含。只在显式预加载、main thread、node:test child-v8、tests 根直接 .test.mjs 文件下安装 observer，避免泄漏至应用 worker/CLI。Error 遍历限制深度/节点/条数；二次投影只允许有限标量，不输出任意 Error 或 source；上限/观察异常不改原 pass/fail。

**重点路径：** `scripts/core-progress-reporter.mjs`、`scripts/core-worker-observations.mjs`、`scripts/core-worker-observer-preload.mjs`、`scripts/run-core-tests.mjs`

**代码锚点：** [scripts/core-worker-observations.mjs:6](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/scripts/core-worker-observations.mjs#L6)；[scripts/core-worker-observer-preload.mjs:10](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/scripts/core-worker-observer-preload.mjs#L10)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 310. `wip/definition-history-integration`

**结论：提交历史已纳入。** SHA：[`c7fbe040adba`](https://github.com/Hubujiu/local-api-workbench/tree/c7fbe040adba48830fca4c704a5a0ecd99fa07c7)；PR：无独立 PR。

**范围：** 定义历史容量与新 identity restore 的组合边界

实际审查比较基线 `0d02130dc9a7`；比较增量：10 files changed, 324 insertions(+), 15 deletions(-)。原 main 领先 1035 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41807661278)

**实际审查：**

已读 history/runtime 75 行独立生产 diff 和实际历史/restore 断言。

**整合判断：** 祖先已含。历史 owner 先验证为 1..200 ASCII 字符，再用单字符 owner 做内容 quota 计费，保证恢复重绑 ID 不因长度改变占用；实际 envelope 保留 MAX+199 余量。调用 validate、projection 和 sameHistoryJSON 均使用匹配上限，不能允许从 owner PUT 修改服务端历史。

**重点路径：** `src/request-definition-history.mjs`、`src/runtime.mjs`

**代码锚点：** [src/request-definition-history.mjs:8](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/request-definition-history.mjs#L8)；[src/runtime.mjs:26](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/runtime.mjs#L26)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 311. `wip/failure-policy-backend-integration`

**结论：提交历史已纳入。** SHA：[`f11e4bbcb9d2`](https://github.com/Hubujiu/local-api-workbench/tree/f11e4bbcb9d2b707a35893693ab6c8852a858847)；PR：无独立 PR。

**范围：** failurePolicy 与必须停止、取消及证据的后端组合

实际审查比较基线 `c10eef6dd325`；比较增量：7 files changed, 1073 insertions(+), 12 deletions(-)。原 main 领先 1026 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41774839917)

**实际审查：**

读最后测试 delta 的关键 hard-stop 断言及 root-boundaries 当前实现；关联前一实现 c10eef6。

**整合判断：** 祖先已含。continue/stop/omitted 不可覆盖 HTTP finalization/redirect、progressFailure、scope commit 不确定及 revoke 的强制停止语义；已完成响应保留，retry_safe:false 不会被选项洗掉。测试同时检查 false IF 内写权限不能绕过预准入及 repeat 证据。

**重点路径：** `tests/plan-failure-policy-root-boundaries.test.mjs`、`tests/plan-failure-policy-root-scripts.test.mjs`

**代码锚点：** [tests/plan-failure-policy-root-boundaries.test.mjs:79](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/plan-failure-policy-root-boundaries.test.mjs#L79)；[tests/plan-failure-policy-root-scripts.test.mjs:120](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/plan-failure-policy-root-scripts.test.mjs#L120)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 312. `wip/grpc-code-examples-integration`

**结论：补丁等价已纳入。** SHA：[`5bdbf759036b`](https://github.com/Hubujiu/local-api-workbench/tree/5bdbf759036be0ddc7613f0e3226cc549a5da55c)；PR：[#103](https://github.com/Hubujiu/local-api-workbench/pull/103)。

**范围：** gRPC 请求样例、HTTP 代码生成及 owner cancellation 的组合

实际审查比较基线 `3875f89be57b`；比较增量：21 files changed, 1150 insertions(+), 77 deletions(-)。原 main 领先 1062 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41847150004)

**实际审查：**

已读 603 行实际生产 diff，检查 grpc helper/schema、MCP/owner 接线、HTTP literal export、代码生成拒绝条件和 load disconnect。

**整合判断：** 独有提交全 patch 等价且源文件已确认。gRPC 示例有结构/字节限制，遇 optional 递归省略并报告路径，必填循环拒绝，最终通过实际 serializer 校验而不调用业务 RPC。代码生成只返回文本、拒绝不能准确表达的传输设置；Python UTF-8 支持后续替代旧 ASCII 限制。历史七 shard 被当前更大矩阵继承。

**重点路径：** `src/core.mjs`、`src/grpc-request-example.mjs`、`src/grpc-schema.mjs`、`src/mcp.mjs`、`src/request-code-generation.mjs`、`src/server.mjs`

**代码锚点：** [src/grpc-request-example.mjs:5](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/grpc-request-example.mjs#L5)；[src/request-code-generation.mjs:60](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/request-code-generation.mjs#L60)；[src/server.mjs:76](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/server.mjs#L76)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 313. `wip/grpc-live-sessions-integration`

**结论：提交历史已纳入。** SHA：[`02004a2e43b0`](https://github.com/Hubujiu/local-api-workbench/tree/02004a2e43b032204115bc63352b00d931d550b4)；PR：无独立 PR。

**范围：** 多父 merge 中的 Base64/Mock 诊断和确定性预算回归

实际审查比较基线 `9d988c32fc56`；比较增量：8 files changed, 423 insertions(+), 79 deletions(-)。原 main 领先 950 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41259008534)

**实际审查：**

检查该三父 merge 的真实 first-parent 文件列表和相应预算/诊断断言。

**整合判断：** 分支名称容易误导：该 head 的独立 delta 是诊断和测试组合，不是新增另一套 gRPC live 产品实现。当前仍保留 Base64 拒绝 envelope 与 Mock 累计耗时测试；预算 fixture 控制 clock，只用于稳定重现，不调高产品限额。整个 head 已是候选祖先。

**重点路径：** `tests/native-mock-budget-static.test.mjs`、`tests/base64-phase-diagnostics-pure.test.mjs`

**代码锚点：** [tests/native-mock-budget-static.test.mjs:5](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/native-mock-budget-static.test.mjs#L5)；[tests/base64-phase-diagnostics-pure.test.mjs:9](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/base64-phase-diagnostics-pure.test.mjs#L9)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：没有因分支名称重复引入功能或退回老 gRPC 会话实现。

### 314. `wip/grpc-plan-scripts-integration`

**结论：提交历史已纳入。** SHA：[`78493b694747`](https://github.com/Hubujiu/local-api-workbench/tree/78493b6947474811b4e46b14e1978cf5f5cb569b)；PR：无独立 PR。

**范围：** 历史组合检查点：grpc-plan-scripts-integration

实际审查比较基线 `78493b694747`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 937 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41255989095)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享控制图使用当前 plan-step-types/plan-repeat/core；旧依赖选择性测试文件的等价断言位于 tests/plan-step-types-root.test.mjs，另保留生命周期测试。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 350 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 315. `wip/if-backend-integration`

**结论：提交历史已纳入。** SHA：[`533c62eeb5bf`](https://github.com/Hubujiu/local-api-workbench/tree/533c62eeb5bf511c80702a98130a6d0679dd7557)；PR：无独立 PR。

**范围：** IF 的 SDK revoke/cancel 证据在 JSON 持久化边界比较

实际审查比较基线 `d8fa00d1838b`；比较增量：3 files changed, 121 insertions(+), 2 deletions(-)。原 main 领先 1024 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41773438909)

**实际审查：**

已读 stored-json helper、两处 deepEqual 修改和完整 guard 测试。

**整合判断：** 祖先已含。仅把 expected 值经过 JSON roundtrip，贴合原存储自然丢弃 undefined object 字段的契约；actual readback 不被规范化。独立测试证明 defined 值、身份、状态、响应、repeat occurrence、条件证据或额外字段变更仍报错，没有以弱化断言掩盖证据丢失。

**重点路径：** `tests/helpers/stored-json.mjs`、`tests/stored-json-expectation.test.mjs`

**代码锚点：** [tests/helpers/stored-json.mjs:3](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/helpers/stored-json.mjs#L3)；[tests/stored-json-expectation.test.mjs:58](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/stored-json-expectation.test.mjs#L58)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 316. `wip/native-attribute-integration`

**结论：语义已整合或由后续实现替代。** SHA：[`ed9e4094fa1f`](https://github.com/Hubujiu/local-api-workbench/tree/ed9e4094fa1f84c62a26e076c48495076209e250)；PR：无独立 PR。

**范围：** 历史组合检查点：native-attribute-integration

实际审查比较基线 `4e734ff8a414`；比较增量：12 files changed, 1604 insertions(+), 4 deletions(-)。原 main 领先 1009 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享 native exporter 同时组合认证、继承、任务、属性、代码和描述验证；本轮20文件中的原生交换和owner回归验证组合入口。

**整合判断：** 非祖先且有 3 项非完全patch匹配提交；结合现存模块、入口接线及保留测试判定相关功能已按后续组合实现，旧分支不是待整批合入的新功能。 对照的 12 个变化路径中 8 个与候选文件完全同 blob。

**重点路径：** `src/apipost-sample-export.mjs`

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**direct_test_files**：tests/apipost-attribute-roundtrip.test.mjs

**available_branch_tests**：tests/apipost-attribute-catalogues-owner.test.mjs

tests/apipost-attribute-catalogues.test.mjs

tests/apipost-attribute-export-unit.test.mjs

tests/apipost-attribute-export.test.mjs

tests/apipost-attribute-roundtrip.test.mjs

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 317. `wip/oracle-lite-capability-probe`

**结论：隔离保留，不并入主线。** SHA：[`a1b879e327f0`](https://github.com/Hubujiu/local-api-workbench/tree/a1b879e327f0308b936935c0bcaa6a0e31e70f28)；PR：无独立 PR。

**范围：** 在未注册Oracle Thin客户端基础上增加精确Lite镜像的受限只读能力清单，不运行数据库或Oracle/Java工具。

实际审查比较基线 `88f70bb515c4`；比较增量：34 files changed, 5852 insertions(+)。原 main 领先 402 提交；原候选直接包含：否。

原分支精确 head 的 CI：**failure**。 [Oracle Lite Read-Only Capability Inventory / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/41466649833)

**实际审查：**

固定image digest、同库同ID且仅精确push分支、github-hosted Linux守卫；无PR/dispatch泛化入口。

容器使用只读根、network none、非root、cap-drop、无健康检查/挂载宿主内容，校验真实inspect限制后才start。

Python输出/时间/遍历上限与独立敏感路径分类，wallet只元数据不hash，cleanup要求唯一标签/ID和新匿名卷归属。

**整合判断：** 保留WIP/归档，禁止当作可用Oracle功能直接并入本次main候选

**发现/保留边界：**

实际run41466649833失败：日志inspectionComplete=false, runtimeAcceptance=false, databaseStarted=false, cleanupComplete=false；无成功能力扫描。

原Docker模板错误使用Id/NanoCpus而不是typed ID/NanoCPUs，回退raw map又触发缺省Mounts问题；后续inventory-code修复尚未验证。

继承的Oracle真实TCPS门槛仍失败，且branch没有任何产品provider注册。

**验证及限制：**

高（未完成实验路径）；不得以metadata/fake-driver证据宣称Oracle可用。

### 318. `wip/oracle-lite-inventory-code`

**结论：隔离保留，不并入主线。** SHA：[`a1b6e29e80ec`](https://github.com/Hubujiu/local-api-workbench/tree/a1b6e29e80ec691aa10509db35d6b136d37fd2d8)；PR：无独立 PR。

**范围：** 在probe上补typed Docker inspect模板、独立最小cleanup inspector及离线Go/Python模板前置门禁。

实际审查比较基线 `88f70bb515c4`；比较增量：36 files changed, 6325 insertions(+)。原 main 领先 404 提交；原候选直接包含：否。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

da36016把ID/NanoCPUs拼写修正，cleanup仅依赖归属/挂载，不再复用完整容器限制模板。

a1b6e29要求runner既有Go、禁下载工具链/模块、临时缓存，并且preflight成功才容器操作；collector二次要求passed标记。

workflow仍只由wip/oracle-lite-capability-probe触发，代码分支不会自动运行；无隐式新服务启用。

**整合判断：** 保留为Oracle后续工作的唯一代码检查点，不随稳定主线整合启用

**发现/保留边界：**

head a1b6e29没有任何Actions run；纯模板逻辑/文档不能冒充Docker实际成功和cleanup确认。

仍继承未注册Oracle模块及TCPS服务未验；Node child允许环境与trust-store的测试不是Oracle服务器验证。

该分支比probe多两个提交，若以后推进应基于此处，避免从已知有模板缺陷的probe重启。

**验证及限制：**

高（真实服务/镜像运行证据欠缺）；可审阅保留，不能声明交付。

### 319. `wip/plan-step-type-integration`

**结论：提交历史已纳入。** SHA：[`3269b3b99b30`](https://github.com/Hubujiu/local-api-workbench/tree/3269b3b99b30b0979a3ee20781fda92b000ced5b)；PR：无独立 PR。

**范围：** 历史组合检查点：plan-step-type-integration

实际审查比较基线 `3269b3b99b30`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 1012 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41604577750)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享控制图使用当前 plan-step-types/plan-repeat/core；旧依赖选择性测试文件的等价断言位于 tests/plan-step-types-root.test.mjs，另保留生命周期测试。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 275 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 320. `wip/postman-oauth1-integration`

**结论：提交历史已纳入。** SHA：[`8f42653300e2`](https://github.com/Hubujiu/local-api-workbench/tree/8f42653300e25cad795c51dcb4d7f755e5148f34)；PR：无独立 PR。

**范围：** Postman OAuth1 根集成的 header version fixture 修正

实际审查比较基线 `edcac5815122`；比较增量：1 file changed, 2 insertions(+), 1 deletion(-)。原 main 领先 1030 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41784383391)

**实际审查：**

已读最后完整差异（两个 fixture 行）及相邻授权语义说明。

**整合判断：** 祖先已含。header 模式 fixture 明确提供 version1.0，expected 与输入一致；auto 模式仍为空 version。变更局限测试输入/期待，不放宽 signer 对受支持 OAuth1 policy 的限制。

**重点路径：** `tests/postman-oauth1-root-sdk.test.mjs`

**代码锚点：** [tests/postman-oauth1-root-sdk.test.mjs:90](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/postman-oauth1-root-sdk.test.mjs#L90)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 321. `wip/raw-media-root-20261104`

**结论：提交历史已纳入。** SHA：[`81398a4fc23d`](https://github.com/Hubujiu/local-api-workbench/tree/81398a4fc23df5409e27b2aa12d2a72ae322d1c2)；PR：无独立 PR。

**范围：** Postman raw media 的 owner 执行、冻结计划、恢复组合回归

实际审查比较基线 `5e0246af0f43`；比较增量：2 files changed, 724 insertions(+), 2 deletions(-)。原 main 领先 1032 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41792894153)

**实际审查：**

检查该 head 测试的 XML→form→raw 真实 HTTP、live edits 与 backup reopen 主场景以及拒绝边界。

**整合判断：** 祖先已含。测试确认 script 转回 raw 且未提供 language 时应重置旧 XML marker，实际 wire 是 text/plain；定义原值和冻结计划不受 live 修改影响，restore/restart 不重放。另验证未选择的媒体不支持项不能影响其他 scope，数据库调用保持零。

**重点路径：** `tests/postman-raw-media-root.test.mjs`

**代码锚点：** [tests/postman-raw-media-root.test.mjs:240](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/postman-raw-media-root.test.mjs#L240)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：最后 checkpoint 仅增加集成回归，不需独立功能 merge。

### 322. `wip/read-revocation-integration`

**结论：提交历史已纳入。** SHA：[`e84c67891a40`](https://github.com/Hubujiu/local-api-workbench/tree/e84c67891a405776213b1202ee6e050647de635f)；PR：无独立 PR。

**范围：** 数据库 session revoke 的真实消费者回归合约整合

实际审查比较基线 `6c82c715c2bd`；比较增量：1 file changed, 29 insertions(+), 11 deletions(-)。原 main 领先 1028 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41779105016)

**实际审查：**

已读最后 29/+11 行差异和完整 cases 列表；核对 source-native task 提前缩减、repeat occurrence、connectionId 断言。

**整合判断：** 祖先已含。synthetic native fixture 在 import 前选取任务，避免导入后编辑 runtime 图使 source 与计划脱节；canonical continue 被表示为 omitted，stop 明确保留。补上完整 repeat 与数据库查询归属断言。部分重复 stop case 改为 sdk-cancel/disable-execute，不能误读为删除整个 revoke/rotate 覆盖。

**重点路径：** `tests/database-session-revoke-consumers.test.mjs`

**代码锚点：** [tests/database-session-revoke-consumers.test.mjs:129](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/database-session-revoke-consumers.test.mjs#L129)；[tests/database-session-revoke-consumers.test.mjs:497](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/database-session-revoke-consumers.test.mjs#L497)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 323. `wip/redis-ssh-root-checkpoint`

**结论：提交历史已纳入。** SHA：[`74d959ae7777`](https://github.com/Hubujiu/local-api-workbench/tree/74d959ae7777cf9d030b5b994230fe2b03889fa1)；PR：无独立 PR。

**范围：** Redis 未支持 SSH 时拒绝直连回退的旧根 checkpoint

实际审查比较基线 `04ca82002364`；比较增量：3 files changed, 187 insertions(+)。原 main 领先 1000 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

已读实际 3 行 guard 与当前 Redis/SSH 执行分派。

**整合判断：** 祖先已含但 blanket guard 随后由验证 host-key 的 Redis SSH 功能替代。应保留当前明确支持的 tunnel 路径与 no-fallback 原则；重新 cherry-pick 旧 guard 会错误关闭已完成的 SSH 特性。与 fix/redis-write-lifecycle 的当前所有权审查共享证据。

**重点路径：** `src/redis.mjs`

**代码锚点：** [src/redis.mjs:6](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/redis.mjs#L6)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 324. `wip/scoped-binary-integration`

**结论：提交历史已纳入。** SHA：[`5f7ebe26d125`](https://github.com/Hubujiu/local-api-workbench/tree/5f7ebe26d125d969f1058f6b77c2b020556472e3)；PR：无独立 PR。

**范围：** native 二进制 protocol 的 scoped/manual 双代导入导出组合

实际审查比较基线 `4aef1fcb1769`；比较增量：2 files changed, 638 insertions(+)。原 main 领先 1052 提交；原候选直接包含：是。

原分支精确 head 的 CI：**cancelled**。 [Validate Local API / cancelled](https://github.com/Hubujiu/local-api-workbench/actions/runs/41822086219)

**实际审查：**

读当前真实 owner 测试的 preview/apply、编码拒绝、history、backup/frozen wire 边界。

**整合判断：** 祖先已含。同一源范围分别经过 scoped export 与手工预览 token/apply，验证另项目磁盘不变；base64/hex/mode/模板/压缩混淆拒绝且无副作用。两代 artifact 与冻结 wire 按字节比对，不能把 binary 当普通 UTF-8 字符串。最后 checkpoint 只补组合测试。

**重点路径：** `tests/native-binary-interchange-integration.test.mjs`

**代码锚点：** [tests/native-binary-interchange-integration.test.mjs:284](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/native-binary-interchange-integration.test.mjs#L284)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 325. `wip/scoped-export-integration`

**结论：提交历史已纳入。** SHA：[`c6b0c254e7a3`](https://github.com/Hubujiu/local-api-workbench/tree/c6b0c254e7a35638a38ec83f151b807d5afba404)；PR：无独立 PR。

**范围：** scope 导出与手工 URL overwrite 导入组合

实际审查比较基线 `21f50d9fd1b5`；比较增量：2 files changed, 1010 insertions(+), 3 deletions(-)。原 main 领先 1050 提交；原候选直接包含：是。

原分支精确 head 的 CI：**no-exact-head-run**。 未找到运行，不以同功能其他头代替。

**实际审查：**

读 owner 预览/接受 token、metadata 隔离、真实磁盘不变及 retained samples/models 主路径。

**整合判断：** 祖先已含。成功和被拒的 preview/export 均不写盘；apply 只更新已选 API、保留未选 raw 定义和 peer，失效 acceptance 不被复用。两次生成与 reopen/re-export 保持样例/model 语义，数据库定义只能重绑而不夹带凭据。

**重点路径：** `tests/scoped-export-import-integration.test.mjs`

**代码锚点：** [tests/scoped-export-import-integration.test.mjs:569](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/scoped-export-import-integration.test.mjs#L569)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 326. `wip/script-mock-integration`

**结论：提交历史已纳入。** SHA：[`dbdb29f6ee43`](https://github.com/Hubujiu/local-api-workbench/tree/dbdb29f6ee4351a5abfe74335dad72ede9d8f15c)；PR：无独立 PR。

**范围：** 许可声明和有界 JSON 子集 Mock 的整合 merge

实际审查比较基线 `64a88bd1ffd7`；比较增量：16 files changed, 901 insertions(+), 71 deletions(-)。原 main 领先 986 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/41428642026)

**实际审查：**

已读 first-parent 432 行源改动，包含构建 provenance、private generator、facade intrinsic guards 和失败诊断。

**整合判断：** 祖先已含。去掉全包 bootstrap，改成带保留版权/MIT notices 和上游区段 hash 的 admitted JSON 子集；支持项生成顺序与上游随机抽样一致。generator 仅接受 facade 已校验的新 owned clone，captured natives 避免公有 prototype 修改；输入观察后再次 guard，再预留总预算。

**重点路径：** `scripts/build-script-mock.mjs`、`scripts/script-mock-entry.mjs`、`scripts/script-mock-source.json`、`src/script-mock-asset.mjs`、`src/script-mock-budget.mjs`、`src/script-mock-core.mjs`、`src/script-mock-template.mjs`、`src/script-worker.mjs`、`src/vendor/script-mock-library.json`

**代码锚点：** [src/script-mock-core.mjs:14](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/script-mock-core.mjs#L14)；[scripts/build-script-mock.mjs:10](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/scripts/build-script-mock.mjs#L10)；[src/script-mock-template.mjs:401](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/script-mock-template.mjs#L401)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：保留许可来源不等于承诺整个第三方包 API 兼容；明确仅支持 admitted 子集。生成 bundle 未逐字人工审，已读构建输入与 provenance。

### 327. `wip/script-mock-templates-revision`

**结论：提交历史已纳入。** SHA：[`023fdd27f2e8`](https://github.com/Hubujiu/local-api-workbench/tree/023fdd27f2e89bf12f01acd7d285ff8b6575e9cd)；PR：无独立 PR。

**范围：** 有界 Mock 子集生成资产、跨平台行尾和来源说明修订

实际审查比较基线 `b2d8b26054fb`；比较增量：6 files changed, 126 insertions(+), 11 deletions(-)。原 main 领先 419 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41427920584)

**实际审查：**

核对 023fdd2 资产与 manifest、build-script-mock 来源区段规则，关联 merge dbdb29f 的相同核心。

**整合判断：** 祖先且已被 script-mock-integration merge。生成 bundle manifest 标识 modified-admitted-json-subset，记录 sourceRanges、derivation hash 与每个本地输入 hash，line-ending 规则保障跨平台来源一致。无需单独再导入旧 vendor 产物。

**重点路径：** `src/vendor/script-mock-library.json`、`scripts/script-mock-source.json`

**代码锚点：** [src/vendor/script-mock-library.json:4](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/vendor/script-mock-library.json#L4)；[scripts/script-mock-source.json:6](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/scripts/script-mock-source.json#L6)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：generated JavaScript 与 wasm 类似，人工审源码/构建/manifest，而非对 minified 字节宣称完整人工逐行审查。

### 328. `wip/sdk-xml-observation`

**结论：提交历史已纳入。** SHA：[`ff7cff175964`](https://github.com/Hubujiu/local-api-workbench/tree/ff7cff1759641f0084a4d5b32a2d97391d946808)；PR：无独立 PR。

**范围：** SDK XML 诊断组合中的空 query 分隔符代码生成 guard

实际审查比较基线 `a0f4fa750d0e`；比较增量：3 files changed, 12 insertions(+), 1 deletion(-)。原 main 领先 1061 提交；原候选直接包含：是。

原分支精确 head 的 CI：**cancelled**。 [Validate Local API / cancelled](https://github.com/Hubujiu/local-api-workbench/actions/runs/41843613163)

**实际审查：**

已读最后完整生产 diff 和 request-code-generation 当前 guard。

**整合判断：** 祖先已含。http://host/path? 与无 ? 可有不同 wire 语义；代码生成器不能保留空 delimiter 时应在导出前拒绝。该 checkpoint 同时继承此前 XML 有界失败诊断与 load 客户端断开取消，不代表另一套待合功能。

**重点路径：** `src/request-code-generation.mjs`

**代码锚点：** [src/request-code-generation.mjs:66](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/request-code-generation.mjs#L66)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 329. `wip/sqlite-ci-baseline`

**结论：补丁等价已纳入。** SHA：[`72f27d678de0`](https://github.com/Hubujiu/local-api-workbench/tree/72f27d678de00ae11e917ad36a5585de77db6023)；PR：无独立 PR。

**范围：** SQLite 诊断分支合入已固定 CI isolation baseline 的 checkpoint

实际审查比较基线 `5e1354b1b5a4`；比较增量：15 files changed, 1813 insertions(+), 101 deletions(-)。原 main 领先 411 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41441664838)

**实际审查：**

与 fix/sqlite-process-diagnostics 的实际生产 diff 和同 blob module 比较，并检查 CI/worker baseline 依赖。

**整合判断：** 非祖先但剩余 commits 全 patch 等价；SQLite 产品差异与 PR15 完全同一修复，独立模块保留。head 额外 merge 的 CI baseline 已由当前核心 runner/sharding 后续接管，不应为这条旧 checkpoint 降级 matrix 或再导入诊断脚手架。

**重点路径：** `src/database-execution-worker.mjs`、`src/database-process-entry.mjs`、`src/database-process.mjs`、`src/database.mjs`、`src/server.mjs`、`src/sqlite-operation-progress.mjs`、`src/sqlite-process-diagnostics.mjs`

**代码锚点：** [src/sqlite-operation-progress.mjs:4](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/sqlite-operation-progress.mjs#L4)；[src/database-process-entry.mjs:79](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/database-process-entry.mjs#L79)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 330. `wip/sqlite-operation-diagnostics`

**结论：提交历史已纳入。** SHA：[`17600cf056e3`](https://github.com/Hubujiu/local-api-workbench/tree/17600cf056e32c48a7f019e5c3c8e3a87fd2b9b8)；PR：无独立 PR。

**范围：** SQLite 诊断 IPC 抛错/耗尽时不损坏真实结果通道的回归

实际审查比较基线 `5e89c1378717`；比较增量：1 file changed, 59 insertions(+)。原 main 领先 401 提交；原候选直接包含：是。

原分支精确 head 的 CI：**failure**。 [Validate Local API / failure](https://github.com/Hubujiu/local-api-workbench/actions/runs/41262211332)

**实际审查：**

已读最后 59 行测试 diff，真实 worker/tracker 配 fake 数据库与 supervisor/host 双边界。

**整合判断：** 祖先已含。诊断 postMessage 单独抛错时，正常 result/error 仍按原通道返回；恶意超额 operation-stage 包内伪造 result/payload 不能升级为业务成功，后来的合法 result envelope 仍可到达。测试明确标注 fake database，不冒充真实 SQLite 事务成功证明。

**重点路径：** `tests/sqlite-diagnostics.test.mjs`

**代码锚点：** [tests/sqlite-diagnostics.test.mjs:280](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/sqlite-diagnostics.test.mjs#L280)；[tests/sqlite-diagnostics.test.mjs:318](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/sqlite-diagnostics.test.mjs#L318)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 331. `wip/sqlite-ssh-root-checkpoint`

**结论：提交历史已纳入。** SHA：[`3edac584c5b2`](https://github.com/Hubujiu/local-api-workbench/tree/3edac584c5b2d488ea0e765dc092fff991504d3f)；PR：无独立 PR。

**范围：** SQLite unsupported SSH 拒绝落入整合根

实际审查比较基线 `77f0b70c4661`；比较增量：3 files changed, 239 insertions(+)。原 main 领先 1002 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41588933101)

**实际审查：**

已读 first-parent server guard，和 fix/sqlite-ssh-dispatch-boundary 当前相同语句比较。

**整合判断：** 祖先已含。守卫在 allowWrite 读写分派之前，因此既不能本机误读，也不能本机误写。它是原修复落根的 checkpoint，和原非祖先 fix/ 分支不应重复应用。

**重点路径：** `src/server.mjs`

**代码锚点：** [src/server.mjs:2136](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/server.mjs#L2136)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 332. `wip/store-missing-file-integration`

**结论：提交历史已纳入。** SHA：[`aa75ff6a2a59`](https://github.com/Hubujiu/local-api-workbench/tree/aa75ff6a2a5968ceb4065a05e0fc6bdfc5ce012d)；PR：无独立 PR。

**范围：** required-file 更新拒绝及 legacy restore fixture 的根集成说明

实际审查比较基线 `dac552cb26cd`；比较增量：1 file changed, 16 insertions(+), 2 deletions(-)。原 main 领先 996 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41437078805)

**实际审查：**

读取最后文档改动及此前 store diff，关联已深入审查的 PR17 与 missing-file-save。

**整合判断：** 祖先已含生产修复；末提交只保留曾失败 CI 证据，解释 legacy fixture 必须先合法恢复，再测试 update/权限。使用 Store.restore 是创建新项目的显式语义，不得为了旧 fixture 把 save 重新改为 upsert。官方 SDK 两份遗漏回归由本次单独补齐。

**重点路径：** `docs/STORE-RESTORE-INTEGRATION-AUDIT.md`

**代码锚点：** [docs/STORE-RESTORE-INTEGRATION-AUDIT.md:1](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/docs/STORE-RESTORE-INTEGRATION-AUDIT.md#L1)

**验证及限制：**

**this_review_execution**：**command**：node --test tests/project-missing-file-sdk.test.mjs

**working_tree_commit**：858d562c50df0b9e492bc7e7169b11ad383822a3

**base_commit**：2532d67136fbc89000ecaf079f826ed229600e86

**environment**：Node v24.22.1, Linux x64

**tests**：4

**pass**：4

**fail**：0

**skipped**：0

**duration_ms**：5674.970127

**evidence_file**：storage-sdk-regression-final.tap

**reuse_note**：同一组真实SDK补强场景覆盖三条关联历史；不计为每条分支各自重新运行。

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：历史 CI 失败保留不等于当前持续失败；当前代码和本次四个 SDK 场景通过应分别陈述。

### 333. `wip/store-missing-file-save`

**结论：语义已整合或由后续实现替代。** SHA：[`12e8a961c4c1`](https://github.com/Hubujiu/local-api-workbench/tree/12e8a961c4c1d1d7f1e9a86c991c03a4fa251013)；PR：无独立 PR。

**范围：** Store.save 必需文件丢失时拒绝旧覆盖的原始工作分支

实际审查比较基线 `82336c421e97`；比较增量：9 files changed, 770 insertions(+), 39 deletions(-)。原 main 领先 407 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41435755904)

**实际审查：**

已读 177 行实际生产 diff 和 current Store 写入前 read/optimistic 规则；与 PR17 合并审查。

**整合判断：** 非祖先但功能已由 store-missing-file-integration 和 PR17 对应后续提交集成。源码差异来自 definition-history hooks 和 explicit restore API，非 silent create 退化。旧 HTTP/createMCP 回归仍在；新增官方 SDK 端到端补强同样覆盖这条修复的风险。

**重点路径：** `src/runtime.mjs`、`src/server.mjs`、`tests/project-missing-file-http.test.mjs`

**代码锚点：** [src/runtime.mjs:965](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/src/runtime.mjs#L965)；[tests/project-missing-file-http.test.mjs:98](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/project-missing-file-http.test.mjs#L98)

**验证及限制：**

**this_review_execution**：**command**：node --test tests/project-missing-file-sdk.test.mjs

**working_tree_commit**：858d562c50df0b9e492bc7e7169b11ad383822a3

**base_commit**：2532d67136fbc89000ecaf079f826ed229600e86

**environment**：Node v24.22.1, Linux x64

**tests**：4

**pass**：4

**fail**：0

**skipped**：0

**duration_ms**：5674.970127

**evidence_file**：storage-sdk-regression-final.tap

**reuse_note**：同一组真实SDK补强场景覆盖三条关联历史；不计为每条分支各自重新运行。

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。

### 334. `wip/trusted-bundle-bytecode`

**结论：隔离保留，不并入主线。** SHA：[`a423f480b1c5`](https://github.com/Hubujiu/local-api-workbench/tree/a423f480b1c52f40c7e7669a2b0ada6a77ac0eee)；PR：[#37](https://github.com/Hubujiu/local-api-workbench/pull/37)。

**范围：** QuickJS 私有受信 bytecode 与 lazy schema 加载实验

实际审查比较基线 `05c8f5834285`；比较增量：50 files changed, 7780 insertions(+)。原 main 领先 408 提交；原候选直接包含：否。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/40448807120)

**实际审查：**

读实际实验 lazy-schema、private bridge/runtime 和 retained failure 文档；核对 experiments 整棵树在候选缺失，非等价漏 merge。

**整合判断：** 明确不并入主线。原分支保留尚未解决的 13 MiB guest pressure +16 MiB heap 场景：source lazy init 触发 QuickJS update_label assertion、C-to-host RangeError 与 dispose gc assertion。bytecode 单例正常失败和较小 source 压力成功不能证明等价。实验默认关闭，生产脚本未采用，适合保留归档 branch/tag 供后续修复，不能为“只留一条分支”牺牲该事实。

**重点路径：** `experiments/trusted-bytecode/evidence/lazy-source-13mib-oom.md`、`experiments/trusted-bytecode/lazy-schema.mjs`

**代码锚点：** [experiments/trusted-bytecode/evidence/lazy-source-13mib-oom.md:4](https://github.com/Hubujiu/local-api-workbench/blob/a423f480b1c52f40c7e7669a2b0ada6a77ac0eee/experiments/trusted-bytecode/evidence/lazy-source-13mib-oom.md#L4)；[experiments/trusted-bytecode/lazy-schema.mjs:12](https://github.com/Hubujiu/local-api-workbench/blob/a423f480b1c52f40c7e7669a2b0ada6a77ac0eee/experiments/trusted-bytecode/lazy-schema.mjs#L12)

**发现/保留边界：**

**severity**：P1

**path**：experiments/trusted-bytecode/evidence/lazy-source-13mib-oom.md

**line**：4

**title**：保留未解决 parser/assertion 失败的实验，不具备生产合并依据

**evidence**：分支明确记录 Node24.22.1/Linux 下 13MiB guest pressure、16MiB heap、512KiB stack、250ms active 的 source lazy init 出现 update_label assertion、C-to-host RangeError、JS_FreeRuntime assertion；文档自称 unresolved。

**reproduction**：原文保留 exact standalone command；本次仅源码/历史证据审查，没有重跑。该诊断没有常规2秒worker supervisor，完整raw日志和exit code未保留，范围仍需隔离重现与生产对照。

**status**：excluded_from_consolidation

**recommendation**：归档或保留原分支/tag，不 merge 实验或启用其生产路径；修复并完成独立隔离回归后再评估。

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：这是原分支文档保留的历史观察，不是本次独立复现；原始完整 stdout/stderr 与 exit code 没保存，精确生产影响未确定。没有重新跑未隔离 OOM，也没有把失败路径悄悄开启。

### 335. `wip/wire-plan-scripts-integration`

**结论：提交历史已纳入。** SHA：[`bef86c21d34d`](https://github.com/Hubujiu/local-api-workbench/tree/bef86c21d34d0830824c198af1c3730097cce9b2)；PR：无独立 PR。

**范围：** 历史组合检查点：wire-plan-scripts-integration

实际审查比较基线 `bef86c21d34d`；比较增量：该头为已包含检查点，无独立树差异。原 main 领先 977 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41266189470)

**实际审查：**

这是已有功能的依赖/组合快照，不是需要重新实施的独立功能；核对了提交包含关系、原始变更路径和候选对应 blob。核心功能按同名或相关 feat 分支的接线与回归结论继承，不能把旧累计树作为整份替换覆盖较新的候选。 共享控制图使用当前 plan-step-types/plan-repeat/core；旧依赖选择性测试文件的等价断言位于 tests/plan-step-types-root.test.mjs，另保留生命周期测试。

**整合判断：** 该精确 SHA 是候选祖先，候选比此头多 310 个提交；保留候选即可带入历史，不再制造重复合并。

**验证及限制：**

**candidate_batch**：20 files / 165 passed / 0 failed, cancelled or skipped / 25373.52ms / Node v24.22.1

**batch_log**：native-protocol-targeted.tap

**limits**：旧独立分支未逐一checkout运行；本轮验证当前整合候选，未声称逐行审完全部累计源码，也未声称外部数据库/各平台真实安装完成。

### 336. `wip/xml-result-diagnostics-integration`

**结论：提交历史已纳入。** SHA：[`3875f89be57b`](https://github.com/Hubujiu/local-api-workbench/tree/3875f89be57bc6cc0c9cb8c0708773b7799bcf13)；PR：无独立 PR。

**范围：** XML 组合工作流的 bounded 执行结果诊断

实际审查比较基线 `c7a06402727e`；比较增量：4 files changed, 1024 insertions(+), 28 deletions(-)。原 main 领先 1054 提交；原候选直接包含：是。

原分支精确 head 的 CI：**success**。 [Validate Local API / success](https://github.com/Hubujiu/local-api-workbench/actions/runs/41830574952)

**实际审查：**

读 test helper 的 allowlist/captured natives、原失败身份保留用例及 workflow 断言接入；与 backend 同 SHA。

**整合判断：** 祖先且与 wip/backend-integration 完全相同。诊断计数/字节/包数上限避免失败时输出请求正文、私有字段或恶意 getter；同步断言包装不接受 Promise/thenable。original exception、actual/expected/operator 与 pass/fail 均保持，缺失指标不伪造为零。两个分支可视为同一历史 checkpoint 的两个名字。

**重点路径：** `tests/helpers/execution-result-diagnostics.mjs`、`tests/execution-result-diagnostics.test.mjs`

**代码锚点：** [tests/helpers/execution-result-diagnostics.mjs:11](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/helpers/execution-result-diagnostics.mjs#L11)；[tests/execution-result-diagnostics.test.mjs:394](https://github.com/Hubujiu/local-api-workbench/blob/2532d67136fbc89000ecaf079f826ed229600e86/tests/execution-result-diagnostics.test.mjs#L394)

**验证及限制：**

**static_test_review**：检查改动测试的存在性/后续适配，重点场景读取实际断言；未对70个旧分支分别checkout并执行完整测试。

**ci_baseline**：主审查已核验原候选2532d67同树46/46 jobs成功；本子审查不将其写作70个历史头分别通过或新整合头已通过。

**specific_limits**：除明确列出的SDK测试外，本条以源码/diff/现有回归结构和候选集成证据审查；未单独运行此历史分支的全部测试。
