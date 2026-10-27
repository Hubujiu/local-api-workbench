# Native automated_testings 静态证据与阻塞 — 2026-10-27

## 结论与范围

**当前不能将 canonical repeat（PR44）宣称为原生 automated_testings 的导入/导出兼容。** 固定次数循环的 runner 语义已有静态证据；保存的 flat event_list 到有序 children、保存设置到 runner option 的真实组装调用及非空同源出口样本仍未查明。此报告保留这个独立交付缺口，不阻止其它后端工作。

本次只读已合法取得的明文静态文件与既有虚构样本；没有执行原版、请求其 API、解除授权/付费检查、接受许可、进入 VM/XML/bytecode 专项，或修改产品代码。没有执行新的原版或 Workbench 功能测试。源代码事实仅概述结构/调用关系，不复制专有实现。

## 1. 可复核源身份与位置

偏移列格式为 **1-based 行号 / 0-based Unicode 字符偏移 / 0-based UTF-8 字节偏移**。压缩 renderer 几乎全在第 2 行，因此同时提供模块和偏移，不用行号冒充精确位置。

### Renderer 保存及预处理

- 文件：`/tmp/rea-extracted-8470fbbf-bba4-4334-9171-c3911dd03c8d/index-0d1d8198fa5a.js`
- SHA256：`20bb6e21fd678ead16bd91807dc9623b8cd3e7019d44ac874a167c31a37f39fb`

| 模块/锚点         | 行 / 字符 / UTF-8 字节 | 已证事实                                                                                                                          |
| ----------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 689722            | 2 / 1529437 / 1531598  | 在 event_list 数组直接按 event_id 查找并改 data；支持扁平编辑结构。                                                               |
| 77442             | 2 / 2369249 / 2372291  | loop 默认字段：loop_type、limit、sleep、loop_timeout、enable_data 及数据源字段。                                                  |
| 230800            | 2 / 2370442 / 2373484  | 事件模板 parent_event_id:"0"、enabled、type、data。                                                                               |
| 544191            | 2 / 2372167 / 2375209  | 保存对象 settings 含 execute_count、interval_time、ignore_error、enable_sandbox；event_list 缺省为空。                            |
| 719563            | 2 / 2780005 / 2844162  | 保存调用保留 event_list，汇总 case_references，并交 472049.$7；API事件构造含 event_id、test_id、sort、auto_sync、data.target_id。 |
| 472049            | 2 / 3398095 / 3624385  | 声明 automated_testing 的保存/详情及 runner HTTP 接口。                                                                           |
| 526737            | 2 / 3489028 / 3715330  | 现代 JSON 导入处理 automated_testings 身份及 API/sample 引用，返回 eventList；不是 runner 树组装证明。                            |
| 659068.tJ         | 2 / 3570508 / 3796836  | 整理已经存在的 children 树/请求字段；读取循环数据来源。未发现它把 parent_event_id 转成 children。                                 |
| 472049 保存 URL   | 2 / 3399522 / 3625812  | 保存端点字符串；未调用该接口。                                                                                                    |
| 472049 runner URL | 2 / 3399811 / 3626101  | 发送端点字符串；其存在不证明 paid/backend 实际组装或授权已验证。                                                                  |

### Runner 普通控制流与请求装配

- 文件：`/tmp/rea-extracted-723023eb-b3c2-4f62-a4fa-97b9c9f73dd1/index.js`
- SHA256：`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`

| 模块   | 行 / 字符 / UTF-8 字节       | 已证事实                                                                                                                                                     |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 842216 | 651389 / 33601138 / 33996724 | auto_sync>0（以及单请求场景）取 collection；否则取 data.apiData。随后仍可能合并 collection/project 的父层参数，因此固定 apiData 不自动等于完整独立冻结配置。 |
| 842216 | 651389 / 33632544 / 34028148 | 循环消费 children，过滤 enabled>0；还有数据源、间隔与超时相关行为。                                                                                          |
| 842216 | 651389 / 33634552 / 34030156 | loop_type=2 从 data.limit 取次数，按轮重复 child 列表，交顺序执行函数。                                                                                      |
| 842216 | 651389 / 33639004 / 34034608 | ignore_error 影响请求/断言失败后的继续与中止；不能直接套用 canonical 默认继续。                                                                              |

