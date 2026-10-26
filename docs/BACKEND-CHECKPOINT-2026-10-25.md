# 后端检查点 · 2026-10-26 18:30 UTC

本文只记录下列已核实的提交及范围，不是完整交付声明。此前更长的历史说明保留在 Git 历史和对应 ADR/PR 中，不再把历史阶段的“最新”状态混列为当前结果。

## 本轮读取的 PR 状态

PR1、PR2、PR3、PR13、PR23、PR24、PR25、PR26、PR27 均为 open draft，未合并。PR1/2 在16:58 UTC重新读取，head与原精确CI未变化，没有重跑旧版本。

| PR  | 已读取的 head                            | 目标                              |
| --- | ---------------------------------------- | --------------------------------- |
| #1  | 88f70bb515c48b93536b28b7fe3ec780f2e150f3 | main                              |
| #2  | a3ffbcd00134d5846b2a8550a5d096cec9139b7f | develop                           |
| #13 | f075e07fcb158f7dff639292cf7babfa931547d8 | feat/protocol-text-templates      |
| #23 | 2dbe12c868aa383850117a33528542e58c4972eb | feat/protocol-request-semantics   |
| #24 | 9cde529a25c5c5d985bc4574e4002176ea78f634 | fix/postgres-explicit-credentials |
| #25 | eb323eb424eba2e0b2c6c969d7a4cd572333d43e | feat/apipost-database-tasks       |
| #3  | c5c588efd1a1f2b7153db7576b80776c916c7413 | develop                           |
| #26 | aa95fd403b7561ff182145924704d2979d689ca5 | feat/native-response-extraction   |

本轮没有执行 main/develop 合并、部署、前端功能开发或原版程序运行。

## 已核实的 CI 证据

- PR1：CI40136832590，10个job成功；实际检出的测试合并提交 aca19f825ee65e923c20995d1340bba15ca8f7cc 的 tree 与 head 同为107767d4d92f69fc0b5a048d41371267fea5a568。
- PR2：CI40275759477，10个job成功；实际测试合并提交209ae2df120ac7888135e29f9afe97553a0a4cec的tree与head同为75064180086a76d80e085f8226b568f946ff310f。
- PR23：CI40333840510，10个job成功；实际测试合并提交dcc72d4da5df4c86654dda18e27ccdfef09c7ab6的tree与head同为d14e902cf978dbc8e84d4a165745a82e6609e504。
- PR13：CI40334434565，10个job成功；实际测试合并提交0e7e08665b30425943b0b56c38829b6ff24775a6的tree与head同为c325a27cb85295b2b6319de2f8516ffc0a7855a8。

CI链接格式：https://github.com/Hubujiu/local-api-workbench/actions/runs/ 后接上述编号。PR CI默认检出测试合并提交；以上源码判断来自checkout日志和Git对象tree，不能仅凭关联head或BUILD_HEAD字段推断。

此前已核实的全绿组合为5945bb5ae7a196969ea039bd4dc84023ba305b0f：push CI40339647931的10个job成功，实际检出该SHA，tree d44c0ed14a3a1359677ff603ddec44d1e5d3eb32。它包含协议模板与真实CLI绑定/冻结/备份恢复检查，**不包含新的数据库取消修复**。

随后保存的RED验收提交23a3e11a093cc37d18cc54a65794922e43a30c20（tree e4d77370b3e4bd81f83dcfddb49ed4e74d0ee5ac，CI40347929169）在三OS均仅有新增的六项PG/MySQL MCP HTTP、stdio取消与EOF关闭检查失败，原有检查通过。失败说明取消后真实驱动socket仍存活，不能用“已保存cancelled记录”代替连接关闭。该RED阶段保留，不作已验收版本。

## 本次协议模板范围

PR23增加可选templateMode:variables/literal。缺省保留旧行为，只在固定端点的WS/TCP纯文本消息和SSE POST正文启用；URL、Query、Header、认证、host/port不自动替换。变量采用own标量、非递归解析，展开前执行UTF-8预算。live open固定项目环境/global私有快照，关闭后释放；不把整份私有变量表写进session GET或证据。

PR13只在原生三个raw文本入口映射上述模式。字段来源、输入与惰性档案保持；运行时握手凭据仍须显式提供。函数/表达式和未支持的协议配置拒绝。独立PR CI覆盖实际WS/TCP/SSE、HTTP/SDK冻结计划、live隔离、错误路径、记录保存及备份恢复/重启。

