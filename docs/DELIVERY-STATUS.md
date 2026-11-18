# 交付状态与验收索引

## 当前主线与整合证据

[整合 PR #280](https://github.com/Hubujiu/local-api-workbench/pull/280) 已进入 `main` 的 `f3254e6aa61d399acc8b4d1485d787a537a75251`。该合并提交的文件树与候选 `25865de` 相同，但合并前的候选验收和 [main 自身运行](https://github.com/Hubujiu/local-api-workbench/actions/runs/44273358459) 分开记账。主线实时便携下载及 SHA-256 由 `node scripts/delivery-index.mjs` 读取，只有 main 检查与产物可用时才作为当前主线下载。

| 范围 | 已实现与实测 | 尚需的证据 |
| --- | --- | --- |
| 协议恢复 | TCP、WebSocket、gRPC 流和 Socket.IO 的创建、发送或确认可以根据各自的回执重查。Socket.IO 的真实网络用例覆盖创建和发送响应丢失、重复提交拒绝。 | 当前集成提交的三平台界面与桌面运行 |
| MCP 数据库 | 设置页支持按项目授予、列出和撤销临时权限。SQL Server 2022 CU22 与 Oracle 26ai Free 23.26.4 在同一候选 `25865de` 通过 [SQL Server](https://github.com/Hubujiu/local-api-workbench/actions/runs/44268567987/job/134679118512) 和 [Oracle](https://github.com/Hubujiu/local-api-workbench/actions/runs/44268567987/job/134679118995) 实库测试，涵盖 TLS、精确数值及各自的只读边界。DM8 双向 TLS、精确小数、二进制、绑定顺序、撤权及错误 CA 的隔离实库记录见[企业数据库接入](ENTERPRISE-DATABASE-PREVIEW.md)。 | `25865de` 的托管工作流[跳过 DM8](https://github.com/Hubujiu/local-api-workbench/actions/runs/44268567987/job/134679121257)，不计为托管实库复验。 |
| Windows | `25865de` 的 [Windows 11 ARM64 普通账户测试](https://github.com/Hubujiu/local-api-workbench/actions/runs/44268567980/job/134681877835)使用 x64 测试 MSI，通过首次安装、升级失败后恢复旧版、正常升级、卸载及重装；完整记录见下。 | 原生 Windows 11 x64 普通账户及最终签名介质仍需完整验收。 |
| 原生往返 | 冻结继承认证、仅 schema 响应定义、冻结数据库任务来源和顺序、Redis GET/HGET/EXISTS、MongoDB findone 已实现。两种导出格式均有跨两代重导入的回归测试。 | 原厂同版本运行证据及非空原生自动化图的设置、引用与调度语义 |

数据库字段与实库复现步骤见[企业数据库接入](ENTERPRISE-DATABASE-PREVIEW.md)。签名和草稿入口见 [Windows 正式发行](WINDOWS-RELEASE.md)。

### 合并前的精确候选验收

- 集成候选 `25865de0def4919b238ecc77a7cb948210d6596a`：[required 汇总](https://github.com/Hubujiu/local-api-workbench/actions/runs/44268568032/job/134686951127)及同轮 47 个任务均通过。该工作流不包含独立的 Windows 产品安装旅程或企业实库验收。
- Windows 普通账户候选 `25865de0def4919b238ecc77a7cb948210d6596a`：下载核对过的[原始证据](https://github.com/Hubujiu/local-api-workbench/actions/runs/44268567980/artifacts/14414410105) SHA-256 为 `d8883bc7f9b4f180c8a4aa19666fb5ad2fad94b10af2b3974e26156e0cc56b71`。记录显示宿主为 ARM64，软件包为 x64，账号非管理员，且未验证签名。故障注入返回预期的 1603；安装器随后使用原始介质成功恢复 0.1.0，验证了旧版启动以及项目和历史记录保留，之后正常升级、卸载、重装并最终清理。此结果只覆盖该候选和环境，不替代原生 x64 或发行签名验收。

## 历史候选记录


更新：2026-11-18。当前单机版基线、免费边界和待闭环验收见[单机功能对照](STANDALONE-PARITY.md)。下列各次历史 CI 仍按原日期记账。这里区分“已实现”“精确候选已验证”和“完整产品已交付”。当前仍在开发，尚未正式发行；不按 PR 数量或测试数量计算完成率。

## #280 合并前的主线基线

- `main` 精确提交 `f59b11ac3dc96c567db155dd871ef08ba445937c`，tree `4869acc4fc433b16b1d6b62750c310884c6f2f96`，由 [#264](https://github.com/Hubujiu/local-api-workbench/pull/264) 合并；[主线 CI](https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449) 47/47 jobs 成功，46 个产物。不能把当前文档 PR 或后续功能 PR 视为继承这一结果。
- [Windows 下载验证](https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449/job/134209852416)、[macOS 下载验证](https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449/job/134209852333)、[Linux 下载验证](https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449/job/134209852444)及[汇总闸门](https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449/job/134215707659) 均成功。平台包、外层摘要和到期时间见[单一下载入口](PORTABLE-QUICKSTART.md)。这不是原生 Windows 生命周期、完整产品验收或正式发行。
- [历史分支归档及清理](https://github.com/Hubujiu/local-api-workbench/actions/runs/44219019196)成功；新功能仍以 `main` 开短期任务分支。仓库端规则与 CI 是不同机制；已核对 `main` 的有效规则和检查绑定，见 [main 保护配置](MAIN-PROTECTION.md)。

## 开发候选的增量验收（未合入 main）

- [MCP 数据库授权与撤销 #272](https://github.com/Hubujiu/local-api-workbench/pull/272)：
  head `8130184a1289e21bf645a32f47a6e48abfc85dd3` 的 [浏览器 job](https://github.com/Hubujiu/local-api-workbench/actions/runs/44230620400/job/134557143937)
  通过 UI smoke 与重启旅程。这个结果不替代各真实远程数据库的兼容验收。
- [Windows 安装产品旅程 #277](https://github.com/Hubujiu/local-api-workbench/pull/277)：
  测试 head `a44afb8b5c213860d1905d64c3e87c202c5451be` 以同一安装家族编译了真实
  0.1.0 → 0.1.1 产品候选。GitHub 托管 Windows 上，0.1.0 首次安装返回码为 0，
  安装后首启、无效导入恢复及测试项目保存已执行。原 [Windows job](https://github.com/Hubujiu/local-api-workbench/actions/runs/44230439530/job/134559218749)
  在升级步骤 120 秒超时。已核对 [日志归档](https://github.com/Hubujiu/local-api-workbench/actions/runs/44230439530/artifacts/14395148631)
  SHA-256 `3d6fca933847b06abc98db9f78fb4c8e11e03b21243e741bf5b9c08070f224bb`：
  到期后 Windows Installer 服务仍记录文件复制，未确认升级终态；此轮不重试、不拆除证据，升级、卸载、回滚及普通用户均不能据此记为通过。

## 历史精确已验证候选

| 候选                                                                                       | 精确 head                                  | 原 CI                                                                                            | 已核结果                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| [#247](https://github.com/Hubujiu/local-api-workbench/pull/247) 手动执行历史刷新及延迟 GET | `794cff388991bcb4535aebc3810e8bac118ddaca` | [43674731764](https://github.com/Hubujiu/local-api-workbench/actions/runs/43674731764) attempt 1 | 46/46 成功；真实浏览器 GUI 先开再 MCP、延迟 GET 往返标签/无隐藏采用；三平台下载后正常及崩溃重启通过。已由当前 main 基线替代 |
| [#235](https://github.com/Hubujiu/local-api-workbench/pull/235) 协议历史筛选               | `ad2182e9582421d3dfa38548ef80720f1e4c9bb7` | [43425542187](https://github.com/Hubujiu/local-api-workbench/actions/runs/43425542187)           | 46/46 jobs 成功；真实筛选浏览器旅程、历史详情/显式导出及 Socket.IO 旅程，三平台 Electron 正常/崩溃重启及下载归档通过        |
| [#234](https://github.com/Hubujiu/local-api-workbench/pull/234) 单条已保存记录显式导出     | `2dffce796b8233b64d29a5a0d5ea0ff0d6305c5a` | [43415860765](https://github.com/Hubujiu/local-api-workbench/actions/runs/43415860765)           | 独立的 46/46 jobs 成功；真实导出浏览器、三平台重启与下载归档通过                                                            |

#247 tree：`f3eff2505633cc2afb013834f70ceddd057e6280`；CI checkout merge commit `a71e019b9c399fa2b9c11a2ee9fd47178e17ebc0` 经 API 核对与 head 同树。browser job `132692289722` 有 2 次 `PLAN_HISTORY_REFRESH_HELD_BROWSER_PASS` 及成功/失败停止两条 `PLAN_HISTORY_REFRESH_BROWSER_PASS`。三平台实际下载旅程 jobs 为 Windows `132693804325`、Linux `132693804346`、macOS `132693804383`，均有正常/崩溃重启 marker。元数据与日志已于 2026-11-15 读取；这不是本机浏览器或完整本地全量通过声明。本次 docs-only 提交不继承该 head 的 CI 状态。

#235 attempt 1 的 CI checkout 为 merge commit `ee5b3fb6c0e59ae06419498caf55baf9a3fa9aab`，与 head 同树。实际下载归档 Linux `14038290285`、macOS `14038410391`、Windows `14036692260` 的内容、head/hash 以及正常/崩溃重启日志已核。

#235 tree：`2782bdaff432c3e0ef3df3d45d32b93cbb92c334`，基于 #234。两次 CI 分别记账，不用父提交的成功替代新提交验证。本文件所在的文档提交不是上述 head；其自身 CI 需独立检查，不能继承为已通过。

#235 聚焦回归与独立复验各 72/72；本地 Chromium 启动遇到 socket EPERM，未声称本地真实浏览器通过，真实浏览器证据来自上述 CI。没有 #235 本地全量测试通过的可靠记录。#230 本地 full 也仍无可靠终态证据，不补写为通过。

## 不混用三个验收范围

下列分类用于准确核验，不撤销用户已明确要求的能力，也不以外部产品删减为理由缩小 Workbench 范围。

| 范围                                   | 验收口径                                                                                                                                              | 当前边界                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Apipost 单机版基础对照                 | [官方单机帮助](https://offline.apipost.net/help/)列出常用 API 工作流，区分其未保留的测试角色自动化/在线协作，并明确新增 MCP。不能因此推断没有 CLI/MCP | 按用户已约定基础功能逐项对照，网页描述不是本产品验收证据                                        |
| Workbench 原生 Agent 执行计划          | 用户明确要求，现行[单机 AI 执行计划](https://offline.apipost.net/help/executions/)也列入对照，独立验收正式 MCP、可视化计划、执行证据和人可读界面      | 不因单机对照产品的范围而取消；现有局部旅程仍须精确整体验收                                      |
| 联网版非空 automated_testings 格式迁移 | [联网版定价页](https://www.apipost.cn/pricing/)把自动化列在个人版能力中；该页面不能用于推导单机版合同或免费格式兼容许可                               | 当前额外格式迁移仍不支持；已有结构样本但未闭合执行/往返语义，继续按明确用户范围推进而非冒称兼容 |

总览和联网定价页面于 2026-11-15 只读核对；2026-11-17 再核实单机 MCP 2.0 与 AI 执行计划官方专页。单机产品定位、联网服务定价、Workbench 用户需求是三个不同来源，不互相覆盖。

## 功能与证据边界

| 能力                      | 状态及边界                                                                                                                            | 验收入口                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 已加载协议历史筛选        | 已实现且 #235 CI 验证。协议、原始状态/会话状态、完整保存 JSON 字面查询作 AND 筛选；只筛已加载记录，非服务端全历史搜索，不发送业务请求 | #235 原运行中的 `PROTOCOL_HISTORY_FILTER_BROWSER_PASS`                                                       |
| 历史详情与单条导出        | 已实现且上述候选 CI 验证。稳定 ID 定位，先查看再显式确认；取消不下载、确认下载一条原始记录，不重发业务；不承诺脱敏                    | `PROTOCOL_HISTORY_BROWSER_PASS` / `PROTOCOL_HISTORY_EXPORT_BROWSER_PASS`；#234 与 #235 分别核验              |
| 协议会话                  | 已有 gRPC unary/流式、Socket.IO 等限定界面旅程；不把一个协议的通过扩大为所有扩展/客户端兼容                                           | 对应功能 ADR、精确 PR 与浏览器日志；Socket.IO 入站 ack 只证明本地处理及 fixture 观察，不代表远端业务恰好一次 |
| 桌面便携包                | 当前 main 三平台下载验证 jobs 通过；#247 / #235 历史证据保留。无安装器/正式签名保证，未验证人工 OS 模态按钮                           | 同一原运行的平台 jobs、构建 head、旅程日志及归档证据；上传成功本身不等于包内容验收                           |
| 完整 GUI / 原版全功能对照 | 待完整验收，局部真实旅程不能替代全流程；不是已交付                                                                                    | 按下方矩阵补齐场景、边界与精确证据                                                                           |

协议未知结果不得自动重连或重发；“单实例单 intent 至多一次启动尝试”仅指 #226 支持的会话入口，不泛化到 Socket.IO/gRPC 或其他协议入口；该有限保证也不是远端业务恰好一次。临时凭据不因界面能力而自动持久化；历史与导出可能含敏感内容，分享前须检查。

## 阻塞完整交付的矩阵

| 项目                        | 当前分类                       | 下一步与完成门槛                                                                                                                                                       |
| --------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最终集成验收                | 待验证                         | 冻结一个最终组合 head/tree；对项目创建、导入、编辑、保存冲突/恢复、计划执行、协议、历史、导出、重启和错误状态建立逐场景索引。不能以单支或部分成功代替完整产品          |
| 原生非空 automated_testings | 当前非空入口不支持，且语义缺证 | 已有公开非空结构样本，但缺同版本图装配/设置/引用与往返执行证据；见[语义验收边界](native-automation-semantic-acceptance.md)，未闭合前保持原子拒绝                       |
| SQL Server provider（历史） | 当时尚未注册       | `src/sqlserver-read-prep.mjs` 明确为 unregistered WIP；先明确合法运行条件，再完成注册/界面合同、边界测试和真实只读服务验收                                             |
| Oracle / 达梦（历史）      | 当时尚未接入项目             | 确认合法驱动/运行条件，逐项实现并验证；SQLite 等额外能力不抵消这些缺口                                                                                                 |
| 安装器、签名与公证          | 未实现安装发行闭环/未验        | 便携包不等于安装器；按[清洁机器安装发行协议](INSTALLER-RELEASE-ACCEPTANCE.md)分别核最终介质签名、首次安装、升级、卸载保留数据与重装。账号/证书/条款单独授权，无 bypass |
| 完整 GUI 可用性             | 待验证/缺口待逐项判定          | 检查首次启动、键盘导航、未保存修改、取消/返回、错误/空状态和跨项目隔离；不以像素相似度或局部测试宣布完整复刻                                                           |
| 历史偶发失败                | 根因未解决                     | 保留原运行、日志及产物，独立诊断 XML interrupted、HTTP2 析构及预算失败，不放宽预算或以新绿灯改判                                                                       |

下一开发顺序优先闭合上述交付门槛，而不是把更多零散功能 PR 当作交付。功能开发与验证继续按精确基线推进；无可用执行环境时可做源码/合同审查，但不能将未执行的检查记为通过。

## 历史证据保留

- #207 原运行 `43094696449`：4 成功、2 上传失败、37 取消，不算通过。之前上传失败和排队早于后来的 GitHub 官方故障，不能断言同因。
- #208 原运行的单独检查已按用户要求暂停。旧文档中的 queued 是当时观察，不是当前状态；本轮未检查它。
- #225 原运行 `43283941991`：45 成功、1 macOS XML 共享 250ms 活动预算失败，保留，不放宽预算。
- #231 原运行 `43340367067`：macOS XML 实际 interrupted，job `131606875310` / artifact `13998774256`，根因未知；后续诊断提交通过不等于根因修复。
- #233 原运行 `43399838538`：44 成功、2 失败，历史 fixture 导航等待问题与 macOS Node HTTP2 析构断言是两件事。fixture 修复后的 `43407473266` 为 46/46；不声称修复了 HTTP2 根因。
- #246 原 head `11df9b5c2e3085aefd623e7199c56975b70364f1` 的[运行 43665923143](https://github.com/Hubujiu/local-api-workbench/actions/runs/43665923143)：42/46 成功、4 失败。三平台 shard 10 为执行所有权测试截取边界错误，另有 macOS XML 失败，不能混为同因。仅测试修正 head `9c44eca4dfd28bc3bbe5610bfe70483d7e1d7962` 的[运行 43670765124](https://github.com/Hubujiu/local-api-workbench/actions/runs/43670765124) 为独立 46/46；不据此声称 macOS XML 根因已修复。
- 其余历史失败及原阶段判断继续保存在 [历史后端检查点](BACKEND-CHECKPOINT-2026-10-25.md)、各 PR 与原运行，不删除或覆盖。

## 后续验收记录格式

每条记录至少包括：用户场景、实现/拒绝边界、精确 head 和 tree、测试入口、原 CI run/attempt、平台 job、关键断言或 marker、产物 ID/摘要和读取结果、未运行/跳过项、历史失败关联。聚焦、本地全量、浏览器、Electron 与实际下载归档分别记录。仅 job 名称或绿色状态不能证明目标旅程实际执行。

## 发布权限与文档状态

已授权开发可保存任务分支和 draft PR；这不授权合入 main、部署、正式发行或接受新增许可条款。发布动作须依用户实际授权处理，不能从 CI 通过推导。

本次为 docs-only 验收索引整理，不改变产品代码、测试、预算或工作流。仅更新已核验候选的下载与证据入口；本次文档未重新执行浏览器或桌面旅程。文档提交自身的本地检查与 CI 状态须在 PR 中独立记录。

[PLAN](PLAN.md) 和历史检查点保留原阶段事实；其中旧分支流程、前端暂停描述不是本轮授权或最新状态。最新用户指示与明确权限优先，历史记录不追溯改判。