### 发送胶水

- 文件：`/workspace/scratch/75c2273f6a80/api-original-static-cache/extracted/opt/Apipost单机版/resources/app/utils/send.js`
- SHA256：`71644fde1546c31559d1d49256ce4cbfaa963ac889ad5c5343c3b7d7e16f5307`
- 行 469–517：读取已有 `test_events` 与 `option`，调用 `run(test_events, option, ...)`，本段没有把 saved event_list 转换成 children。
- 已只读从缓存 `api-original-static-cache/apipost-2.0.0.deb` 的同路径流式取文件并核 SHA256，与该缓存文件完全相同；未执行包或写回包。

## 2. 五份现有出口样本：身份与缺失证据

以下是现有虚构项目出口文件，不是本轮新生成的原版运行证据。对当前文件实际 JSON 读取确认五者 automated_testings 均为空；这些文件能证明空字段形态，**不能证明非空 automation 图的保存/运行/重导语义**。

- `/workspace/scratch/75c2273f6a80/api-original-fixtures/exports/native-echo-original.json`
  - SHA256：`a0a39731e172337843eb891bd9862cc3430985dc87d35ea75c384c7661df3bc7`
  - JSON 身份：project_id=`10f4454574400d`；name=`Workbench Native Fixture`；`automated_testings: []`。
- `/workspace/scratch/75c2273f6a80/api-original-fixtures/exports/native-echo-reexport.json`
  - SHA256：`87d94605d58132a3d8100faf5bfadb0036032a392974b21149dee5073e350f21`
  - JSON 身份：project_id=`10f7386134404a`；name=`Workbench Restored Fixture`；`automated_testings: []`。
- `/workspace/scratch/75c2273f6a80/api-original-fixtures/exports/native-echo-scripts.json`
  - SHA256：`9c93062dade065c088691f19467d74f8bc2bb2c167a1b2836ff247b4d6313743`
  - JSON 身份：project_id=`10f7386134404a`；name=`Workbench Restored Fixture`；`automated_testings: []`。
- `/workspace/scratch/75c2273f6a80/api-original-fixtures/exports/workbench-native-reexport.json`
  - SHA256：`a4750be8a59ea89a31b5bbf82b69a3bf1d7784f392f3b2fccba93cd02ad4387d`
  - JSON 身份：project_id=`116ff172344298`；name=`Workbench Export Roundtrip`；`automated_testings: []`。
- `/workspace/scratch/75c2273f6a80/api-original-fixtures/exports/workbench-native-matrix-reexport.json`
  - SHA256：`adc330fec5a2fa72478c3236d3e916d10d2f7baebe682727ea49e63c83a9882d`
  - JSON 身份：project_id=`116ff172344298`；name=`Workbench Export Roundtrip`；`automated_testings: []`。

同轮仅对已知 fixture 目录作 JSON 键检查：exports 5 份；native-source 96 份；native-source-snapshots 60 份；plan-inputs 2 份。后面三个目录未发现顶层 event_list 或非空 automated_testings 样本。这是限定材料集合的负面搜索结果，不是对全部用户文件、所有版本或原版能力的不存在证明。

## 3. 精确未闭合处（“未找到”，不是“证明不存在”）

1. **flat → children 的实际组装链未找到。** 保存/编辑侧可见 event_list、event_id、parent_event_id、sort；renderer 的 659068.tJ 接受已经有 children 的输入，runner 直接执行 children。尚无可复核调用把两者连起来，因而兄弟 sort/数组顺序优先级、缺省/重复排序、根节点与父引用处理不可猜。
2. **settings → option 的完整组装未找到。** 已见保存默认 execute_count、interval_time、ignore_error、enable_sandbox 与 runner iterationCount、sleep、ignore_error 等消费项；不能仅按名称相似推定转换、优先级或环境/沙箱效果。
3. **缺少非空同源保存/出口样本。** 现有五份出口均空，不能据 synthetic fixture 反过来宣称原版格式已证。保存 API 声明也不证明服务端实际持久化形态或付费调用成功。
4. **live API 与快照意图不能混淆。** auto_sync 的两种来源已有明确分支，且父项目/目录参数仍可能参与装配；不能把全部引用统一冻结、或导出时从 live API 回填旧快照后称同义往返。