初始实现的空WS文本帧遗漏和环境ID迟校验已有修复及回归。组合中更严格的存储保护会拒绝旧测试构造的非法ID，因此只将该测试改为受控legacy-read故障注入；仍验证真实HTTP零连接、磁盘不变和恢复后正常执行，没有放宽生产Store。

## 数据库取消修复组合已核验

独立draft PR24基于PR18，不累积进PR1。功能head9cde529a25c5c5d985bc4574e4002176ea78f634、tree2bd257d3ce8c71ec6ff5dfc78801292006e72ac1，已保存PG/MySQL caller-owned stream、Redis/ClickHouse请求及SQLite子进程取消。严格TLS、SSH主机指纹/五通道限制、只读边界不放宽，显式写入契约不变。后续修复去掉mysql2强关后残留的冗余命令timer，仍由owned-stream执行每阶段2秒截止。

组合冲突保留了PR9的Mongo AbortSignal、数据库来源目录前后复核，以及PR15的SQLite诊断IPC。SQLite的close事件退出信号与调用方AbortSignal分开命名，取消仍等真实close，不把阶段IPC当作查询结果。局部验证已确认SQL取消关闭、TLS、SSH、Mongo和SQLite流程；SQLite诊断隔离fixture也补齐了新模块依赖的真实文件复制，未替换生产实现。数据库取消组合2ec2e2b36e51a9eb45aa66279be6045167367384已通过push CI40350706424的全部10个job，实际checkout均为该SHA，tree cf571f295b1e5658f626ac8ccd67f98ff8f41556与本地一致。原六项SQL取消RED均转绿，真实数据库服务和既有Mongo/SQLite诊断保留。独立PR24的CI40349691855也已通过，实际test merge2376001274b07d80a9a3950eba9c400f4afe05fe的tree与head一致。

首次组合验收另暴露两项重启断言与已有“失败步骤后继续执行”契约不一致：无数据库授权时第一步被拒绝，第二步不访问数据库的普通HTTP仍按计划执行。独立审查确认这是新测试的过宽断言：现按实际路径核对只有 /later-a 被调用、首步失败且无响应、第二步成功、整个计划失败落盘，数据库仍零连接；取消阶段的零后续HTTP断言没有删除或放宽。

传输关闭只证明本地资源清理，不保证远端SQL已停止或回滚。直接数据库读取HTTP断开会取消，但该检查端点原本就不创建计划/history记录。脚本记录落盘和底层连接关闭需分别观察。

## 响应提取组合及后续CI修正

PR25首阶段080edd483183529d950eefd8ce22ac137268c668虽然CI40352851569通过，但独立错误路径验证发现断言与变量保存冲突后仍可能沿用旧token继续请求，因此该阶段明确不能验收。后续84d02f7e69e2234feb06b0dc11ba8001f6a38aac已保存修复，其tree为7e0d50bbd334f53ab7a6cb1f12e7385223a2e0ff；自己的远端CI需独立核对。

支持原生post pickVars responseJson的有界单值提取，保留同阶段词法顺序、当前处理响应视图与原wire区别。包含启用提取的请求失败时停止后续计划步骤；未启用该能力的旧继续策略不变。可信出口检查捕获提前return和吞掉提取异常，失败后置阶段不提交内存scope。进入存储提交后的I/O失败仍可能是不确定提交，恢复可能完成journal，不能声称磁盘回滚或重放请求。

本地新组合补齐PR2 CLI collector对新任务的闭合校验及PR7惰性来源保留，未激活原生flow里的API来源任务。实际SDK HTTP MCP、CLI登录→Bearer、CLI混排SQLite授权/提取、错误预检、重启已通过定向检查；修改原生flow fixture加入的synthetic pickVars在CLI与恢复项目中保持惰性，非JSON响应仍成功且变量不改写。它们不能借用2ec2的旧绿灯；新组合发布后仍须核对自己的完整CI。

提取组合a1c46e7434b4f71972f5ca54ba8c32d529a08a61的CI40356149275保留为失败历史：Windows旧I/O fixture只接受generic错误，未识别typed unknown；另Faker计数测试先碰到activity截止。新增六项真实组合流程三OS通过并不能抵消这些失败。

PR25修正测试为精确的generic/typed双分支（typed必须有unknown/retrySafe:false且脱敏），独立head eb323eb424eba2e0b2c6c969d7a4cd572333d43e的CI40358364565通过，实际merge31e7da4ffdce63bff37ac5e2774b78cceed093ee/tree6edfbddd55e34dde01c6dd2398a1fbb76741c210与head一致。PR3的c5c588efd1a1f2b7153db7576b80776c916c7413仅改测试分层与ADR：六个600+600样本仍用同真实Faker提供器/计数器，精确验证600/401；另有真实replaceIn双向混合配额测试与故意重置额度的红灯负例。250ms/2s/1000上限和生产代码未改。其CI40359028997通过，actual merge1a89ed1c37f3cc2708e7d7ca93f7ed06558f9c7a/tree7e18cdec73236be4b63480acee2735f7c9c308aa与head一致，不宣称解决所有系统调度延迟。