限定检索还发现：已读 runner index.js 不含 event_list / parent_event_id 字面量；renderer 的 parent_event_id 命中主要是模板与导入身份处理。这只能支持“当前已读位置没有建立该转换链”，不排除其它文件、通用配置键、远端实现或不同版本中存在转换。

## 4. 当前 Workbench 合同（不是新支持）

相对于本轮读取的 api-integration 文件：

- `src/apipost-modern.mjs:275`：非空 automated_testings 明确拒绝。
- `src/apipost-directory.mjs:229–238`：现有目录 executions/flows 转换使用独立 nativeExecutionFlows，automated_testings 仍为空。
- `src/apipost-export.mjs:493–496`：现代出口 automated_testings 仍为空。
- `src/apipost-directory-export.mjs:97–102`：非 HTTP 步骤（含 repeat）明确拒，不能静默展开丢意图。
- `src/plan-repeat.mjs:115–166`：canonical 单层 HTTP repeat 已有独立结构/次数/潜在展开预检；它不是原版 automation 解析器。
- `docs/ADR-OFFLINE2-EXECUTIONS.md` 的已验 executions/flows v2 是另一种持久化格式，不能拿来补上述 legacy automation 的证据空缺。

## 5. 补证后才可实施的窄候选

候选是完整的“原生固定次数 HTTP 图 ↔ canonical repeat”批次，而不是先把未知 source 存起来就声称往返。

- 仅单层 loop，已证 `loop_type:2`、literal 正整数 limit；按 canonical 既有 count 1..100、潜在总请求 ≤200、配置/证据预算继续收紧，不扩大原预算。
- 无数据源（明确 disable 形态）、无间隔/额外 loop timeout、无嵌套/条件/while/并行/引用其它测试/调度；未知或有作用字段拒绝，不能默默忽略。
- 首片只考虑已证明可独立解析的固定 HTTP apiData。auto_sync live 引用、未闭合父层依赖、跨来源引用明确拒；不得擅自改变绑定/秘密授权语义。
- settings 的 execute_count/ignore_error/sandbox/environment 必须先补齐组装证据，再限定为与现有 canonical 行为可表达的值；不兼容值拒绝，不能“默认继续”掩盖差异。
- 保存来源 namespace、testing/event 身份、父子结构与有效顺序；两代出口不得仅 flatten，不从已编辑 live API 重建历史冻结请求。
- 复用既有 API converter、图校验/身份映射、snapshotPlan/versionPlan/runPlan、作用域原子提取、取消与保存收据；不复制原版实现，不新增真实账户或权限。

**补证门槛**：合法明文调用点/文档或已有非空同源样本能连接 saved event_list → ordered runner children，说明 settings 组装与 API 来源选择；未取得前维持现有明确拒绝，不以猜测生成的字段取代证据。

## 6. 补证后的完整验收路径

1. 合法非空来源图（登录 → 两叶子固定循环 → 组后请求）只导入、不联网；源文件不变，全部身份/拓扑/预算先验，坏图零网络且目标零部分修改。
2. 保存后 owner/MCP/CLI 真实 loopback 执行；验证轮次/child 稳定身份、变量提取与消费的实际 HTTP 顺序、两项目同源 ID 不串值。
3. 编辑 live API/父层 literal 后，旧冻结计划不变；环境占位符仍按现有运行时解析合同，不谎称变量值也被冻结。
4. 导出 → 新项目重导 → 再导出/重导至少两代，图意图、父子关系、enabled/有效排序及实际 wire 语义均一致，不只比较保存的 source。
5. 明确匹配失败继续/中止、取消无后续请求、列表提取原子性；保留已确认副作用，不自动网络重放、不声称磁盘或远端事务回滚。
6. generic 保存失败与 typed unknown 保留真实执行证据/收据；修复存储后读取/恢复，不重放请求。backup/restore/restart 后图和冻结定义仍有效，临时授权按现有入口合同重新提供。