此前完整全绿组合为4b26389c67bd20b80eeec94e3319ec69cce2f0ed：push CI40359410945首轮10个job成功，全部actual checkout该SHA，treeb50562570eda2970bdd1e3dfbd123a79aae011eb与本地一致。该组合覆盖提取、MCP/CLI/数据库混排及typed journal恢复，**尚不包含下述新原生断言**。

## 原生响应断言组合已核验

独立draft PR26的后续修复head aa95fd403b7561ff182145924704d2979d689ca5、treeb661be22413f1f4ad549141bc0516e2dcfac38b7已保存。独立CI40361312102全部10个job成功，actual merge f0392a1d7060d7abc8fb5b8e3ad8e0af77ad021f的tree与head一致。首片仅后置responseCode/responseJson、eq/uneq和字面字符串预期；不冒充原版递归变量替换、XML/其他来源/JSONPath表达式。比较失败保留soft failed assertion与普通计划继续策略；与启用pickVars共存时沿用已声明的严格失败停止策略。私有结果与可信完成性检查避免公共test数组改写/重复索引/提前return伪造完成；保留共享配额，未新增主机能力。

组合解决scripts预算模块冲突时保留PR3预算校验/累计扣减，增加断言数预检。CLI DB collector识别并验证新类型，原生flow API来源仍是惰性数据。新真实CLI/恢复测试中加入JSON断言、禁用且未配置的模板来源，非JSON响应仍通过且变量不改，执行记录保留原来源，证明没有执行或插值它们。活动nativeTasks及旧脚本来源同样不再被普通wire字段插值；实际URL/Header/Body仍按原规则展开。新组合不得借用4b26389的旧绿灯。

最新已核验组合为9d21b494a84ad3f047c1f4c0e6146465306a4085，tree b74b814c49658d5b3450681b1b5ad98106d5fb7e；push CI40363859110全部10个job首轮通过，实际checkout为该SHA。覆盖真实MCP/CLI的断言soft failure、与pickVars共存的严格停止、SQLite混排、备份恢复及惰性来源不插值。该绿灯不包含下面的新等待能力。

## 原生有界等待：组合已核验

独立draft PR27基于PR26，最终功能head d8ce3c9f0f7b6ba332a6e3078b88cc2cbb7cce88、tree 977603d81bc4d794d031a11da4870cd46b99b446。初始CI40366399379的三OS失败保留：旧测试仍把合法wait:10视为未知类型；已保留真正未知类型、字符串和超预算的原子拒绝检查，并增加合法输入正例。最终head的CI40368410367首轮10个job成功，实际test merge421242c00913a3df6e8dd8f9d61ea46b0b560439的tree与head一致。

启用等待仅接受0..1000整数毫秒，同阶段累计不超过1000；0不调度timer、不让出微任务。正等待使用私有原始timer调度及可信完成检查，共用现有timer/活动/总时长限制。禁用来源保留有界JSON标量但不转换、不执行。不同于原版同步阻塞，安全异步等待期间既有回调可以运行；不宣称任意异步控制流等价。

组合保留PR3预算模块，CLI collector闭合验证等待且不因此授予数据库权限，原生flow API来源仍惰性。本地真实SDK HTTP/stdio前后阶段取消、stdio EOF及CLI导入/冻结/备份恢复已通过；同时核对真实等待期间标记，取消后不提交未完成阶段变量、不执行后续请求，独立项目不受影响。等待组合49508b3598110095ad4c482132cc6cb81b2ca647、tree59a8424aeacb06b536a8335de841ef7eb301748b已通过push CI40370787451首轮全部10个job，全部actual checkout精确该SHA。既有DB/TLS/stdio和预算边界仍通过。这是有界等待范围的证据，不是完整产品交付。

## API本地混排任务原生导出：新组合验证中

独立draft PR28以仅连接PR14与PR27的依赖基线为临时目标，功能diff独立，不包含其他集成能力。基线remote2eded2761576222049651b31eda9f53b5ea2be9a、tree998d65126f1a5a0fac8255085422c8c59e1d7ad7；不是合入develop/main。

首阶段2a84aef232dd44214e05207926789cf46cadfe51保存为WIP。审查真实发现request getter在校验前调用，以及纯脚本阶段metadata1800/拼接后64KiB限制导致JSON可导出但不可回读。修复head f9753d9db4855679b74f7787eb974170df15de89、tree d104c516587154c0a699487c90b5f74c6131c36b已推送同PR：先校验相关own descriptors，再复用现有纯phase parser预检，不放宽导入限制。独立定向54项及额外定义往返探针通过；最终head CI和新组合CI仍待核对。首阶段全量执行期间工作树变化，只能作为回归参考，不算最终提交证据。

仅支持API-local customScript/pickVars/assert/wait混排定义；数据库、origin继承、惰性来源混用、纯脚本/空canonical管线及其他不可表达配置继续拒绝。目录冻结步骤显式拒绝nativeTasks，避免被覆写或回读为惰性来源而丢失行为。已跑真实HTTP导入→登录提取→Bearer→两格式导出→独立项目回读→执行→备份恢复/重启。只证明Workbench数据与执行往返；不宣称原版GUI往返、原版ID不变或原版执行安全语义相同。

## 当前组合RED与MCP新片WIP

PR28独立final f9753d9db4855679b74f7787eb974170df15de89的CI40372605965首轮10个job成功，actual merge4efd8c03e4a113b5b1effaf23a9a2d147ef5c72c/tree d104c516587154c0a699487c90b5f74c6131c36b与head相同。组合99122的CI40373619646终态cancelled，不算全绿。CLI fixture真实UTF8分块问题已修后，组合985b955fa2b8c2069df53f715598f675067e2a31/tree3e36cf58cfc75a0863f9f1c5689de3a0a3f782ac的CI40374549274为RED：Windows重启第二轮后置子请求未完成，触发既有2秒wall，后续wait120尚未调度。不能认定native wait计时器错误或已经修复；保持预算，继续诊断。新两格式导出入口三OS通过不抵消组合失败。

独立draft PR29新增canonical MCP原生导入/导出工具，严格现有授权项目、write/read边界、两种显式格式、merge-only，无restore/newproject/扩权/隐式请求执行。最终功能remote c25897e7bb1c71f680c826502e26621799c4f4d5/tree270396551bba40355e8ef273c97464bc47beaf78已保存，自己的精确CI待核实。修复outer getter、数组prototype、error/ID有界及目录内嵌JSON预算双向一致；不把独立base说成已有PR17/19。

组合真实HTTP/stdio journal发布后apply失败已验证typed unknown/retry_safe:false、脱敏、恢复可能完成一次导入且无自动重试，近限stdio拒后ping仍可用。初次组合19项中两项失败：合并错误分支误用未截断message已修；PR19早期拒非法ID仍回显或返回SDK不接受的null，需更新该原PR，不能松测试。当前组合仍WIP，不借旧49508全绿。发送前帧预算不保证发送成功；提交后断管不能推断回滚或自动重试。

PR19已在原功能分支保存f31bdc83b2cf923c857514a30d76a03c7f45673a/treee2f8de578f09ffddaf20b380f57c61ad0e14fdf6，并合入其PR3最新依赖基线。非法ID错误不回显且省略不可关联ID；JSON解析和schema错误分别-32700/-32600，合法重复/配额错误仍保留关联ID。新真实SDK红例转绿；本地独立定向与审查通过，但新head与新组合的精确CI待核实。WIP35153组合已在Ubuntu/macOS复现唯一预期ID blocker，不能作绿灯。

PR27诊断head15c75beb47c536dbc06bff02c0114b4b94999432/treee134ef4845f37dab702ad16d9e620eab68218d7d只增强失败事件、重启轮次及fixture锁存在性，不改生产、marker或预算。确定性持有Cookie锁可复现同一total-deadline签名，证明旧日志不能定位Windows实际原因；不证明那次CI就是Cookie锁，也不宣称根因已修。

## 明确剩余边界

- 不新增Socket.IO/gRPC、端点或握手模板支持；不执行原版内置/自定义表达式。
- 原版WS只有静态替换链证据，TCP没有原版模板wire对照；独立fixture不是原版GUI往返证明。
- sourceDefinitionHash标识默认定义，不代表每条live send的原始模板来源；事件hash核对实际记录的数据。
- 显式发送的正文、peer echo和既有计划变量可能进入历史。项目、备份和执行证据应按敏感数据处理，不作全面脱敏保证。
- 原版目录重新打开/保存、其他协议/数据库高级配置、完整反向导出、分发签名及前端完整交付等未因此完成。没有交付百分比或全产品验收声明。