---

生成时间：2026-10-27 UTC。仅将本轮已有结论落盘；没有为此扩大搜索、创建分支/PR或修改产品实现。

## 2026-10-27 公开原厂CLI补证（未闭合映射）

[官方CLI文档](https://wiki.apipost.cn/docs/clitool/) 指向 apipost-cli-pro。公开npm版本3.0.19的元数据license为UNLICENSED；官方所链GitHub仓库本轮公开GET为404。这不足以判断仓库永久不存在，也不能把文档“开源”一词当可复制代码的许可。仅阅读字段事实，没有安装/运行CLI、复制专有实现、打开文档中的带token执行URL或检查字节码。

[版本元数据](https://registry.npmjs.org/apipost-cli-pro/3.0.19) 所列tarball的实际SHA1及SHA512 integrity均匹配。包内dist/apipost-cli/测试.html的SHA256为 `3bb7e59e7df9837a73345cf51de88bfe9e7b1a0c178c7a9891c5927ca509e7a1`。只用JSON解析其内嵌data，不执行HTML：test_events有三个事件，root api(sort1)、root while(sort2)、while下if(sort1)，含parent_event_id；报告顶层children为空。未复制其中身份、地址、用户或请求内容。

这是非空的**报告事件材料**，不是项目automated_testings/event_list出口。它支持flat父引用形态，不证明saved settings到runner options或有序children的转换。当前仍未取得非空同源项目出口和完整装配链，不能据此开启原生自动化迁移，也不能将canonical repeat包装为该格式兼容。

## 2026-10-27 19:44 补证：样例运行器不是保存的自动化图

仅静态检索既有合法提取的231个renderer JS文件（合计42,244,518 bytes），并沿模块和直接别名查找；未执行原版、未读取字节码、未调用真实runner端点，以下只记录契约事实，不复制实现。

- 新来源chunk `5509.478a5be6cfa8.js` SHA256 `d34370de3042ed4bba723fa1b18422003658c9b58e3cea0e82b50577dbd65437`，module65509：Unicode偏移4198处，在15861.q(scene:auto_test)返回后将execute_count赋给iterationCount、interval_time赋给sleep，并传递ignore_error/enable_sandbox。偏移4761明确来自82896.lp样例默认设置，不是saved automated_testings.settings；10404处调用472049.s4，后者转交/proxy/v2/runner。只证明真实静态样例调用链，不据此启用原生自动化迁移。
- 默认来源chunk `657.b6a76120fe76.js` SHA256 `3fa10dbb181bbeca693bf5f4b18f476d077222bafa56a611a1d4e244f057eb16`，module82896、偏移1665：样例默认execute_count1/interval_time0/ignore_error1/enable_sandbox-1。5509偏移4657从原samples数组筛选，4847按筛选数组顺序生成sort；传给659068.tJ后API/sample叶子不保留该sort，运行顺序已在数组中。这不证明saved parent_event_id/sort如何装配成children。
- 既有sender SHA256 `5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`，module842216，LF规范化Unicode偏移33641671、33641725：auto_test完成时enable_sandbox>0会将返回的variables.globals/environment置空。5509偏移8257/8794随后进入变量处理/写回函数。因此已证“变量结果抑制”，不代表进程/VM隔离、网络关闭或全部副作用回滚，更不证明saved automation字段如何传入。
- 这些offset均为完整文件0-based Unicode字符位置，不是UTF-8字节。main renderer仍按既有20bb6e21哈希固定；659068.tJ偏移3570508（函数）、3571526（API/sample叶）、3573819（仅已有children递归）。直接别名搜索只找到新增sample调用；未排除间接导出、计算属性、其他版本或服务端装配。

**仍未关闭：**保存的平级event_list如何有序构树、saved settings来源/覆盖顺序、同来源非空原生项目导出样本。保持原生自动化不支持的明确边界；样例适配器和报告结构不能代替缺失证据。
