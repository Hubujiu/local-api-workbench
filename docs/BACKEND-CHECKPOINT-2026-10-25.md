# 后端检查点 · 2026-10-28 00:55 UTC

本文按精确提交区分已保存、已验证与仍未交付。历史完整记录保留在本文件 Git 历史、各功能 ADR、PR 与 Actions；旧 GREEN 不覆盖新 RED，测试数量不是产品交付率。

## 00:55 Postman 简写导入与进度故障证据保存

- 最后完整GREEN为 remote `eac00a6c2dbfc900d9a81b4b20465d24a487ce56` / local `50d31d4bb4c8b9fa75ef4679c33d7724c5f8b2e8` / tree `b673ac4ec16ae0747663277befb62c9e8d53ecaa`，首次CI `40604621126` 19/19成功。19实际checkout、12实际core ZIP大小/SHA256/CRC/完整TAP和405文件互斥清单已核，hash `7e0ab0e1f5d3b40d1d6bae3e7a57859b52e28322b315fe2cd3d8efa6790adea2`；Linux/macOS2149通过，Windows2142通过/7明确skip，无fail/cancel/todo。PR31与PR40各自CI40604083282/40604138726亦首次10/10，实际三OS产物已核；旧间歇故障根因仍未知。
- Postman真实RED：合法字符串item.request导入返回成功却落盘空URL，重启冻结计划执行Invalid URL。官方SDK固定来源支持字符串为GET URL：https://github.com/postmanlabs/postman-collection/blob/4ae76c15974011ea67b13c1895c4a02f4cbd3746/lib/collection/request.js 。schema站未成功读取，不声称schema验证。原创最小规范化不修改对象URL拼装、空URL草稿或事件SDK。
- 新独立draft PR47 `fix/postman-request-shorthand → develop`，local `b07b1c6d78f414931886a6ac0b6d51b1ebd07475` / remote `a6b924ff8953cb6359dc6306990217d537c3b19a` / tree `33f1a14f0d9d5587bdc7e7b17ec6513675a67b8f`。首次CI `40610995334` 10/10成功；10actual checkout `bda81bd9ce60cd99e67a475787bb02a6be954163` 同树，3实际core ZIP大小/摘要/CRC/完整TAP核验，各OS1026通过无fail/cancel/skip，3新增流程各OS通过。真实owner导入、变量环境、认证/重复query、冻结计划、错误导入原子性、备份恢复重启与CLI落盘验证；另项目相等是修改隔离，不冒充SDK授权测试。事件文本只静态保留，不执行脚本。
- 另一真实RED：stdio第一HTTP响应与变量提交成功，受控活动目录被替换为普通文件产生ENOTDIR；后续执行停止，但最终runs为空。原PR19改为保持fail-stop并保存已完成证据；不把进度故障伪装成HTTP失败、不继续下一叶、不重放，记录固定非敏感EXECUTION_PROGRESS_FAILED。外部取消仍优先；journal自身原始错误/重试和stdio单generic RPC error合同不变，路径持续损坏时不承诺立即返回receipt。
- PR19阶段 local `6f44b3a073f2aa4c7cea96c551a471c459556964` / remote `55c3c8e227289394fe014f7457b129741234123f` 已先保存；补取消验证后最终local `f69fcdb630d05b844f368cdea3200eb2ac9df798` / remote `f6ea4ac965476a2f44f18846c4c68c4b9af17099` / tree `db6a00b8100aed6651500c708fcc81a2246fc47e`。5新真实故障/取消用例及4整文件24/24通过，check/fullformat/diff通过。阶段CI40611160416被新提交取消，不能算通过；最终CI40611209544仍待终态。
- PR19 actual PR merge为 `c645444587ab09069abd2d84db200aa95f5a90a6` / tree `1540f03345e607134c5a6205adae2536235e82e0`，**不同于feature tree**。当前PR3 base带入4文件：ADR、script-worker最终charged活动预算5行、script-final-budget测试、script-sequence诊断测试；不是只有诊断文案。CI只证明此明确PR组合，不冒充纯feature tree执行。未为消除差异更改预算或重新运行专项。
- 根合并 `0f672adef8d269c65c46089afb63b9ff82363d74` / tree `5e91763a7a82542471012998afdfc68c93f4bb5c`，三处core冲突保留planOccurrences、重复evidenceBytes、提取fail-stop和evidence-limit，同时加入progress-failure与取消优先。独立静态审查确认；native摘要仍可能failed且failed HTTP列表为空，不伪造HTTP错误，完整结果详情保留诊断。
- 根only交叉文件 `d1fc5cb5186ae12b5ddc4290cc53354369495176` cherry-pick为 `10b7af0a33c6c10150a267a4d2a50e27fe60116a`，完整同树 `c2af30ecc62c6b9c3b1b5e9b31e062b416a34289`。5整文件32/32加完整Postman文件3/3通过，check/fullformat/diff通过。8新完整链涵盖canonical/native API与flow、真实TCP/HTTP、canonical repeat（native保持线性限制）、永久stdio故障和typed未知保存。未知保存用真实Store原方法和磁盘障碍产生ProjectCommitUncertain及.transaction.json，事务恢复同attempted ID一次；之后独立SDK重启和备份恢复副本逐条完整读回，无下一叶/重放/跨项目变化。
- 独立审查后补测试活动计时器清理 `59edc8e2bc9bc1c2064f46d62f7418db0475a17b` / tree `4e490f863bea4ebd82b4c5c9297f7c10b9e65550`：fixture删除前finish自己创建的MCPActivity，生产不变，新8完整链重新8/8通过，0fail/cancel/skip，14.359秒。根之后仅本文更新，尚须其自身CI，不借上一根GREEN。
- SQLServer依赖审计与许可、原生自动化格式证据及旧偶发中断仍未解决。没有前端新增、VM/XML专项或原版GUI运行，没有main/develop合并或部署。

## 23:47 OAuth2 原始回调编码与显式 TCP 接收编码

- 最后完整GREEN为 remote `1ffdb16149dd96c2c01055c167289f550e55a526` / local `c62522346bb0afeb7382fce91865879d6d91dc5e` / tree `890097509c979e1f45e04201586a64367cfb0d9c`，首次CI `40600032562` 19/19成功。19实际checkout、12实际core ZIP大小/SHA256/CRC/完整TAP及402文件互斥清单已核，hash `8a49b41cfd1cbd2e3e47198a259bdbeee6c583bfa793b96436a5d5c49064da76`；Linux/macOS2140通过，Windows2133通过/7明确平台skip，无fail/cancel/todo。4恢复身份与20服务隔离用例三OS全部通过。PR17 `82336c42` 自身CI `40599797851` 首次10/10，实际checkout `73d727f93a6902ee655577c2fb616505df45b67b` 同树，3实际ZIP验证，Linux/macOS1055通过、Windows1052通过/3权限skip；旧SQLite unknown写结果原因仍未知。
- OAuth2真实RED：旧PR31代码接收raw HTTP `code=%FF`返回200，真实loopback token端点收到`code=%EF%BF%BD`，凭据被URLSearchParams自动修复后发送。新PR31 local `d1070b1125635a78ce018d8681abc912a30de7a6` / remote `6350e7ef07b18ccef2956bdf793b2bde91419821` / tree `b59004b01a58cc042d5daebf88cb8bf1b35e0d92` 已保存，CI `40604083282` 待验证。只在原始query进入参数值使用前加严格percent/UTF8检查，解析失败像原duplicate guard一样在state领取前拒绝；合法Unicode/U+FFFD/百分号/加号空格保持，validly decoded语义错误/提供商拒绝仍按原规则消费state。
- OAuth2新3完整工作流与实际4整文件25/25通过，独立固定树新文件3/3通过；check/全量format/diff通过。一次命令还列入不存在的root-only oauth2-workbench-entrypoints文件，Node忽略该路径；它不计入4文件或25项证据，随后根组合才执行该真实存在文件。无真实第三方账户或新授权。
- TCP真实RED：显式项目交互会话要求hex，真实peer发送六字节`00 ff c3 28 80 01`，旧代码却产生并持久化UTF8事件。新PR40 local `ae076a3ffb940f9eb59f5c63d5e78cd3497289ab` / remote `b4a180b65ddc1f068cb1e73994876bf8c9d501c9` / tree `195c793dd0df234db776831e4b1b599d262225a1` 已保存，CI `40604138726` 待验证。仅选择显式input.receiveEncoding；有saved定义时仍取其保存值/默认UTF8，不开放临时覆盖，不改finite TCP body合同/TLS/预算。
- TCP新4流程覆盖hex/base64逐事件重组真实字节、默认UTF8、非法编码零连接/零写入、saved优先、停止/拒绝连接、备份重启及授权读取；6整文件41/41通过，独立新文件4/4通过。该feature新文件使用直接createMCP分发器，不是官方SDK传输，不扩大描述。
- 两功能自动无冲突合入根 `9bb5dab032f43ba8f80234250094605ffb2673eb` / tree `03f6cd645fd4672fbcf462180a2041ff11b3a3a9`。预先检查路径存在后执行9完整文件50/50通过，无fail/cancel/skip，16.52秒；包含root-only OAuth2 SDK完整工作流及既有native session SDK流程。固定HEAD/tree前后一致，check/全量format/diff通过，不把不同夹具的覆盖拼成新binary传输证明。
- 根专用SDK补充 `8cfa2f56dda1e6a10b5856c35c9e454f24612c62` cherry-pick为 `ef7b57b493f782a7c03feee47f4c46ff4ab82d22`，完整同树 `e49b67b06f95319f8d5e8df7fda2eb5f26205a9c`。新增单文件两个完整官方SDK HTTP/stdio流程2/2通过：每链真实hex+base64两连接，owner导出恢复、app重启后原/恢复项目列表和详情完整相等，原始字节再解码一致，真实存在project/record的未授权访问被拒绝，读回没有额外TCP连接/发送。无生产修改，新文件格式/diff通过；之后仅本文变更，根仍须自身CI。
- 没有前端开发、预算放宽、VM/XML专项、原版GUI运行、main/develop合并或部署。SQLServer审计/许可、原生自动化完整格式证明及旧间歇中断根因缺口保留。

## 23:07 备份恢复记录身份完整性候选

- 上一根 remote `ba3b2c38832f01709afa2d8604ff1b63cc96199e` / local `3f9e31a61306b2eacf15e6d0f241b506cfd3049b` / tree `f5c848f15f0de8b9fccad4b585b2b3fb0dd0149f` 已完成首次CI `40597961268` 19/19 GREEN。全部19实际checkout、12实际core ZIP大小/SHA256/CRC/完整TAP及401文件互斥manifest已核；manifest hash `3acb0dea13bb3522cfb532d6f1eb504c8855c779f86bb23b48d3ebcfa3045cd5`。Linux/macOS各2136 pass，Windows2129 pass与7明确平台skip，无fail/cancel/todo。20服务上下文/解析器用例全部三平台通过，真实DB和packaged stdio/shutdown/smoke等均有本次日志。未核portable/UI ZIP字节；旧间歇中断原因仍未知。
- 新的真实RED：PR17旧c303dc6执行API和计划后导出备份，注入重复history记录ID；owner restore返回201，重启仍保存重复记录，官方SDK列出两条但详情拒绝“记录ID不唯一”。已有读取歧义保护是正确的，修复的是新恢复输入允许不可寻址记录落盘。
- 原PR17更新，local `12a8534ea125231a9a9f166b407ea208844fbdd6` / remote `82336c421e9702b258228c2cdfd95197c1eb8125` / tree `2c5ae3d2324129fb9f1ba6594b92a574e6a09e1f`，仍draft→develop。仅restore增加10行校验，检查完整history+runs输入的非空/共享唯一record.id后才截取50条；不trim/重写ID，不改变关联runId、protocolRuns命名空间或既有磁盘项目读取。
- 四个完整真实工作流覆盖owner执行、备份恢复重启、SDK HTTP/stdio逐条读回、拒绝前后全部文件字节与列表不变、零网络重放、合法旧字段缺省、同runId不同id、opaque空白/Unicode ID、不同项目同id、实际SSE独立namespace及first50保留规则。六完整文件37/37通过；独立review及固定树新文件4/4通过。独立review限定：legacy用例的改名ID授权拒绝不是独立隔离证据，真正隔离由正常往返用例的原项目真实存在ID证明。
- 根合并 `1a01ab44b0042678919f6d00fcde186bf4329bfb` / tree `b3fdcbb4c57ba291e6cce5d9c7dd63a1c46caeaf` 自动无冲突。七完整文件54/54通过，无fail/cancel/skip，12.87秒；包括完整服务上下文与六入口unknown-save/no-replay。固定HEAD/tree运行前后一致，check/全量format/diff通过；之后仅本文更新。新功能提交和新根仍等待各自CI，不能借上一根GREEN。
- 无新前端、Store迁移、执行器、回执或运行预算改动，无main/develop合并或部署。PR17旧Windows SQLite未知写结果及其他历史RED保留，不因新增恢复校验而宣称修复。SQLServer依赖审计/许可、完整原生自动化格式证据等剩余缺口不变。

## 22:48 执行期间服务地址隔离修复候选

- 最后完整验证根已推进至 remote `245d3d1f52703f73d579f0779a07a0e38e8cb07f` / local `61e562e27000381db86d5826a514c495ddadf202` / tree `9cb70f3d793518e15d6463645d923be1bf532e57`，首次CI `40587849423` 19/19 GREEN。19实际checkout、12实际core ZIP摘要/399文件manifest及完整TAP核完；Linux/macOS2116通过，Windows2109通过/7明确skip。49 Digest、10纯诊断、7 XML边界全部通过，DB/stdio/三平台桌面/UI/format/ac4822均为本次日志证据；portable/UI ZIP字节未声称已校验。没有输出新增失败诊断，不能据此解释或消除旧中断原因。
- PR26 `e2d676b1` 的首次CI `40587001028` 亦已完整核验19/19，all actual `a6bb7714f7a6d2bc73878f33b463bc7fd273f30a` 同树 `f7a40bf14118b818fd0233b6ad03e8df33473842`，12实际ZIP摘要/TAP/264文件66×4清单完整，每OS1379通过无失败/跳过。仅诊断信息保留，不算运行时修复。
- 新问题是真实的执行隔离错误：scope持久化的Object.assign刷新调用方project后，每个HTTP叶片的服务解析又读该对象；运行期间owner修改环境服务URL、随后正常JSON环境变量提取保存，会使第二请求转去新host。旧集成根owner流程以及未改develop的owner/MCP HTTP/MCP stdio/CLI四入口均有真实loopback RED；初次develop夹具清理方法不适用的问题另保留，随后四入口重做明确RED，不拿清理异常冒充行为复现。
- 新独立draft PR46 `fix/run-service-context → develop`，local `579608020d3d2225d63ca2ccfaa7c3028cbb3d58` / remote `a6e62ee34237ab8032995a37cececef3a0d353d4` / tree `6fa11855b91d1159e0a55530f22313ef912b9f03`，无额外base依赖。最小私有resolver在执行前只分离选定环境ID/服务URL映射、服务ID目录、folder binding，不复制/冻结变量值；本次运行地址不漂移，下次运行仍读新配置。四生产文件变更，不改scope提交、数据库授权、Cookie、取消、保存收据、预算或前端。
- PR46首次CI `40595195067` 10/10 GREEN，actual checkout `c4bee6c25cebdb07804145d3d333bcd69e9e3504` 与提交同树，parents develop88f70bb+a6e62ee。三个实际core ZIP SHA256/大小/CRC及完整TAP核对，三OS各1035通过无fail/cancel/skip，1030顶层加2/3嵌套计划连续，全部12新增用例在实际TAP通过。旧workflow不含core manifest或packaged-stdio，不借用root能力；三平台自有desktop日志smoke通过，desktop ZIP字节未校验。
- 根生产合并 `f978efb7dbea67b38ab4204e57775584f3418ae6` / tree `33d8fa3a71309d4df154155d58310fc4115042af` 与独立组合f291629同树。CLI保留selectedEnvironment及临时授权/取消链；MCP保留effectiveRequest→inputAuth→assertNativeInheritanceMCPInput→applyMCPInput顺序，只替换resolver工厂。load-runner没有此次scope持久化刷新别名，不为对称性扩展补丁或增加负载。
- 根只增加组合测试的 `6603e93a95db8ff65b983e9a563ec551f5afcf06` 已cherry-pick为 `42b39b502438ccb3621e043d13f9a79e25304947`，精确同树 `810e21f44ba024d7fc074bf34d4abb192a2309b7`。同树4完整文件24/24通过，0fail/cancel/skip，6.815秒；独立17-case工作流文件亦通过。没有为凑数重复跑相同根批次。覆盖四标准入口及原生HTTP/stdio aliases、授权拒绝、当前配置的single调用、下一次执行、删除/空地址、取消、变量冲突保留响应不重发、跨项目与备份重启。
- 另六入口真实postjournal activity-save故障控制保留两个实际wire响应、已提交变量/配置、未知且不可直接重试的收据；恢复同run ID一次，其他项目不变，无HTTP重放。注入仅在原Store方法边界制造测试自有history路径障碍，原save/journal/read/recovery仍执行，不伪造错误。root-only原生/typed receipts不冒充PR46独立base覆盖。该组合及check/fullformat/diff来自同树验证；之后只有本文变化，新根仍待自身CI。
- 原live-reference计划模式只做了可行性评估，**没有实现或启用**；先修已有合同错误，不新增前端或数据格式。SQL Server依赖/许可、Oracle/达梦、原生自动化图映射和历史未明失败仍保留。没有main/develop合并或部署。

## 21:30 现有错误证据保留，不是中断修复

- Digest组合 remote `0534974e0c4cd9db14cfa62cd6097101eb10fcfc` / local `a12c719daed4d13de950942a25a8c97eb9d7086b` / tree `dd2c010da0a8e7bf162e149e713c71bfd73af276` 的首次CI `40583658222` 最终18 GREEN/1 RED。全部19实际checkout同根，12实际ZIP摘要/398文件manifest/TAP完整，hash `0a354d56d1ad7f26f7b62ffd5e922adb1cbf4b7a6bcc066f0528f646d085b026`；Linux2106通过，macOS2105通过/1失败，Windows2099通过/7明确skip。所有49 Digest用例及7非core job均在实际产物通过，但不抵消组合失败，最后完整GREEN仍8fb。
- 唯一失败是macOS shard2 job122469368142，native-xml-assertion-boundaries第128行原预期/自有字符串/，实际Error: interrupted；该test总耗时930ms，不是失败worker的活动时间。源码375行说明worker exitCode0且返回completed error，不能定位中断发生阶段。原Error已带stage/operation/activity/cpu等字段，但实际TAP没有保留值，不能据此说运行时没有诊断。
- 只读比对旧9e65桌面失败：373ms在user-script区域，promise-state只是下一次尝试操作标签，其测量耗时为0；CPU差值不证明基础设施原因。旧6c quota缺底层错误/具体变体，甚至尚不能认定为中断。各失败分开保留，未执行任何新的VM/XML/压力/字节码实验或重跑，也未改变预算/错误优先级。
- 同PR26 diagnostic-only local `e249793af4719518594d93b59c6c7c2692eec149` / remote `e2d676b1c6b7fb1940e615a3237cc60b5e4ff491` / tree `f7a40bf14118b818fd0233b6ad03e8df33473842` 已保存，base `4a79927b` 未动；既有自动CI `40587001028` 证据待核验。只改4个docs/tests文件：原phase输入与调用数、原assert.rejects正则均保留；同一worker Error不改写原样重抛；仅该断言本身失败时向同一AssertionError.message追加不超过2KiB的固定枚举/数值白名单。
- 诊断不读取getter/proxy/继承字段，不序列化源码、body、变量、message/stack、路径、networkRequests/databaseQueries；缺失/非法/非有限/超限字段省略而非编造值，保留零。独立审查10个纯合成测试通过；另一个仅Node/helper的临时子进程预期失败，实际TAP确有一次白名单后缀且无敏感哨兵。没有执行原XML或VM负载。
- 根合并点 `58a66b0143df50e387253d675c9c67b3f2d3bae1` / tree `00971ddfd37fa1e75d2deaffa535c5e67cb2f5a6` 自动无冲突，只有同4个docs/tests差异；根本地仅运行10个纯合成测试（10/10）及语法/格式/diff，不以此宣称XML通过。生产代码、scripts、workflow均无差异。新组合仍须自身普通CI；即使随后GREEN也不能宣称既有中断原因已修。
- 新公开项目形态/EchoAPI适配器结构证据记入NATIVE-AUTOMATION-STATIC-GAPS，仍不构成原版自动化树/执行合同。SQL Server依赖审计与许可、Oracle/达梦及旧失败根因等缺口未消失。所有修改留在任务分支/原功能draft PR，无main/develop合并或部署。

## 21:03 多认证挑战 Digest 闭环候选

- 20:42重新核对PR1/2/13/14/17/45与集成分支：head及精确CI未变，工作区源码无回退。最后完整组合GREEN仍为 `8fb3f5616560c0d84e10dcdddbfa0bff1ce77884` / local `e621ebd09365d12d7ff9f7443dd3b79c5e2340d8` / tree `785afcab0a3499936415a4d8b5b034cba8d698fe`；首次CI `40572206620` 19/19，全部实际checkout同树，12实际ZIP摘要/397文件manifest及完整TAP已核对，hash `34b67aeda095eca528a4ec2a8e5f71ffbd27446e2148a425cc1ed7ceaabeb453`。Linux/macOS2065通过，Windows2058通过+7明确skip（3权限/4 POSIX），无fail/cancel。旧独立SQLite写结果未知、桌面脚本超时和配额失败仍未确定根因，不被该GREEN消除。
- 真实loopback复现：配置Digest时，401的Basic-first/Digest-second只发生一次请求且返回401；顺序反转会把Basic的realm混入Digest签名。初始复现第二请求仅检查header、不算服务端验签通过。同PR20保存RED回归 local `9bbed33` / remote `23f253cc0911865a73125cf85e1debb8acd92b01` / tree `8d172ce1c51c59148fec065ea57003ba005d1bdf`，27项9pass/18fail，未拿它验收。
- 最终修复同PR20 local `f18c7b0824c71f89259f5a0bc04c5a9791e68850` / remote `3bbbbdd0d9b8a550ddd32458bdf3a6febc7d0dbf` / tree `60ef7f2c9ead1ca1d5ae8d3422bcc9ff16033a01`，基于develop，无集成根依赖，首次CI `40582243792` 已10/10 GREEN：all actual checkout `0988c99b4ff7fff2d095757371c1ce7ae25fd5c5` 与最终功能tree一致，parents develop88f70bb+3bbbbdd；三个实际core ZIP SHA256与CRC/TAP完整性核对通过，三OS各1069通过、0fail/cancel/skip，1064顶层加2/3嵌套计划完整，测试身份hash `32c1055ea9241684a0fb7348690152fb079fc3e93138299716a343eca2769064`。按RFC9110认证语法隔离challenge/auth-param/token68/quoted-pair及有界空列表；按RFC7616服务端顺序选择首个支持的Digest，不自动降级Basic，也不是任意改排算法强度。重复/歧义参数及空/仅逗号qop明确拒绝，不能跳过坏的首选挑战去签后面的MD5。
- 保留一次且仅一次授权重发、原始multipart/binary/body与Content-Type、全局绝对deadline和取消语义。真实独立服务端hash oracle覆盖两种header顺序、未知算法/合法qop跳过、带逗号及转义字段、所有现有sess算法、跨身份/正文隔离、owner及官方MCP HTTP/stdio。拒绝项目夹具含真实可执行接口并检查明确未授权，排除“接口不存在”假阴性。最终功能批次68/68及check/fullformat通过，独立固定ref三整文件48/48。另一次1067/1067全量本地运行过程中工作区有修改，仅保留诊断日志，不属于c800或f18任一固定提交的通过证据，不再重复全量本地跑数。
- 根生产合并 `235ac8f54ef07001a55afecb6f8ac0fddf4f484e` / tree `b562d046033297c1849968ae5b3edb1f9443bd72` 自动无冲突，18完整文件117/117通过、0fail/cancel/skip、26.136秒，涵盖认证/共享认证/cookie/原生继承/MCP/repeat/保存收据等。随后仅增强根完整流程测试：单/多challenge各四次owner执行经恢复/重启，再修改活动接口密码及URL，各自两次真实CLI执行冻结计划；每链12请求、6独立multipart boundary，所有owner/CLI结果显式200且服务端验签valid=true，已保存source=cli收据/原始冻结计划，定义不存重发准备态。
- 根最终测试点 `caf6ee952fc75de19d42a64490d23d04d948419f` / tree `5c6486f1745cc9e85531dc1e0edbd52c6685efc3`，三完整文件49/49通过、0fail/cancel/skip、2.990秒，check/全量format/diff通过；独立审查指出2dc时只有全局wire oracle、没有逐run body.valid，随后caf6实际补齐三个显式断言并重新运行；不将旧描述冒充已存在的断言。不把重叠批次相加成产品交付率。此后仅本文记录修改，新组合仍须自身CI；不借8fb结果。
- PR45独立驱动草稿已推进至 `5ad68c19d155b7ccbda0adac7b5682418c00a288` / tree `e5187f4d4976b84a8bbc37692ddbda46d70c28c4`，CI `40574144922` 6 GREEN/4 mandatory-audit RED（同一Azure identity/msal-node依赖链2个HIGH条目）。三OS各1038核心通过不抵消审计失败；public provider仍关闭，未连接真实SQL Server、未纳入根。许可问题仍未答，未接受或启动服务；Oracle/达梦及原生自动化平级图证明等缺口仍在。无main/develop合并或部署。

## 19:46 读回故障夹具修正，独立桌面失败仍待解释

- PR17旧final `64924099` 的首次CI `40570778466` 为9 GREEN/1 macOS core RED：实际1051项中1050通过、1失败，唯一readback夹具报Missing expected rejection；Linux1051通过，Windows1048通过+3明确POSIX权限skip。三份实际ZIP摘要/TAP已核对。异步fs.watch没有保证先于最终read执行，未制造预定故障；不是放宽产品语义可解决的问题，不重跑旧tree。
- 同PR17 test-only local `c303dc6c921156e6b202e9809ea334a10c909a5a` / remote `f3e30234315085e46d13d52e6c88c63f945d486e` / tree `385d34c191453c4328b17a5364c4deba9b0fa301` 已保存，新CI `40571911488` 尚待。仅测试内包装精确目标readFile，确认metadata存在且journal已移除后，真实rename该metadata，再调用原readFile获得真实ENOENT，finally还原builtin。没有伪造Store错误、产品hook、等待调参或预算放宽。功能相关完整文件批次44项测试通过；原20文件139结果保留但不替代新组合自身验证。
- 根旧存储 `9e65bcc5280297d28477187a31cc4e2ed1ea785f` / tree `a49ba916ed4717d3728b3a9eba3cc11647d09465` 的首次CI `40571220917` 已观测两项独立失败（当时尚未全部结束）：macOS shard2 job122425619283同一readback夹具455pass/1fail；另macOS desktop job122425618783在desktop-smoke.mjs:236报DESKTOP_ORIGINAL_SCRIPT_FAILURE，脚本250ms预算下userScriptMs373、CPU78418us、elapsed981ms、promise-state。后者根因未定，不能归为存储夹具、不能凭后续绿色证明修复；production stdio及新shutdown测试此前通过。没有另跑VM/XML压力或专项复现、未更改预算。
- 根test-only合并点 `afd75b0f4569aa3032c293c229fca9d49ad47bc6` / tree `8cb8ac4a9ab30290a5075d95cc0be5ec4296ec5a` 上3完整文件（创建、提交outcome、自选/默认目录MCP故障恢复）30/30通过，0fail/cancel/skip，11.011秒；check/完整format/diff通过。生产实现与已跑20文件组合完全相同；仅确定性测试及静态研究/检查点文档新增。新根仍须自己的CI，最后完整GREEN仍8d72。
- 新静态补证已写入NATIVE-AUTOMATION-STATIC-GAPS：样例默认设置适配器不等于saved automation，原sandbox已证变量返回抑制而非运行隔离；原生平级事件图构树缺口未因补证消失。

## 19:39 自选目录创建事务组合候选

- 最新完整WS组合GREEN为 remote `8d72c6c86674725bd2c99bb6fabb509e15409f6a` / local `d5e9db7357e10a993dedbbe7a385382604da2620` / tree `05c8475384003e2dc283edbede6ff15c45763f2d`；首次CI `40569396940` 19/19，通过全部实际checkout同根核对。12实际ZIP摘要/manifest/TAP：396文件四分片各99，每OS完整互斥，manifest SHA256 `afa436531c57c04840078a1851d3976b190dc6246491d3a65b18eca1e678872a`；Linux/macOS2047通过，Windows2043通过+4明确POSIX signal skip，0fail/cancel。10个新增WS入口实际全部通过，真实DB/生产stdio/三平台桌面关闭与ac4822重建亦通过。先前import-only `37f9a614` 的CI `40568508762` 是14success/5cancelled，不算通过。
- PR14最终 `25175a10` / local `85c6920` / tree `7fb0b16b298c36dd299421ffb02c2e2e02f13f08` 的首次CI `40569090203` 已19/19 GREEN；all actual `bfb794329d95f97e96000d24153aa301567e751a` 同树；12实际ZIP摘要/280文件70×4及TAP完整，manifest `c02599a940cadd703c581e68a1bd83c413b1d6bf45310cb0c64b9ef4ec5535ef`，三OS各1259通过无fail/cancel/skip。功能HEAD未为自证CI再推进。
- 本轮真实owner POST在测试自有不可写自选目录复现：先发布.locations、后保存前EACCES，无project/journal却留下登记，重启后新建全被恢复保护阻断。沿用PR17修复，保持.locations格式，私有版本化创建意图在注册表锁→项目锁顺序下发布，独占保留全新ID目录，项目可恢复后才公开登记。中断意图只在确认无提交标记时退役，不删除任何用户目录/数据；已发表登记即使文件后来缺失也保留，不当成未提交清理。未知锁/EACCES保留对应ID恢复证据和新建保护，不阻止其他健康项目/服务启动；该ID的get/save均拒绝，健康ID仍能读写。
- PR17 final local `4337d2df49f729375034e033794eb66620b4a993` / remote `6492409935c3833d862fe6dc57d03b5f1ce1a2f3` / tree `b4d214ac76709c281491980559326c9217c97ed6` 已推送，首次CI `40570778466` 尚待。真实进程关键窗口中断、固定并发交错、目录碰撞、pre/postjournal错误、注册/清理故障和最终读回ENOENT后同ID revision1恢复均已测试。最终独立2整文件25/25、作者10整文件62/62及4项有限HTTP入口通过；不能替代跨平台证据。
- 根生产组合 `bd82976049ac0cc2883621cfd52dc1065b3acd6c` / tree `12d0ab55c701f4326b10dfcfc21fdabeacd53649` 上20完整文件139/139通过，0fail/cancel/skip，51.327秒；check、完整format:check、diff通过。根另加默认/自选目录×HTTP/stdio官方SDK的真实import postjournal故障→相同事务修复→重启→原生出口链，保留不执行请求、不重试导入、无其他项目改变断言。合并保留description、磁盘/legacy继承图验证、全部现有validator、两处取消检查、锁内图身份及操作context；独立对照无丢失。此后仅本文变化，新组合CI尚待，8d72不能借作新存储根通过。
- main/develop未合入、未部署。SQL Server仍仅PR45契约WIP，真实驱动和原版许可缺口不变；旧配额偶发失败根因未知，不以新GREEN遮盖。

## 19:27 明文 WebSocket 完整组组合候选

- 同PR14 final local `85c6920d3bc695952cd8978ae8b7720dfd6c5191` / remote `25175a1016737c04facb114ed3e02d6315ceb276` / tree `7fb0b16b298c36dd299421ffb02c2e2e02f13f08` 已保存；功能首次CI `40569090203` 尚待。纯依赖base只从旧ad1e9e90加PR13推进到 `03b3e52bd5e3e26b389611939e862e67b1c80b52` / local `dcd1e331a1564a70e431fcfbe024884e0cf3d855` / tree `e0339b7ac2d37878802bef1edd66f025079fccf4`，不含PR14或集成根祖先；PR43固定base未动。
- 新出口保留完整 source-backed websocket2 消息组，包括原顺序、param_id、惰性response、Unicode和显式空文本帧。只有新 `sendEmptyMessage:true` 的空文本可迁移；历史无标志/false的receive-only不被偷偷改写。缺失/额外/编辑定义、历史身份塌缩、剥离凭据、未知profile/模板及WSS依然拒绝。
- 真实两格式×HTTP/stdio官方SDK的四条完整链均含两代往返、owner调用、冻结CLI后编辑活动定义、持久化收据与备份重启；每链12个实际帧中4个空文本帧。Header及重复/编码/Unicode Query逐项比对，ws→wss跳转目标连接为0，安全验证和时限未变。独立审查两完整文件7/7，作者12完整文件49/49；均不是原版完整会话/重连/TLS等价声明。
- 根合并生产点 `f2715b44df1845ad5dba8f4d4864ced31979b9f8` / tree `e5d6d6614cb492ecb0ba8d6a93ad6c7e7b1732e7`：唯一import区冲突保留全部根数据库/提取imports，最终modern文件与合并前根完全相同。17完整文件84/84通过，0失败/取消/跳过，30.636秒；包含原生/扩展协议迁移、模板/握手、冻结计划/收据/live自动保存及实际宿主关闭，check、全量format:check、diff检查通过。此后只有本文记录变化，最新组合跨平台CI尚待；此前6b仍是最后完整GREEN，不借旧CI验收新根。

## 19:23 已验证回收闭环与 WebSocket 工作中候选

- 最新完整组合 GREEN：remote `6b2e5f441ef11e142ddd9003688f614b4991dfb1` / local `4dc86ddcb3367ece23013976ae79d7d36c85ee9b` / tree `9c5b439f3a7442f1e2863dd4efbe999d828a7cc6`。首次 CI `40562450287` 全19项通过、actual checkout 全部同根同树；12份实际核心 ZIP/TAP/manifest 共393文件，分片99/98/98/98完整互斥，manifest SHA256 `b8092817b2c2301c9e240073969507b4f85dfb9a8119def171628744b5505cc4`。Linux/macOS各2037通过，Windows2033通过+4 POSIX skip，无失败/取消。保图软回收/恢复、被冻结的用例/计划/repeat经真实备份重启执行、历史隔离及真实DB/stdio/桌面关闭/ac4822重建已覆盖。
- 上述通过不修复旧 `6c238a41` 的 macOS累计配额作用域偶发错误；PR3只补诊断，具体根因仍未知，旧RED不撤销，不放宽任何运行预算。
- PR13新增 WebSocket 结构身份冲突拒绝和显式 `sendEmptyMessage` 意图：local `f60c46cc98e9cd8b0a7c6805a20049a238eb51e5` / remote `1288991d44d8c279dbbc2db6920b8fd77b57bbaf` / tree `af99dd5b0036da179acae3ba6680b0691edaecb7`。首次 CI `40566707501` 全10项通过，实际checkout `823c4d59c1cd2d691a4cd2fe78beb03cdb7f86c9` 与功能head同树；三份实际ZIP摘要与TAP核对，每OS1063通过，无失败/取消/跳过，包含真实空帧/旧receive-only、子进程重启、冻结CLI及备份恢复。独立审查另5个完整文件20/20通过，无已发现阻塞。
- 新组合仅保存为WIP：local `8566a6ce95a1b042c8094ea4b4d1f23ee7a9a50f` / remote `37f9a6148f82964cc00100db3ec20fc84f899f46` / tree `1b09439eece9acc7cb1e65fd8a67588dc5a9de70`，parents6b2e+PR13。此刻自身CI尚待，不借上次GREEN验收。完整明文WS消息组出口继续在同PR14开发，WSS/不明模板/剥离凭据等不安全或无法证明的迁移仍拒绝；不声称完整原版会话/重连/TLS等价。
- PR45 SQL Server现阶段仅严格查询编译、配置和可注入连接端口契约，local `fe07d28e92c51886218f50d8c2776024a22f8845` / remote `0edebcc2a5e49fa743611733dc6a5a6ee12c3c7e` / tree `2700eed56c71beb4a91a7c80c4ad49a70e510ea4`；首次CI `40562342003` 10项通过，actual `3ddb5ea9a54c56b22916e22adef0b56bb3e8ebde` 同树，三OS1030通过。没有真实驱动、没有HTTP/MCP/CLI供应商入口，不纳入根；SQL Server Developer2022明确许可确认未到，未启动服务。Oracle/达梦也仍缺实现，不描述成仅缺测试。

## 18:34 保图API软回收／恢复与诊断组合候选

- 最近根 `6c238a4181dc898ddaebded7c5dd7b4881b702f0` / local `e8d421fccb9184dc5576305b60c11b6f0ef0d75e` / tree `68ac43179dc6e15395953ee79dda2657c25089cc` 的首次CI `40551216982` 真实18/19：唯一macOS shard4 job122355165512在script-sequence-budgets.test.mjs的cumulative quota作用域断言失败，实际project、预期request，836ms；原日志未暴露具体quota变体或底层error，根因未知。全19actual同根，12实际ZIP／manifest／TAP393文件99/98/98/98完整，hash `b8092817b2c2301c9e240073969507b4f85dfb9a8119def171628744b5505cc4`。Linux2033通过、mac2032通过/1失败、Windows2029通过/4POSIX skip，0cancel。新增结构移动／repeat／history及Mock、DB／stdio／desktop／ac4822通过，不能抵消此RED，未重跑或改预算。
- 最后完整根GREEN为 `da97a0e92045fca96538092b1d624816fac17924` / tree `d869200a5daa57fd404e2567303835fd35071bd0`，首次CI `40549158177` 19/19；19actual同根，12实际392文件4×98，hash `faa15e361f2805005de2733cd90e685e5722cae538bcb7c11875fb0326a449d7`。Linux/mac2029通过，Windows2025通过+4POSIX skip；Mock13完整媒体及两SDK/CLI链、旧迁移、DB/stdio/桌面/ac4822均过，原本地聚合30s取消仍保留。
- 软回收同PR43 final local `a4235ad5d9cb72059e49dcd226e8c4fc66eada7f` / remote `979fa1d88f182fb578ef83c340c0181a262be7a8` / tree `e1a8f7347134287c5e7e6e40397f59316854d06f`；独立CI `40555843698` 首次19/19 GREEN，19actual `5ad5e6f558b37287ce6a78ba0bc61f4583ab775f` 精确同树，parents9c66155+979fa。12ZIP摘要及278文件70/70/69/69完整核验，hash `29776f37f4778074a5835a04469b678382cccb3d8411a11e7189b4da8c389c96`；三OS各1246通过无fail/cancel/skip。旧40555596360取消，不改判。
- 复用request.deletedAt，不删binding／父层／own请求／case／plan／history。日期及native批次ID由后端生成并锁内重算；普通PUT不得切换状态。resolver以项目stored状态阻断旧bound、删date伪装及cURL，只有同项目精确已存解绑快照沿原可信合同可执行。回收API不能单移，整目录移动同步绑定；恢复live使用当前父，冻结仍旧父。MCP原write/project权限与确认要求保留，native纯HTTP批次保apiResourceTrash历史，混目录／重复／foreign输入整体拒绝，不逐个save产生半批。
- 独立review发现状态数组按请求顺序比较误拒正常重排，已按ID排序修；实际反例及owner/native SDK整批复验通过。每条owner/canonical/native链在回收备份重启后、恢复后分别跑真实CLI，核wire、exact run ID/source=cli及新Store收据，未拿已有泛CLI用例替代。active tombstone原生出口拒；native删除历史恢复后仍保留且不能原生导出，不偷偷删历史；完整Workbench备份保留。永久purge／解绑／目录回收不在本片。
- PR3仅诊断 local `c7b0277919de7df0a921b8b3513742a718180b3b` / remote `1cb557d4bd1cf56c0878cd305f2ef13f569956f2` / tree `35c7ccfa16e2f0b76703eb880bf1c81434155720`：只给原断言附合成fixture的quota/error/accounting上下文，原scope／错误信息／完成scope数预期不变，无runtime/VM/预算/额外负载改动，未专门重现暂停专项。其独立CI `40553144565` 首次10/10 GREEN，actual `e43587d340755c6f799a57caf34e01264fec952b` 的PR merge同树、三份实际TAP各1038通过；该旧feature运行时e12c1e8b不是根ac4822，不能解释或修复6c失败。只用于后续正常CI若复发时保留原因。
- 根生产合并 `800ae23` 加上述仅诊断 `4b4de60326292695054a64570b647d111aeb688b`，保留Store activity／signal两次取消检查并接nativeEdit/context，既有typed收据及MCP授权不丢。根只测试提交 `97fdf0423771915314bb24121e6d2f5446f70772` / tree `aae8f9988166dfabbfbdcd8c577b88a62d7c66a1` 补owner repeat在回收、备份真重启、恢复后的三轮执行，稳定group/child/iteration、planHash、快照及真实run IDs；原线性CLI和MCP批次断言保留。25完整文件118/118、0fail/cancel/skip、54.1s，check／全库format／diff通过。之后仅文档更新，新根CI尚待；本地通过不抹6c RED。
- 新公共来源补证仅发现官方CLI发布包中的非空报告test_events，不是原生项目automated_testings出口，缺口仍在，详见[NATIVE-AUTOMATION-STATIC-GAPS](NATIVE-AUTOMATION-STATIC-GAPS.md)。未运行CLI或访问文档中的带token地址；包license=UNLICENSED，不复制其实现。
- 更正数据库剩余范围：SQL Server、Oracle、达梦provider当前未实现，包/registry/实际入口均未接入，不只是待跑许可验收。原renderer的provider列表和[官方数据库文档](https://wiki.apipost.cn/docs/project_set/database/)均有这些类型；已有SQLite是额外能力。SQL Server适配器受限只读设计可独立推进，但真实SQL Server 2022 Developer运行尚待[微软许可](https://www.microsoft.com/content/dam/microsoft/usetm/documents/sql-server/sql-server-2022-developer-express-evaluation/retail-packaged/SQLServer2022_SQLServer2022DeveloperExpressEvaluation_English.pdf)确认；没有设置ACCEPT_EULA或启动服务，不能把readOnlyIntent路由当只读安全保护。
- 没有新前端、没有main/develop合并或部署。原版新GUI、未知原生交换范围和已暂停专项仍未完成；本项目不宣称完整交付。

## 17:24 保图结构编辑与冻结证据组合候选

- 最后完整已核根仍为 `4fe9edb4`，完整证据见下节；Mock组合 remote `da97a0e92045fca96538092b1d624816fac17924` / local `0ce480a84498d1b474c1c2e2b9e893a98b92f8c5` / tree `d869200a5daa57fd404e2567303835fd35071bd0` 的精确CI `40549158177` 在本节记录时尚未全部终态，不能提前改判。新结构编辑先在本地组合，不混用该仍在跑的树。
- PR14最新测试组织头 local `16d0fddbccb55133b87ca655b0963199d2b08948` / remote `64167a694fcf1dc8c8f65ad204db7a0d1de83e0a` / tree `d4a0e8cf3ee1b29fa7b632bf7b296fcd1315ed20` 独立CI `40547887355` 首次19/19 GREEN；19actual `7f9d4c01746990ebf3226ac33660d67be3145138` 精确同树，12ZIP摘要与276文件四分片69完整核验，hash `ec79284610fc7e3ab7d70014e5f4f80f0f70d475305db08d785b5af2ff607d9d`。三OS各1247通过，13个媒体恢复完成诊断齐全；原聚合30s取消和累计测试预算增加说明保留，不冒充性能修复。
- 结构编辑同PR43 local `32352984c74762c04587e7a347be4cfcd93f429d` / remote `445a2aca780d7f2a7c4e1ba5214dc46edd056711` / tree `91e4147cf5ae73bc08d4c462ea4832bbc2670255`，仍以固定旧PR14 `9c66155` 纯依赖为base，无root倒灌。独立CI `40548657394` 首次19/19 GREEN；19actual `b29d74459491ea6a67a75f890b5890aa0b180aec` 精确同树；12ZIP摘要／278文件70/70/69/69完整互斥，hash `29776f37f4778074a5835a04469b678382cccb3d8411a11e7189b4da8c389c96`，三OS各1242通过无失败／取消／跳过。旧修复头CI `40548354532` cancelled，不作绿色；更早2075684阶段虽有绿色CI，但后来真实case／plan历史链暴露误拒，保留该失败而不借阶段绿验收。
- owner `POST /api/projects/:id/native-inheritance-edit` 仅接受显式当前configRevision及move-folder／move-request精确操作；同项目已有父目录、root父0、名称/冲突/循环边界严格校验。Store锁内依据previous重算，按允许变更与候选完整比对，普通PUT仍拒结构改动，内部选项不能从body注入。保留source ID和绑定闭合，移动后有效form／auth继续验证；回收／恢复／解绑不在本片，不建立新的tombstone信任合同，不级联删旧快照。
- 初次实际带case／plan／history移动400，原因是Store保存再次snapshot正规化引入磁盘JSON省略的undefined字段，原盘态与候选形状不同。修复为锁内两侧同样走既有snapshot正规化再比较，不移除证据保护。独立原RED已转PASS；旧用例／计划仍用旧父配置，live使用新父层，未授权、旧revision、缺ID／跨项目父、循环、冲突与注入原子拒绝。
- 根生产合并点 `fa371fbcb651a73dc4ded4057fc1041f818ed2d0` / tree `0627849cd7dc26811badb424af5042aee28cd0f8`：runtime保留activity／signal及两次取消检查后加入操作；server保留损坏存储下protocol证据读取路径再加owner动作。根仅测试提交 `0c8bb4b9f96a4d2b79b2a49626faa72734c8c848` / tree `54f0fd6a9cba04f06580521bb93ce0114e3da7eb` 补真实repeat交叉，18完整文件91/91通过，0fail/cancel/skip，42.393秒；check／format／diff及代码树一致均过，生产0额外修改。后续仅本文及README变化，新根CI尚待。
- 同一真实长链先保存并执行普通plan／repeat及case，目录/API移动中核plans／cases／history／runs不变；重复组leaf/group/occurrence及planHash保持，移动后和完整backup真重启后继续执行并用新Store核保存收据。native repeat出口仍明确拒。旧冻结folder消失时plan-only目录出口仍拒，不重建被移走的目录；仅API移动且旧目录保留时graph＋HTTP flow可往返，live新父与冻结旧父分别验证。含cases完整原生出口仍拒，definition-only双代使用明确拷贝去cases/plans，不冒称含全部历史的迁移；完整Workbench备份保全部。
- 未新增前端界面或将普通UI PUT改为新动作；这是owner后端闭环。VM／预算与暂停专项、原版运行／许可边界未动；无main/develop合并、无部署。原生automated_testings及其余未证范围继续单列。

## 17:03 Mock媒体定义往返组合候选

- 最近完整根 `4fe9edb4e08f9680973a4153552afaf0d8f33dd0` / local `df484ae374d2bb9c26f14fbb436a1aab892f2022` / tree `cb8801eb2f28b6c3c16ba86329dd8a4cf0ba8c43`，首次CI `40545009149` 19/19 GREEN。全19实际checkout精确同根；12实际manifest／TAP391文件98/98/98/97完整互斥，hash `1e2ac66e105f9552e1ec79f58fa517217d2e8e6442ff106085f59467cb69e010`。Linux／macOS各2016通过，Windows2012通过加4POSIX skip，0fail/cancel。新增身份原子拒绝、扩展协议双格式双代SDK／CLI／恢复、图＋HTTP flow及旧任务／样例／模型／form／repeat、DB／stdio／ac4822、新旧桌面smoke通过；不包含本次Mock媒体扩展。
- PR14前一扩展协议最终 local `3cf614c9f5371d5c95acc168cb8429745c5eaff3` / remote `0fcf194b4ccd5e63378e662318e0a92650561655` / tree `ee0cb09f70dab09b4d5f509c8d16355d9465f433` 的独立CI `40544142159` 首次19/19 GREEN。actual `6d781f0e666db0254501e83a8f5ecdbea10f7c60` 精确同树；12ZIP摘要／275文件69/69/69/68完整，hash `5edceb122262f78d8dc4a3951b4b88df9321f3d4c97d5efab830d23bb02d341d`，三OS各1234通过无skip。旧415c的CI `40543466237` cancelled，不作绿色验收。
- 新Mock媒体同PR14 local `c99807044481f0199482578ba72f42996676ccb2` / remote `e545009a54b974be937babff4a1a792d10604933` / tree `29f598844c2d712d11c75a479d9aaf5e18b02b5d`；5完整文件20/20及check／format／diff通过，独立CI `40545977209` 首次19/19 GREEN，19实际checkout `c01c64dc5f1b020cfbc2548924f10b11db9b451b`，parentsad1e9e90+e545且tree与local同；12实际ZIP摘要核完，276文件四分片各69完整互斥，manifest `ec79284610fc7e3ab7d70014e5f4f80f0f70d475305db08d785b5af2ff607d9d`，三OS各1235通过、无失败／取消／跳过，新整链均在实际TAP通过。根生产合并点 `a099d4deb4848124400940e7f9ae665020ebaa01` / tree `29999f01fd3dba7d3112222d2d7e00203216d250`；根测试提交 `8b2d34b1` 扩充既有HTTP+JSON、stdio+目录两条代表链：对象匹配、false标量、Unicode／JSON5-looking原文fallback，经两代重导、3步CLI消费、真实保存收据与新Store／备份重启；没有宣称四组合。最新测试组织修正仅PR14 local `16d0fddbccb55133b87ca655b0963199d2b08948` / remote `64167a694fcf1dc8c8f65ad204db7a0d1de83e0a` / tree `d4a0e8cf3ee1b29fa7b632bf7b296fcd1315ed20`，独立新CI `40547887355` 尚待。根最终 `66bccf35ba0af26548f946f54950356127268f84` / tree `081a4cf3ae8b651c730da9bc5632cc4563208bb1` 上14个完整文件81/81通过、0fail/cancel/skip，check／format／diff均过；后续仅本文文档变化，新根跨平台CI尚待。
- 复现原先能导入／真实服务／计划执行／保存恢复但两出口400的schema false、raw0及Unicode文本；数组对照原已200，不算新增。现在仅接受既有scalar-text及无serialization的raw；五种标量根schema保原定义、不采样，raw逐字映射schema{}，完整prepareNativeMock回读深等保护保留。错误schema仍在实际执行报错，不在出口改成常量、成功或fallback；未知serialization、raw-xml/XML、引用及脚本依赖继续拒绝。
- 真实条件规则顺序／disabled／fallback、显式headers、10ms延迟、声明sourceStatus与wire固定200合同保持，消费者计划保存真实结果；两格式两代与备份／真正服务器重启、另一项目隔离已在功能批次覆盖。根扩充既有HTTP+JSON、stdio+目录两条官方SDK代表链，不冒称四组合全矩阵。
- 合法Mock asar成员server.js SHA256 `317c5e22d425790f4ee677ab6b9d5e4a5bbe0c6d3bf0c943e0c4e7f9c339ff88` 的242–322支持标量文本，329–334 raw先JSON5.parse、失败才原文，95–101成功后JSON.stringify；来源archive SHA256 `615038524b769a7bd5233ae200fb263e13195ef814f38c7fa00a105ee9cfdee8`。仅静态结构事实，不复制实现、不运行原版；定义可逆和Workbench实际响应往返不等于原版逐字wire兼容，不改变既有正文行为。
- 保留初次14整文件68pass／1cancel及独立owner文件再次30s取消的真实结果；有界阶段诊断证实最后媒体在约30s才到第二格式末代，尚未全体重启，不能借未完成步骤验收。随后拆为13种媒体各自完整双格式／两代／恢复流程，每case仍30s且顺序执行、全部原断言保留；文件累计可用时间确实增加，不笼统称所有测试预算不变。应用／VM安全预算和CI job10分钟未放宽。最终媒体13case耗时累计15.89s、完整14文件46.83s，均有恢复完成诊断；这是夹具组织修正，不是产品性能根因已修证明。
- 不用测试数折算产品完成度；保图结构编辑生命周期仍是明确能力限制，另在PR43按现有CRUD合同评估。原生automated_testings／安全TLS与凭据来源范围缺证、SQLServer许可、原版新GUI及暂停专项未完成；前端暂缓。未合main/develop或部署。

## 16:43 原生定义迁移组合候选

- 最近完整根 `bfdd6a38629dc5b95be27dbf71f3f9ad70b026c0` / tree `7f2dad7f5eaec76cfd27885e94a82b2567e429bd`，首次CI `40538559764` 19/19 GREEN；全部actual checkout精确同根。12实际ZIP／manifest／TAP387文件（97/97/97/96），清单hash `1b12d6a763f7e57a564ef4a506bcc032417ae6675ced146f073d410d1aeb78c5`。Linux／macOS各1998通过，Windows1994通过加4个明确POSIX信号skip，均无失败／取消。新旧桌面smoke、真实DB／SSH／TLS／stdio及ac4822重现通过；不包含本节新迁移组合。
- 本地生产组合 `9c65a6ed640e7a7fb0b2e3900bc445809d199a64` / tree `c3576b7b4991459c952726a559f21bc9e69a862e`，合PR13身份拒歧义、PR14扩展协议出口及PR43图＋HTTP flow。共同exporter保留prepare／verifyExtended及validate／verifyInheritance两套路径，旧native任务出口、DB／JSON5／PRE、repeat叶子遍历不被旧分支覆盖。最终测试基线 `e71198d7e737558f065ffcd24ae1593a1c6d05dc` / tree `f5440c7d6f992a0a833ff22296975afac52bf70b` 已通过21个完整相关文件92/92，无失败／取消／跳过；check／format／diff均通过。运行期间仅检查点文档变化，代码／测试树一致已核。根候选待推送和跨平台CI，不能声称新组合已验收。
- PR13 local `357b45686e4a93c522931a2d88c1b6bbe09d50eb` / remote `d7dee8adfa1b92dec8096d2a3b03ebd745c54ee4` / tree `b87b5d84d2373483026306aebe29e76d61959fd6`。实证原导入会把target/method的a:b/c和a/b:c两来源等值去重为一条定义与消息计划。保旧ID算法，以结构化tuple检查旧拼接键；包含同源项目已有归档，整批及分批／重启后均在写入前原子拒绝，正常重导幂等／不同源namespace保持。6整文件15通过及check／format／diff通过，首次CI `40542315959` 10/10 GREEN，actual `c56d46d21fe4c2e9dda25326bb4accc7d34e0985` 精确同树，3OS实际TAP各1060通过无skip。旧feature无分片manifest，运行时e12c1e8b不冒充根ac4822。本修复不修复旧已塌缩数据，出口另行独立拒绝。
- PR14 production local `415c5e53416a9b0a12276feda59cddde56ffe0da` / remote `520946a148216520984d3578ca568edc243b7bb8` / tree `3988b5e4e2807b7d99117d4dd88e2d7a1fd1c165`，11完整文件53通过、check／format／diff通过。最新仅测试修正 local `3cf614c9f5371d5c95acc168cb8429745c5eaff3` / remote `0fcf194b4ccd5e63378e662318e0a92650561655` / tree `ee0cb09f70dab09b4d5f509c8d16355d9465f433`：历史塌缩负例由两个合法单source导入结果显式组合，不再依赖已修复的旧导入bug；整文件8/8及format／diff通过。新exact CI尚待，旧415c不是最新测试头验收。首片source-backed根gRPC plaintext内联Proto unary／server-stream与Socket.IO HTTPv4文字Ack；完整来源重新生成定义和派生消息计划后逐一比较，无新增／遗漏／编辑才反向映射。消息计划由原生消息定义重建，不写成automated_testings；HTTP flow单独处理。统一重映射所有引用身份，不承诺历史ID。所有metadata行、被剥离握手凭据、TLS、非根资源、无法表达的状态均拒绝；旧WS/WSS出口仍拒绝。
- PR14两格式×官方SDK HTTP／stdio双代执行、owner／SDK／CLI／恢复重启CLI每链12次真实gRPC／Socket.IO调用、精确run IDs与项目隔离已本地验证；live定义编辑不影响旧冻结执行，编辑后的不等价项目两出口零网络拒绝。旧WIP曾因无plans缺省丢失误拒样例／模型／文档，已恢复??[]并完整回归；descriptor校验必须在classification之前，object／symbol／array自身filter或iterator访问器全部零调用拒绝，正常HTTP快照undefined兼容保留。c700和d689是修正前阶段，不能借其CI验收latest。
- PR43 production local `98af0f2ee6ca3c86f5dd6330da83e857ddf0eeb6`，最新仅ADR local `bb6dd7f06d56f412c9ec94a4f148a912d6b8533d` / remote `b5a090d4a246ecb70ff4e40785370d907f898477` / tree `2d4e8ee808b26caf8eb8c36a43046305ce209785`。固定纯依赖 `deps/native-inheritance-export-base` 在旧PR14 `9c66155ceeff7f57afda1b2368004cb3cf355f02`，避免未来PR14规格／实现混入独立树；精确CI `40542921179` 首次19/19 GREEN，19实际checkout `d8916f17045d5dcaa00d5500a733bfbb1af833ab`，parents9c66155+b5a090d4且tree同本地；12实际ZIP摘要通过，277文件70/69/69/69完整互斥，hash `72df8ccef6056420b9f827d10560bc0a95da11f61ee67c1a17065546f56bd499`，三OS各1238通过、无失败／取消／跳过。旧CI `40541684337` 16/19 RED，actual026d8f80树2208db92包含PR14故意RED规格4e5caa，三OS唯一新增extended出口测试失败；不是本PR43树，也没有证据说GitHub丢hook。旧stage ac9b66的snapshot同名行误拒和mac桌面250ms预算失败均保留，不重跑改判。
- 图＋目录flow导入按完整原生global/folder/api_snapshot合并一次，再独立冻结；live仍保留own层图。出口完整重导检查所有冻结请求、环境、身份、顺序和元数据，父新增Header／Query／Cookie／合法POST form导致旧快照语义漂移时整包拒绝。已知versionPlan四字段／真实stepID的manual／ai编辑归因是明确的定义投影，原生格式不保该Workbench编辑历史；未知字段／归因及imported历史仍拒绝，完整备份保留全部。真实owner与SDK新建计划后迁移正例已补，不仅是原生flow输入；modern JSON仍不支持flow。样例／repeat／协议混入保图合同仍拒绝。
- 首次根21整文件92项为91通过／1失败：唯一旧测试依赖“先导入塌缩数据”，而PR13正确提前拒绝。未回退保护；已同PR14修正历史fixture并顺序合入 `e71198d7e737558f065ffcd24ae1593a1c6d05dc` / tree `f5440c7d6f992a0a833ff22296975afac52bf70b`，根生产与9c65相同。原RED日志保留，随后同21完整文件最终92/92通过，生产代码未变；check／format／diff均过。保留原91/92失败，不将其改判或回退进口保护。
- 暂停专项、原版运行／许可边界不变；无新前端、无main/develop合并、无部署。native automated_testings静态缺口仍单列，不把派生消息计划或HTTP目录flow冒称该格式兼容。

## 16:09 正常宿主退出保存候选

- 最近完整根 `085c92a0aaf412b2c8c6ad0222e1eef8cbf360b5` / tree `349bb5e2bfc91ea0a39f04d688cb89d35cd23ac9`，首次CI `40535437324` 19/19 GREEN；19实际checkout都为该提交。12实际manifest／TAP覆盖385文件（97/96/96/96），清单hash `d32ddacd0d9cdaf4c82bfd6d2a480f29d489e7872c02f3a94077d6675ebea4bf`，三OS各1991通过、无失败／取消／跳过。覆盖form／repeat完整链、DB、production stdio与ac4822；不包含本次退出接线。
- PR40沿原功能分支推进，无新增依赖或重复PR：local `53a65fff7f4b0d9faf81ce6a7f218f66c4181eaa` / remote `77975d542da204f8cd5084884a7acd71e6976979` / tree `78af5ccadcf49a82297fbfdd39fe12ce5ca291c9`。本地4整文件26/26、check／format／diff通过。独立CI `40537142115` 首次10/10 GREEN，10实际checkout均 `6ce698cc7591886af233b5412afdad5b49f1de9b`，树精确同功能头；三OS真实packaged desktop-shutdown-smoke及原desktop-smoke均通过。三份core产物ZIP SHA256与GitHub匹配，实际TAP Linux／macOS各1074通过、Windows1070通过加4项明确POSIX信号skip，均无失败／取消。
- 生产组合合并点 `ea2dc424118b3286668cc914e43af58d17542c7e` / tree `9fee426787ff4258900f437616e49e9ebbeb6511`；仅server imports冲突，保留现有继承、autoImports、MCP、DB及既有close行为。该生产树的14个完整相关文件99/99通过，无失败／取消／跳过；覆盖host真实子进程／合同、wire证据、native自动结束SDK、协议模板、OAuth关闭、stdio DB授权／取消、CLI授权及form／repeat入口。check／format／diff均过，后续仅README／检查点／静态证据文档变化，无根生产或测试补丁。新根CI尚待，不能借独立分支结果验收组合。
- Node真实主入口为src/server.mjs，安装启动等待与单Promise SIGINT／SIGTERM drain；重复信号不重复保存。正常HTTP等待原完成／超时，不closeAllConnections强制终止。Electron在service ready、窗口创建／加载前安装will-quit接线，窗口关闭获准才等保存；旧before-quit早关后端已移除，原未保存提示和取消行为不变，无新增UI。
- 全会话确认保存返回成功0；保存失败／unknown或close异常固定脱敏日志并退出2，沿用持久化／基础设施失败状态，不宣称回滚，不自动重放。Node仅设exitCode允许自然收尾；Electron确认关闭后exit，无递归quit。该范围不是崩溃／强杀／断电保证；Windows系统关机、重启、注销不受will-quit保证。Windows child.kill不提供可捕获POSIX信号，相关四项skip必须单列，不冒充通过。
- 新桌面smoke实际打开TCP／WebSocket／SSE，取消退出后会话仍可读取且未保存；确认后退出0，新Store精确读三记录，重启不重连；再制造真实存储损坏，退出2且日志无路径或秘密，不产生假记录。无脚本probe或暂停专项；独立内存事件合同测试不替代此真实Electron证据。
- 原生automated_testings静态研究仍缺flat event_list到有序children及saved settings到runner option调用、非空同源样本；现有五个样本该数组均空。证据与最小补证门槛见[NATIVE-AUTOMATION-STATIC-GAPS](NATIVE-AUTOMATION-STATIC-GAPS.md)，不靠猜测解锁付费原生格式。
- 历史XML／desktop预算RED根因未改判，预算、安全与暂停范围不变；未合main/develop、未部署。

## 15:49 文本表单继承与有界循环组合候选

- 最后已验证远端根仍为 `35ea4371273f6c3e44ff86dcb526b83bb6e11452` / tree `c9cb53f80ec3a7fb1dbb5146a8eaa8ebe8289fb8`，首次 CI `40513156978` 19/19 GREEN。12份实际产物覆盖379文件，三OS均1970通过；它不包含本次两个功能的组合。以下历史段落中的“最近”“尚待”均为当时记录，不覆盖本节状态。
- 本地组合生产提交 `a6c04095066c2789d7e9b5f9fc378c8233904a6a` / tree `888e4798d2c5b659417443e045e568c488aef6d6` 已合入 PR43 最终文本表单与 PR44 最终循环及文档修正；最终交叉测试提交 `5dbd3e1520b2f74cb77926d80295bb080596cbe4` / tree `5c4517a5561590b045cb4f7cb4c8179cb8f90782` 已通过12个完整相关文件54/54，无失败／取消／跳过；check、format:check及diff检查通过。补强既有graph-bound循环测试：父／目录／接口URLencoded文本继承、UTF8／空值／禁用不遮蔽，修改live父表单后冻结循环与备份恢复后的真实CLI仍发送原值且持久结果一致。仅测试补强，无生产补丁。根组合待推送后CI验证，不能称跨平台组合已验收。
- PR43 local `feeb4b4d5044bb8abeaecc97f55e5f3e8551a7aa` / remote `856c0e61575b1ee5887a23207bf63e0708b9ae3c` / tree `7ac982061af07f35e9e125fec0cf714dd8277a21`：CI `40530114999` 首轮18/19，仅macOS桌面产物上传DNS ENOTFOUND失败，发生于smoke已通过之后；仅该失败job重试，第二次19/19。两次实际checkout `eb4e2f508bd342090928115443fc97e148e18abb` 树相同；其他18job及12份core产物不变，276文件完整不重叠，三OS各1234通过。未将功能断言失败当作基础设施重试。
- preserve图现在支持接口显式urlencoded／form-data模式中的祖先文本form行；父层不替接口选择body模式，禁用子行不遮蔽父行，重名正文参数区分大小写。真实编码、两格式两代往返、冻结定义、SDK／CLI／备份重启分别验证。文件、raw／JSON继承、动态生成、未知元数据和GET／HEAD表单保持明确拒绝。无Content-Type时由运行时生成；urlencoded仅接受已证实的标准类型，multipart拒显式激活该头。MCP临时覆盖检查冻结请求实际bodyType，即使live父层清空也不放宽；此限制亦适用于preserve图内own-only表单，普通flatten请求不变。
- PR44 latest local `709b1e21551d296e187b259869c496fb93b5a6f0` / remote `3625fe7aafb31ae5fb7cd29b3006c1d84d279bc6` / tree `6e646ac530026934e032473bc1731d46968f8248` 仅修正文档：CLI是invocation-scoped grants及原有per-query／per-stage限制，没有总TTL或总调用额度。自动CI `40531601845` 首次19/19，全部checkout `37251c8d998387ef7c16b7d5922c56519381571e` 精确同树。生产前版 `380a8d50` / remote `3b8ecf27` 的 CI `40524121998` 首次19/19，12份产物覆盖308文件，三OS各1439通过；不把前版结果替换最新文档头证据。
- 合并保留所有循环叶子遍历、来源累计、冻结绑定校验与既有PRE／JSON5提取阶段政策；未调整脚本时限、堆栈或堆限制。历史d9的macOS桌面脚本预算及XML链失败原因未修复，后续绿色不能改判；PR37仍关闭，暂停专项、原版GUI与许可边界不变。没有合入main/develop或部署。

## 15:23 canonical 有界循环与原生请求提取组合候选

- 最近完整根 `35ea` / CI `40513156978` 已19/19 GREEN；该结果覆盖此前继承组合，不包含本次循环。历史d9的macOS桌面预算／XML链RED及更早RED保持原判，本轮未诊断暂停专项、不重跑旧CI、不调预算。
- 本候选生产合并点 `d5f8897c4f9ee3e13dbdbf867119cbcb7098688c` / tree `558f2f3606efc833ca85534b0d5bc5be89f7d2ae`，合入PR44 local `380a8d50ad8ba5cfb01e1057091b070719bd8e3d` / remote `3b8ecf274dab86dc6a7a483e009fef5d886fadfe` / tree `d59172ca9c1ac4d975c72eed598855139b0b2b2c`。root保留最新原生PRE Header／JSON5Body、严格阶段政策、旧CLI非DB任务限制及既有预算；新增组合测试本地提交 `283a850d70d8867743678c66d8b30d8b515dbb82`。本轮无root生产补丁，**当前根候选CI尚待**，独立功能CI不能替代组合验收。
- 单层HTTP固定次数repeat保留定义图、group/child/iteration/occurrence身份，count1–100、潜在展开≤200、冻结和逻辑展开配置≤4MiB；disabled也计潜在上限，不生成假成功记录。保留普通HTTP失败继续与原生严格提取停止差异，不增加重试、并行、条件、数据源或嵌套，不宣称原生automated_testings兼容。
- 消费者统一遍历叶子：Store/restore、来源累计、冻结图、CLI只扫描启用定义一次并复用原invocation连接授权。原生MCP流程创建/修改/查看/执行及结果/历史投影明确拒循环，canonical历史保留真实逐轮身份；原生目录计划出口继续拒绝。现有各查询/阶段限制未放宽，不臆称CLI具有不存在的总TTL或总次数额度。
- 新官方SDK HTTP／stdio两条整链从原生输入导入BEFORE Header与JSON5 Body提取；创建3轮冻结计划后改live URL/header/body。SDK、真实CLI和备份恢复/真正服务器重启后的CLI均只发送两次：第1轮200、第2轮500；成功PRE变量持久化，第三轮和组后请求零发送。每次failed执行均recordSaved=true，CLI exit1，recordId/attemptedRecordId、快照hash、逐轮身份与新Store记录一致；源项目、另一项目及原生输入不变。
- 初始六个完整文件22/22通过；新文件首次2/2通过。最终15个完整相关文件85/85通过、无失败/取消/跳过，含四个repeat流程、组合新文件、CLI grants、native任务出口、请求提取/JSON5、既有stdio DB grants/workflow/nativeDB入口、HTTP与协议原子提取、继承图workflow。复用真实数据库授权入口，不新增未经确认的grant组合合同。全库check、format:check及diff检查通过。该证据仅本地精确候选，不代表所有后端交付完成或跨平台验收。
- 循环完成证据累计超过8MiB时仅在下一叶子前停止，取消和严格提取停止优先；最后完成叶子原样保留，不合成未执行记录。此非硬输出上限；MCP stdio既有帧限制可能在已保存后拒绝全量回复，canonical小历史摘要仍可读取，不能重放网络。
- 未新增前端、运行原版、接受许可、合main/develop或部署；PR37和暂停专项保持边界。

## 13:20 有界原生 HTTP 继承图与 MCP 导入组合候选

- **最近根结果仍是RED**：`d9cd5c0e241eb855db0d6d82f09b2293c86b44ff` / tree `94c7a6d24e50d15e06b7c14a8564f0f292cb595a`，首次CI `40503613446` 为17/19。macOS desktop job `122187225600` 在final-body脚本链报“脚本执行超时”；macOS core shard4 job `122187226127` 的native XML assertion完整链失败。本轮不复跑或诊断暂停专项，不把独立PR绿灯、本地通过或新的继承功能说成这些失败已修复。更早047d的18/19 RED也保留。
- **最后完整根GREEN仍为** `bd127a4778253a085d7a105812e7fa095b3fb92d` / tree `36986b95`，CI `40497772310` 首次19/19；三OS各1950通过，12份实际清单373文件（94/93/93/93），hash `33197e543331cb238a146cec82d4b30593b8cb9d18748a651fe4f1228979685d`。它不包含后续样例图／继承图组合，不能当本候选验收。
- 本候选生产合并点 `f8477696c039fea2183e210fd71ba05e5443e63d` / tree `2a0f644e5ec52acf46db9f5866c10269ea139e2c`，包含PR43 local `565173cdc196fcb51509ff856040615a6fd1cf13` / remote `78983e8a7fdc246be497ba9b05ad74ab3ff28117` / tree `2a9331aa53b8c52a938410104162b4fbf18ffac5`，及PR29 local `8ca7b808a1f75c0f490c3a759c13e0a5b74bd1c6` / remote `1ef5fc2f5a329b7fcfafacd098a5f2d6cb66a044` / tree `7ee8745c68c29cd0dae39c92502535ae88e57315`。后续根仅加交叉测试和本文，**新根CI尚待**。
- owner与MCP `import_project` 可显式选 `inheritanceMode: preserve`，缺省／flatten保持旧导入快照语义；export自动保留已存图，不增加工具、权限或响应字段，文档4MiB／完整帧8MiB限制不变。首片仅现代原生JSON／目录HTTP项目、目录、接口的auth/Header/Query/Cookie层及既有变量目录，必须导入空业务项目（只允许替换Store原始默认环境），已有图不允许追加或同步。非HTTP、samples、flows、tasks、继承正文等不能表达的内容拒绝，不把默认模式其他已支持能力误称已支持保图模式。
- 真实SDK HTTP／stdio × JSON／目录两代保留层语义与重映射后父绑定；读权限、跨项目、非法mode、坏图及非空目标拒绝时磁盘和网络均不变。owner、MCP、真实CLI分别验证live父层修改与冻结计划隔离、当前环境变量、服务器重启和恢复。保存的冻结case／plan仅在同项目已存完整请求精确匹配时识别，不凭caller flags或live API ID放行；篡改请求和删除可信保存源继续拒绝，原生流程不重复冻结。
- 在上述最终组合树先跑三个继承完整文件11/11，再跑十个完整交叉文件44/44：native任务出口、samples、模型与默认MCP交换、独立签名验签、HTTP／协议提取原子性入口、Digest重放、真实提交收据和scope取消。继续两个存储完整文件4/4：既有官方SDK真实journal未知提交／不重试、8MiB完整帧拒绝后会话可用；新单条交叉回归用真实项目文件锁确认保图Store保存已进入后取消，明确STORE_SAVE_ABORTED且磁盘旧图不变，后续显式保存及恢复正常、其他项目不变。合计15个完整文件59/59，未用碎片函数或重复全量代替流程；全库check、format:check、diff通过。本次未发现需在根补生产实现的组合问题。
- PR43最终独立CI `40508813117` 19/19 GREEN；PR29最终独立CI `40509016977` 首次19/19，全部实际checkout `a0290ef4e33ce0a12b8db4b0bb2bd5294d93d4a5` 与其功能tree相同，三OS各1348通过，12份实际ZIP digest及291文件（73/73/73/72）完整清单已核，hash `a92c7c25960abd604d28ea215de55f14b561ba7a6a357c5256b9a1502ed23d8f`。这两项只验证各自独立树；PR29旧49b3阶段GREEN不替代最终saved-case修复头，独立GREEN也不替代根组合。
- 历史f83/8b5 Windows XML RED及上述d9失败均未修复或改判；原版GUI、暂停专项未开展，PR37仍关闭。未新增前端、改变执行预算、合main/develop或部署。

## 12:23 SSH 取消测试身份绑定修正候选（生产零改）

- 上一根 `047d` / tree `bb36d1c` 首次 CI `40501200864` 为 **18/19，RED**，不能作为样例图组合验收。macOS job `122179026514` 的 test 527 报 `records.length` 实际2、预期0；Linux／Windows各1958通过，macOS1957通过、1失败。19个job实际checkout均为同一047d；12份实际诊断产物覆盖375文件（94/94/94/93），清单hash `a6bed60fd799cdc1324f6d82564f0ab4a1fbcf1835dd9b25cf43b20d402cc7bf`。样例及任务流程在三OS已通过，但不能因此把整个组合改判GREEN。
- 真SSH确定反序验证了测试假设错误：controllers创建顺序不等于远端peer到达顺序；旧测试的peer0可以是另一条仍活跃连接，记录中的BEGIN不证明被取消连接继续发SQL。修正以虚构认证身份绑定controller和peer，以显式认证gates确定反序；等待被取消peer真实close后释放迟到响应，核该peer零SQL，同时另一条活跃连接正常完成，避免仅靠全部连接失效取得假阳性。本次不是生产取消逻辑修复，不改变驱动、协议、预算或取消合同。
- 当前根合并点 `3922e491f2bc91e5847f548ecbd245fb3727e2e6` / tree `d77f1b8b3f938e6fe6c9073192cafd7c9c9ca7ad`，合入PR24 local `89b9ec20792c782d6c6e22d77b7c563329536527` / remote `5e78cf27d5611810c32eb8157727aece5ad849b9` / feature tree `5f4f5fe29d40f2e391871fb6b83777e8bfe31868`。合并差异仅一个测试文件，生产零改；随后仅更新本状态文档。**PR24新头独立CI及新根候选CI仍待**，不盲目重跑旧CI，不借旧绿色替代。
- 在该精确根树完整重跑 `database-cancellation.test.mjs`，6/6通过、无失败／取消／跳过；覆盖实际PG/MySQL、Redis/ClickHouse、SQLite、SSH及项目HTTP断开链。全库check、format:check与diff检查通过，未重复无关全量。这是新树本地证据，尚非跨平台验收。
- PR14样例图最终remote `9c66155ceeff7f57afda1b2368004cb3cf355f02` / tree `a3a609b57b66e59371b01e46f75064d2737b7a20` 的独立CI `40500490883` 首次19/19 GREEN；实际checkout `9aa22b29d6079c62db094dc9221e30100852c4da` 与该功能树相同，三OS各1222通过，12份实际产物273文件（69/68/68/68）清单hash `43971b749f970eb381ad29a5c82582028ab3ead350a3bd4eff9fe51f12b7ed06`。该独立功能证据不替代上述失败根组合或新候选CI。
- 历史f83/8b5 Windows XML RED继续保留，未修复或改判；原版GUI及暂停专项未开展，PR37仍关闭，未合main/develop或部署。

## 12:02 HTTP 样例／分组原生图往返组合候选

- 上一根 `bd127` 首次 CI `40497772310` 精确全19项 GREEN，tree `36986b95`；三 OS 各1950通过，12份实际诊断产物清单373文件（94/93/93/93），hash `33197e543331cb238a146cec82d4b30593b8cb9d18748a651fe4f1228979685d`。该结果包含普通HTTP提取修复，不包含本次样例出口。
- 本候选最终生产合并点 `0d0bdccaa54195d0b1f581d96bf94aced52c2f16` / tree `a572eeeb710a9e5d779b9cdd141c5d933237c877`，包含 PR14 local `eefb09e341a856d321f063374c24265cd3053d27` / remote `9c66155ceeff7f57afda1b2368004cb3cf355f02` / feature tree `a3a609b57b66e59371b01e46f75064d2737b7a20`。该功能头及根候选独立CI尚待；`035c`旧头不是最终验收。
- 样例复用既有请求编码器，保留四个冻结flags及当前定义关系；API归属、父分组、空组、分组sort及双格式最终project／target／sample ID图经完整回读核验。grouped sample 会隐式继承live API，所以新增参数／任务导致语义变化时明确拒绝，而非无声灌回；显式noauth及root sample保持各自合同。样例脚本／任务／schema等无无损映射继续拒绝，不执行或获取原生内容。普通API原有native tasks、签名认证、模型、文档与协议出口能力不能因requestNode重构丢失。
- 本批发现并修复真实排序缺陷：带数值sort与无sort的跨API交错样例，原helper按全局index排序，而实际 `caseRunOrder` 按API／分组bucket内局部index排序；旧内部oracle复用同一算法会掩盖改变。最终fix经独立两格式两代反例核验，根组合也直接调用真实 `public/case-folders.js` 的 `caseRunOrder` 构建定义比较及执行计划，不复制出口oracle。仅承诺当前有效执行顺序，不伪造已经丢失的历史sample数字sort。
- 四条官方SDK组合覆盖HTTP／stdio × JSON／目录，各自双代export/import核完整样例关系且零网络。在创建计划前加入live-only Header，确认出口因冻结语义失配拒绝且项目不变，避免plans出口限制掩盖目标guard。之后从真实 `case.request` 创建冻结HTTP计划（不存在execute_case工具，不虚构调用），再编辑live API的auth/header/query/body；SDK、真实CLI及备份恢复重启后的CLI均发送原样例body／环境值，无live凭据或参数注入。
- 每条三轮各3个真实请求；CLI明确exit0、记录passed且recordSaved=true，attemptedRecordId／recordId／run.id与新Store历史一致。源项目及第三项目不变，第二代项目保留2条历史、恢复副本追加为3条，恢复不自动联网，四个快照flags与case定义保持。
- 本候选最终八个完整相关文件30/30通过，包含样例、native任务出口SDK／CLI、独立签名验签、模型、文档、协议资源图和MCP流程；全库check、format:check及diff检查通过。根仅新增组合测试和候选说明，不改生产／解析器／VM／预算。历史f83/8b5 Windows XML RED仍未修复或改判；原版GUI及暂停专项未开展，PR37仍关闭，未合main/develop或部署。

## 11:37 普通 HTTP 提取列表原子性组合候选

- 上一根 `40b6` 首次 CI `40496321790` 全19项 GREEN，实际 checkout `40b6` / tree `cced3b82`；三 OS 各1944通过，12份实际诊断清单覆盖371文件（93/93/93/92），hash `bd735e295e628b4c23a28cb2fd27d88b0cb66485b49f976d9fbb7027d5c7b0e4`。该树包含协议提取修复，不包含本次普通 HTTP 修复。
- 本候选生产与 owner 测试最终合并点 `6712fdc9bc17f7ccd046b9bf17206db127a602fb` / tree `004ac6d9b8fbff213e0f0bf924c0859691175c9b`，合入 PR42 local `484e1660d23dc6cea087356dfefa5613ae4f5543` / remote `8f14ba761da673120a0b4864932301d2c19807dd` / feature tree `efb7fa3c34a59445bcaa06b69f8c4133255baf75`。PR42 独立 CI `40497295089` 与新根组合 CI 在此记录时尚待，不能以之前绿色结果替代。
- 普通 HTTP 的声明式 `request.extract` 仅列表自身原子：先解析校验所有行，再按原顺序应用，后行缺失时 extracted 为空且候选不会进入后续请求。HTTP 500／响应断言失败仍能提取；完整列表可供后置操作／脚本读取，后续独立 after 操作或持久化 callback 失败不扩大回滚语义。原生 native pick 严格阶段、协议计划 passed-only、解析器、VM 与预算均保持各自合同。
- 根新增官方 SDK HTTP／stdio 两条五步冻结整链：prime 提交三个独立作用域值→合法前项与缺失末项失败→真实 HTTP 回显 committed→HTTP 500 合法整批提取→真实 HTTP 回显 fresh，并验证500后的脚本确实可见完整提取。冻结后改 live URL／提取列表，执行仍用冻结定义。每条继续真实 CLI exit1，failed 结果同时 recordSaved=true，attemptedRecordId／recordId／run.id 与独立新 Store 中历史精确一致；备份恢复重启后再次 CLI，原项目和恢复副本历史分离、第三项目不变，不把CLI任意非零码误当通过。
- PR41 最终独立 CI `40495941454` 首次全10项 GREEN，全部实际 checkout `26e8c8e0f27efc06de06c4a2949ce39aba210e88` / tree `2d34a0d978221d2f15c4e4deb3ba352d17a5824f`，三 OS 各1080通过；三份实际 ZIP digest 与 TAP 已核，新增24项协议整链均存在且通过。这只确认该功能头，不代替本候选组合。
- 本候选八个完整相关测试文件71/71通过，包含普通HTTP提取、协议提取及既有native comparator阶段／SDK回归；全库check、format:check与diff检查通过。本次根改动仅组合测试与说明，不修改生产实现。历史 f83/8b5 Windows XML RED仍未修复或改判；原版GUI与暂停专项不在本次范围，PR37实验仍关闭；未合 main/develop、未部署。

## 11:25 协议提取批次原子性组合候选

- 上一根 `adf14` 首次 CI `40493836918` 全19项 GREEN，tree `0dcc7d3c`；三 OS 各1918通过，12份实际诊断产物完整覆盖369文件（93/92/92/92），清单hash `64f8804ccf1a542c922e1974f2a9a5102dc6040f9f56d67f3a9cba95c87835c1`。该结果包含 TCP/SSE 原生图往返，不包含本次提取原子性修复。
- 本候选最终生产合并点 `bf9f10f6c913b751c87397463adca0dc89be25dd` / tree `7f791c4e7bc3609ab66524877b461329dc9146a1`，合入 PR41 local `d5910dd216d03f7bb034950dfd9417ddab4f051d` / remote `c9b902ecde8448da1b344de9cdfdf530f1763d4b` / feature tree `2d34a0d978221d2f15c4e4deb3ba352d17a5824f`。独立功能 CI 与新根组合 CI 在此记录时均尚待，不将阶段结果当最终验收。
- 修复普通 gRPC、Socket.IO 与 protocol 执行计划的整批提取：先解析全部行，再提交作用域及 extracted 收据。后行缺失时不能把前行候选暴露给后续 HTTP；真实 RPC 结果保留，之前成功步骤已提交的 runtime/environment/global 不误回滚。持久化失败、未知提交及取消保留各自明确语义，不把本地变量回滚说成撤销远端操作，也不自动重放网络。既有 HTTP/原生任务提交路径和失败继续策略不因此扩大或收紧。
- 新根组合使用官方 SDK HTTP/stdio 导入原生 Socket.IO/gRPC 与 SSE 定义，导入零网络；建立七步冻结计划后修改 live 定义。首步成功提交三个不同名称的作用域值，后三族分别先取得 fresh-runtime、fresh-environment、fresh-global 再遇缺失路径；每个失败 extracted 均为空，实际成功 RPC/Ack/SSE 内容仍在，随后三个真实 HTTP 均收到前序 committed 值。独立新 Store 读取持久 environment/global，避免 runtime 遮蔽掩盖错误。
- 每条 SDK 链继续运行真实 CLI，明确要求 exit 1、failed 状态且 recordSaved=true；recordId、attemptedRecordId、run.id 与磁盘记录精确一致，不将任意非零返回吞作通过。备份、恢复、重启后再次 CLI 执行同一冻结计划，保留三条非空历史及原环境身份；未授权项目执行/读取拒绝，第三项目不变，源项目历史不被恢复项目追加污染。网络计数证明读取/恢复没有自动重放。
- 在上述最终生产树重跑六个完整相关文件53/53通过，含三族提取故障/取消/真实存储失败、原生导入/模板/协议往返及现有原生断言/提取 SDK 主链；全库 format:check、check 与 diff 检查通过。早期阶段10/10不是本次最终树验收依据；本次仅增加组合测试与状态文档，不修改生产预算、前端或继续策略。初次测试夹具假定 currentEnvironmentId 必填及回执叫 attemptId，已按真实已有环境与 attemptedRecordId 契约纠正，未为测试改变生产字段。
- 历史 f83/8b5 Windows XML RED仍未修复或改判；原版GUI、独立专项未完成，PR37实验仍关闭。未触碰暂停范围，不合 main/develop、不部署。

## 11:06 TCP/SSE 原生资源图往返组合候选

- 上一根 `fb89` 首次 CI `40490763726` 全19项 GREEN，tree `bb33d091`；三 OS 各1910通过，12份实际诊断产物完整覆盖367文件（92/92/92/91），清单hash `5cf40f71405a81424c3e8026a00fb82fd3bc8620914b3af0b8a6583e401e5199`。这一结果包含会话终态自动保存但不包含本次协议图出口。PR40 最终独立 CI `40490491130` 全10项 GREEN、实际checkout `db401c992f600c6b287955b68ee13f00f24d8bd8` 同tree `b25cfff93db1170813a8bb18d27da2812ff008f7`，三 OS 各1067通过；该功能结果不替代本候选根验证。
- 本候选生产合并点 `1af0ec44d85086700ae7617ae1978eb6bc65f586` / tree `f9d4fde29c214b046e1a1823d317405ef6ee49a2`，合入 PR14 local `b3e5d8eb0f8bc3184a4f4706805a3ef3391f9dce` / remote `2016f989` / feature tree `7081453b`。纯依赖只加入既有 PR13 原生协议导入及其必要依赖，没有 root 业务倒灌。PR14 新独立 CI 与本次根组合 CI 在此记录时尚待，不借上一头 GREEN 验收。
- 有完整原生来源图的 TCP/SSE 可在 JSON/目录两格式反向转换并由既有导入器回读验证，完整检查来源组与活动定义对应。TCP客户端容器重建为原生socket节点，方法parent_id指向同一最终容器ID，普通目录和目录格式采用完整目标ID映射。原 A 与 A/B 共存时复用已知父ID，正反输入顺序均保留。当前普通目录名称不在旧来源档案中，允许无歧义当前路径重映射，不承诺历史名字或ID不变；来源对象不修改、不重建已被删的握手秘密。
- WS/WSS 因无已验证安全原生TLS/no-retry配置仍拒绝；非原生定义、缺失/重复来源、执行字段不一致、需要运行时凭据/已脱敏来源值及不明来源说明继续拒绝。协议步骤冻结计划仍不能原生导出，本片只承诺定义图往返；创建冻结计划发生在定义导入之后，计划及历史使用Workbench备份恢复。没有新增协议执行实现、权限、预算或前端。
- 根新增官方 SDK HTTP/stdio × JSON/目录四个完整组合：read-only导出，import写权限拒绝与跨项目拒绝；write-only两代导入导出，准确核protocolIds、docIds、API/doc/model与容器关系且零网络；建立冻结protocol计划后execute权限仍拒绝；显式授权执行后SDK与真实CLI执行同计划。修改live端口/正文/URL不改变冻结结果，当前环境模板值与safe Accept-Language头在loopback实际验证。SDK/CLI各产生一条真实保存run，备份恢复重启后CLI再执行，磁盘精确保留三条同计划/环境记录，源项目、无授权项目和原始输入均不变。
- 仅抽出共享纯数据fixture和已有有界CLI启动helper，签名组合复用同helper；不import会自动执行测试的测试文件。九个完整相关文件31/31通过，覆盖签名、模型、文档、任务出口及既有协议导入/模板/CLI。新四组合单文件4/4通过。首轮夹具局部变量遮蔽 `node:events.once` 导致初始化失败，已改名并终止该次残留测试进程；该次不算产品失败/通过，最终批次重新验证真实流程。
- 本候选根 CI 尚待发布及精确检出核验。历史 f83/8b5 Windows XML RED未修复或改判；PR37、原版运行及暂停专项均未触碰。不合main/develop、不部署。

## 10:42 项目协议会话终态自动保存组合候选

- 最近完整根 GREEN 为 remote `0de7ffd1212b13c59231bd24dad3d718991a61e9` / local `fccfb590bdbedb3ede9f1333d4fcef3940aebb0b` / tree `26ea9eb4afba3d91466b44ef91b6779c81522a9f`。首次 CI `40488258072` 全19项成功，实际checkout均为该远端SHA；12份实际产物覆盖366文件（92/92/91/91），完整无重叠，清单hash `72eda2ff338a3f969d0cc07e2c4ac67a23ffaccdc946306b01924677c18b2928`。三平台各1898通过，无失败/取消/跳过；数据库、production stdio与固定引擎通过。此结果包含上一节签名认证往返组合，但不包含本次会话增量。
- 本次合入新独立 PR40 的 local `a781b5540e22214d73a2021db5d2a3d48a46d081`，根代码合并点 `f3c25d11e92b475669f8929cb679199bdb572dc6` / tree `976cf357759c2085fb0dda8a2988f88e4b300f5b`。PR40 最终 remote `6d59b88b4042629a0934606c52beb58e75aefa07` / tree `b25cfff93db1170813a8bb18d27da2812ff008f7` 与该功能local同树；base `7c5afb162c6814964ea7cc7ce8047caddcadc603`，目标 `fix/execution-save-receipts`，draft仅五个功能文件，无根倒灌。最终独立 CI 和本候选根 CI 均待验；阶段 d495 的 CI `40489516885` GREEN只代表阶段提交，不能替代最终头或根组合。
- 项目 TCP/WebSocket/SSE 会话在远端结束、错误、deadline、stop及生命周期清理时进入统一终态保存；成功前不声称已保存，失败/未知提交保留真实receipt。显式重试只重试存储，多个重试共享进行中的提交，不重连或重发；真实 journal 前/后文件系统故障下仍能读取会话收据并协调恢复。显式等待后端幂等 `app.close()` 返回 `{allRecordsSaved, protocolSessions}`，调用方可观察各项目/会话的真实保存收据；关闭开始后不再启动新的存储重试，已有保存尝试排空。Node server.close回调只保留原语义，不把settled称为durable。桌面before-quit尚未等待此接口，服务入口尚无SIGINT/SIGTERM排空处理，强制退出、崩溃及失败内存收据的跨进程恢复不在本次保证内。备份和重启不复活连接，保留现有 OAuth 关闭中断与 MCP 清理。
- 根新增原生输入到两个项目的完整链：同名环境变量生成不同payload；按保存定义打开会话后编辑live定义、变量与当前环境，后续TCP/WS发送仍用打开时快照；SSE在修改后由远端结束。六个实际会话全程无stop调用，以独立new Store确认exact ID各一条落盘，再核真实收据、remote终态、完整事件、来源definition hash和原选中环境。完整变量快照、未使用秘密及临时Authorization不进入历史；实际已发送普通payload仍保留为执行证据。
- 官方SDK HTTP/stdio仅只读项目授权即可列出和读取自动保存详情，与磁盘逐条相同；外项目访问拒绝。备份恢复、重启后读取仍一致，旧session ID不可用，网络计数保持六次，未因读取或恢复重放。历史状态与恢复对象均有非空和精确ID断言，不使用空集合通过。
- 在上述最终代码树重新运行七个完整相关测试文件55/55通过，覆盖新增原生SDK链、既有原生模板/CLI/冻结、协议导入、底层生命周期、真实存储故障、并发storage-only retry及可观察shutdown收据；额外完整OAuth生命周期和OAuth1回调文件核验关闭时实际socket中断、无迟到状态复活及原15秒总deadline。全库format、check、diff检查通过。早期阶段12/12和21/21仅记为旧阶段结果，本节依据合入最终生产修复后的新运行。
- 历史 f83/8b5 Windows XML RED仍未修复或改判；原版GUI与独立专项未完成，PR37实验仍关闭。本次不新增前端、不修改脚本引擎/预算或签名runtime，不合main/develop、不部署。

## 10:23 历史签名认证定义往返组合候选

- 最近完整根 GREEN 为 `b6ce7214` / tree `44fd3270`，CI `40486948698` 首次 19/19 成功；三平台各1894通过，12份实际产物覆盖364文件（四分片各91），清单hash `3bd8c94ca8475d21de351cd7c12d1ee832e0c382b9adc058dcf787bbc5263f6c`。该结果不包含本次签名认证出口与组合测试。
- 本候选合入 PR14 local `83df0089ff496647d3e47393cf345e72538fa629`，根生产合并点 `fa5dbc2df272f32a9b6cf5d959e8842ade47301a`。功能 remote `d1bd46d3b4699e976a9c84128d3ae76f00b67210` 的独立 CI 尚待核验；本候选根组合 CI 也尚待，不能提前标绿。纯依赖基线增加PR8认证导入及既有AWS Query基础，没有倒灌根业务；合并保持现有runtime逐字不变。
- AWSv4 Header／受限S3 Query、Hawk、EdgeGrid定义可在有界子集反向映射，转换后由现有导入器读回核验。Hawk缺省算法/载荷散列显式映射为sha256/启用；AWS signingDate、EdgeGrid maxBodySize、非字符串headersToSign和其他无法保留字段拒绝，不静默丢失。导出不签名、不获取凭据、不自动发送请求；原始模板凭据保留。
- 共享测试helper只用独立crypto验签和自建输入，不依赖生产签名器或转换器。六路包括AWS Header/S3 Query、Hawk sha256载荷散列/sha1无散列、EdgeGrid及Workbench缺省Hawk；AWS密钥模板取环境current值，EdgeGrid非空baseURi只参与MAC而实际请求仍到loopback。固定scope、timestamp、nonce和Hawk扩展字段均核对fixture，不仅检查签名自洽。
- 根新增官方SDK HTTP+JSON与stdio+目录两条完整链：只读能导出但不能导入、越项目拒绝、write无execute不能执行；两代导入导出保持零wire；冻结后修改live/global认证，再真实MCP执行、CLI执行，实际持久记录非空；备份恢复重启再次CLI验签，记录由2条变3条。每次六路顺序与错误数组为空均检查，源与第三项目不变。Owner原测试改为复用同一oracle，避免重复实现验签逻辑。
- 五个完整相关测试文件23/23通过，含owner两输入×两输出、签名SDK/CLI、既有认证导入和四格式noauth及出口拒绝。全库format、check和diff检查通过。初版组合fixture在第二代导出前设置非空globalAuth，被既有不可表达设置保护正确拒绝；只调整测试时序，将globalAuth变更放到冻结后，不算生产bug，不放宽出口。
- 历史 f83/8b5 Windows XML RED仍未修复或改判；原版GUI及独立专项未完成，PR37实验仍关闭。本候选不新增前端、签名runtime、host权限或预算，不合main/develop、不部署。

## 10:08 显式模型名称模式组合候选

- 本候选在 JSON5 检查点 local `44c71e16f40ec419356cbf51e52022126da20cf7`（remote `f5aa0478bf16bbd03ba97bfad98d5d02efe8f9a0` / tree `c507aac3449050f50cba3e4ad0cbe382f8838f00`）之上合入 PR14 与 PR29。功能组合代码 local `9f4d1903c69c69eaa98e0f01eb5de7363f9dc390` / tree `e47cebb6bb79af7dda3ff226faafe35e28faf082`；此记录随后的文档提交仍属新候选，根组合 CI 尚待，不能拿独立功能 GREEN 当组合验收。
- 可选 `modelNameMode: "preserve"` 由调用方在 owner import body/export query 或两个 MCP 项目工具明确选择；JSON、目录、冻结步骤子转换与最终回读一致传播。缺省或显式 namespaced 维持原名称空间规则，两端各自选择，不读取文件里的 mode、不保存项目设置、不添加私有原生格式字段。合法原样名称通过既有 name/display_name 承载；非空、有效 Unicode、原生200单位上限及冲突限制保持。项目改名和多来源样式名称可往返，历史身份仍重映射；静态模型图拒绝与执行权限不变。
- owner 非法/null/非原生格式选项、重复歧义 mode 查询在持久化前拒绝。MCP 默认与显式模式的响应键均不变，完整帧预算仍按原形状检查；不扩大 write/execute/项目授权、不自动执行导入。保留默认 namespaced 的完整 SDK 对照，增加 preserve 的 HTTP/stdio × JSON/目录完整模型、文档、冻结、真实请求、备份重启与隔离链。五整文件29/29通过，含真实 journal 未知写不重试及完整8MiB帧拒绝后会话恢复；JSON5/Cookie/任务出口/条件Mock四整文件16/16通过。
- 冲突处理保留根现有协议、JSON5、Cookie、任务、Mock、保存顺序和预算。相对44c71e1，scripts/worker/runtime、原生请求快照、提取及断言实现逐字无变化；本次仅模型名调用契约和组合证据。不新增 schema 执行、原版运行、前端、main/develop合并或部署，不进入暂停审查。
- PR14 remote `c08e281b7219df0a09c26ef47ccbdc940799e900` / local `3d2bfbaf6078c8cc28f96b335f9957257dae51c7` / tree `f5a12f074b83ab53647bbbffca58ffadf7f92317`；独立 CI40484023548 首次19/19成功，实际checkout b43d0afc2159ea74a88f15594b7b99c7e3cc7268 同树，三平台各1160通过，12产物255文件完整互斥。PR29 remote `272d6276b9f7eeb6fd17e5813b29b9b7e08f795d` / local `88509ceef32bfc95588e8b824a26a7e282e489a2` / tree `a120b69f5be08ab34b5d7bab6914c44c85fc6256`；纯依赖base de88071a仅PR28+新PR14，feature仅7个MCP文件。独立 CI40484723094 首次19/19成功，实际checkout5e965d7928ffc2578a4415ddbe58ec0a82cb8ded（retarget前merge）同树，三平台各1275，12产物270文件完整互斥；retarget后56b443bd虽同树但不是实际checkout。上述均只验证各自功能树。
- 历史 f83/8b5 Windows XML RED 保留；本次通过不证明其根因修复，没有重跑或放宽预算。最近已核完整根GREEN仍按下方历史精确记录，不提升新候选状态。

## 09:55 JSON5 与空正文快照候选

- 最近完整 GREEN 为 `00b7f241b6e3ed3ae77b01a3e2695830f5c75432` / local `480e69bc5314ade204e5be6341e2d97798675211` / tree `8d500bb1b8f1d0f253f22cfe1a509529e6a2bf96`。CI `40480343196` 首次19/19成功，全部实际checkout同树；12产物363文件91/91/91/90完整互斥，三平台各1879通过，模型图/文档/API/冻结往返、数据库、production stdio和固定引擎通过。旧f83/8b5 Windows XML RED仍保留，不宣称根因已修。
- 本候选同PR25复用已锁定JSON5 2.2.3 MIT及现有同VM入口，不安装新库或修改loader/预算/权限。私有阶段启动快照只在非空raw/json正文需要解析时取得解析函数；64KiB有效Unicode输入、64层资源预检、10000节点、有限值/对象数组根/保留键/字节检查保持。词法预检识别单双引号、转义与注释，只计资源，语法由成熟解析器判断。
- none/缺失正文/精确空字符串按已核静态事实为空对象快照，空白或仅注释不是空正文。primitive/nonfinite/非法Unicode/GraphQL/file等仍拒绝；错误receipt仍到实际任务才抛，原阶段隔离、全部行先验、回滚/严格停止保持。原始JSON5正文和声明不改写；SDK编辑仅影响发送数据。既有json空body发送{}，none/raw发送空串，测试按既有发送语义验证，不因快照统一{}改变wire。
- Feature remote `b981f82a18b952f42cfe3ef93fa2f86efd09f2c4` / local `6c40db5eb4e5e6b9d8cb07871100a9b600593a2c` / tree `16ce938d41dd04979cc87676f65c7537f17d5df1`，base f896不变。独立 CI `40482464410` 首次19/19成功，实际checkout `a95a5eb9234434e985bd3236a42ef2de550351f2` 同树；12实际清单257文件65/64/64/64完整，三平台各1258通过。早期新夹具对json空wire、同步throws/空结果字段的假设错误保留并纠正，没有改生产去迎合它们。
- 根合并保留原assertion/pick共享私有工厂，仅向请求快照追加既有JSON5解析入口。四整文件36/36通过；主原生断言/提取完整SDK HTTP/stdio、CLI与往返链改用带注释/单引号/hex/尾逗号的初始正文，证明snapshot原文不变、提取为7而wire经SDK改为99。该主链与模型/文档MCP矩阵、原生任务出口三整文件26/26通过；全format/check/diff通过。
- 新组合仍须自己的CI；未更改发送canonicalization、原版运行/暂停审查状态、main/develop或部署状态。

## 09:15 历史复用模型定义图候选

- 前一文档组合 `f83ccd81711ee8f73856334606f1152bcb7d29ad` / tree `d3d401e8e5a558de23314d0ffba3e8cfd90d832c` 的 CI `40472886178` 首次为 **18 成功、1 失败**。Windows shard2 的既有 native-pick-xml-boundaries 输入/节点边界触发250ms预算（compatibility51ms + userScript199ms，CPU47ms+109ms，elapsed450ms，无网络/数据库），具体子边界和根因未确定；没有重跑、放宽预算或重启暂停审查。19实际checkout、12产物362文件91/91/90/90完整核对；Linux/macOS各1875通过，Windows1874通过/1失败。文档新流程三平台通过但不能抵消整体RED。最近完整GREEN仍为25315dac。
- 本候选修复非空 modelFolders 在两个原生出口被静默丢失，并支持有界静态复用模型图。dictionary与同ID components.schemas 必须一致；保留空目录、目录关系/排序/说明、模型定义、同模型局部及跨模型整根引用、API请求/响应关联，不展开复制图、不改字面example/default/enum等数据。使用现有模型验证、schema位置分类和导入器回读，不新增schema解释器或执行路径。
- 名称必须精确满足当前输出项目名称空间，并回读一致；项目/模型改名不再满足条件就明确拒绝，不猜删前缀。导入到任意目标名称不保证可再次原生导出；成功双代测试明确满足名称前提，重命名拒绝也验证。外部、跨模型子路径、动态锚点、未知组合、额外组件、存储不一致及未纳入依赖继续拒绝。输出ID重新映射，备份精确保留当前Workbench图与ID，不声称恢复已丢失的原版历史字段。
- 布尔模型及API引用false模型可保留；直接API布尔schema在normalize前拒绝，避免false被既有默认抹成{}，不猜测修复已归一化旧记录。没有运行schema/OOM或引擎专项。
- 同PR14 feature remote `0894a3439e8bd31c4c4af6d55d7ff431d442f91d` / local `cb870e80dc6f5be96a72ef64a9e7a6c949a07361` / tree `227e914e96ac1f1baedc10118250dca16f5a7f58`，pure base c348未变。独立 CI `40475742200` 首次19/19成功，全部实际checkout `419a761ccceb0bb134a4c8d365a0e4ed45798d40` 同树，三平台各1158，12产物255文件64/64/64/63完整核验。早期拒绝空目录丢失阶段56bd/CI40474957030通过；中间046b/CI40475555768取消，保留真实历史。
- 根组合保留原生任务出口并接入模型映射，四种官方SDK格式/transport矩阵使用同时包含API、文档、复用模型及冻结计划的项目。验证空目录、互引用/自引用、局部$defs、literal $ref不改、false模型、API与冻结步骤引用目标存在、文档状态引用、第二次原生导出、备份、真实HTTP及权限隔离；改项目名后出口原子拒绝。三个整文件11/11通过，原API/任务/Mock/认证及环境证据五整文件28/28通过，全format/check/diff通过。
- 本候选仍须自己的组合CI，独立绿灯不替代它；所有PR仍draft，无main/develop合并、部署或前端新增。旧Windows XML失败与原版/实验审查边界保持。

## 08:18 历史活动文档定义往返候选

- 最近完整 GREEN 为 `25315dacf17bcd793037a9bbf901c50ef7462870` / local `7992413978a1b1f97c1c2c598f533669031735dc` / tree `097982cf0f5b6e9798212f511158c8b81934e391`。CI `40468749549` 首次 19/19 成功，19 checkout 同树；12 实际产物完整覆盖 361 文件（91/90/90/90），三平台各 1873 通过。实际环境身份、保存失败/未知提交、MCP/CLI/恢复、数据库、production stdio 和固定引擎均通过；旧 8b5 XML RED 保留。
- 本候选让活动原生文档与可表达的普通文本 Workbench 文档进入 JSON/目录定义往返。title/content/folder/type/current status 和已验证 sort/version/status 保持；正文原样，不渲染、插值、执行或获取 URL/附件。当前 statusId 优先于历史 mark；输出 project/target/parent/mark 引用自洽。原生身份重映射，旧 document/apipostSource ID 精确保留仅由完整备份承担，不私造历史扩展或塞进正文。
- 未映射属性、自定义说明、未知来源字段、结构化富文本/附件、过长原生标题、deletedAt 和回收档案明确拒绝。正文中的链接只是原样文本，不承诺链接资源迁移。原版 GUI 往返未执行，既有独立专项边界不变。
- 同 PR14 feature remote `ab6f08352c489e6441de8567ab4b64889f73b903` / local `879dae255d1f739cb992421b75e2e1c48d303feb` / tree `23ba3b69e7f2a9911329eda9861b09d2f2dbb39b`。纯 base 快进为 `c34807260a0f3429cb4f3f7d56b8841da6bf59c7`，仅旧 pure base 加 PR21（其必要 PR20），无 PR14/root 自身祖先。独立 CI `40470326194` 首次 19/19 成功，全部实际 checkout `92bab4abd9415e61a78b36c5aeb391f7a8a1dc1b` 同树，三平台各 1154，12 工件完整覆盖254文件。
- 根合并只添加出口能力，保留原生任务导出、认证隔离、完整运行时、结果收据和74个MCP工具。把根专属旧“活动文档导出400”改成真实回读阳性，删除后apiResourceTrash仍400。三个整文件9/9通过：owner编辑/双代回读/备份重启，以及官方SDK HTTP/stdio×两格式MCP；documentIds准确、文字和目录保持、同名不同色状态链接正确、doc不能作为HTTP API执行、转换零网络、未授权项目不可读。
- 原API出口、条件Mock SDK/CLI、四格式认证/环境override、原生任务出口五整文件28/28通过；全量格式/语法检查通过。README现在按六模块和当前边界描述能力，旧逐项清单及旧交付候选标记为历史，不再把任务全拒绝/PG与MySQL仅只读/单固定PR当现状。
- 此新组合仍待自己的 CI，不用独立PR或上一个GREEN代替；未合 main/develop、未部署、未新增前端。

## 07:39 历史实际执行环境证据候选

- 最近完整 GREEN 为 `a8273f248277fd0dd110fdb29380c6edf6754763` / local `c3b901e6b463f75ae57f02274e26ce1c0ed1be7f` / tree `593f7d7ee9eb88689ac069b1341885cdeee43b5d`。CI `40466431993` 首次 19/19 成功，全部 checkout 同树；12 实际产物完整覆盖 360 文件（四分片各90），三平台各 1869 通过，跨格式 opt-out、MCP/CLI/恢复、数据库、production stdio 和固定引擎均通过。旧 8b5 XML RED 不改判。
- 本候选修复 owner/CLI 实际执行环境身份丢失：冻结计划默认 A、本次覆盖 B 时虽然真实请求使用 B，但历史只保存 snapshot 默认 A。现在复用 selectedEnvironment 解析一次真实 ID，供变量/作用域/Cookie/服务选择及 run.environmentId 共用；snapshot.environmentId 保留原计划默认，不改执行结果或既有 MCP 行为。相同变量值的两个环境也能明确辨认，缺失旧记录不猜测回填。
- 同 PR30 最终 remote `7c5afb162c6814964ea7cc7ce8047caddcadc603` / local `244cb64475c7957a8d13f827e69d15629c56cb35` / tree `78d0db16c3fc88c56a70e1809a7b3622ad4728d9`。独立 CI `40467260432` 首次 10/10 成功，全部 actual checkout `4b9cb56ac66b8cc4c89d274ab8f4fe68e452d665` 同树，三平台各 1056 通过。旧33cc阶段 CI40467039737 因后续测试提交取消，保留历史，不用于验收。
- 真实 owner/CLI 验证默认、当前环境及覆盖、200/500、返回/磁盘/备份/恢复重启。原先实际 header 已显示 B 而结果身份 undefined 的 RED 保留。generic 保存失败和 typed 未知提交均保留 actual environmentId，但 recordSaved:false、不伪造持久化、不自动网络重放。测试 CLI 子进程15s/输出上限/abort清理只约束测试，不改应用250ms/2s等预算。
- 根合并保留原 CLI database-stdin 授权与凭据清理逻辑，仅补实际环境选择/字段。完整原生断言/提取主链额外核默认 ID；四格式认证隔离流程新增 HTTP/stdio MCP 和 CLI 覆盖环境 B、冻结仍 A（原生导入计划保留自己的默认），并要求实际存在的 MCP/CLI 历史记录在备份恢复后仍记录 B。普通继承对照保持原默认。
- 四整文件 37/37 通过；强化历史记录非空断言后，认证SDK/CLI、CLI数据库授权、保存收据三个整文件 21/21 通过。旧/新记录、保存失败、不确定提交、恢复与项目隔离一起验证。本候选仍须自己的组合 CI，无合并 main/develop 或部署。

## 07:16 历史跨格式明确无认证候选

- 最近完整 GREEN 为 `4bef1ab170f81de0e623f3cebbd6366b08917a67` / local `ab8f04fa3257b832b310bd781c9337bec4bd6785` / tree `dd1d0ae9dd8f017cc0c42f641b00a297ba9aeec2`。CI `40464723874` 首次 19/19 成功，全部 checkout 已核；12 实际产物完整覆盖 359 文件（90/90/90/89），三平台各 1866 通过，原生 noauth、SDK URL 防丢失、数据库、production stdio、固定引擎均通过。它不包含以下 Postman/OpenAPI 增量。
- 同 PR8 后续修复两个明确来源 opt-out：Postman 使用既有 collection→folder→request 有效认证解析结果，仅 type=noauth 关闭目标继承；缺省/null 子可继承明确父 noauth，显式子认证优先。OpenAPI 仅选中的有效 security 空数组关闭继承，operation 自有声明优先于 root。缺省/null 本身、optional [{}]、非空方案不改为关闭，generic shared-auth 默认不变，不从 OpenAPI 生成凭据。
- 功能 remote `426d423fbbfaf09fbba541d3a3330a494efd8bc9` / local `c0e68e4617ea8c23a2c1ff317ee3fc2c877af4ba` / tree `61362903484a2f97f3077ac7619ec7d0101ed8e5`；CI `40465267461` 首次 10/10 成功，全部 actual checkout `0a4f9ca17246afa9a49ded90cd0af236634b2285` 同树，三平台各 1040 通过。独立整链12种源覆盖中保留修复前真实上游收到虚构 Bearer 的 RED，修复后相同输入返回无认证；没有真实账户。
- 根组合保持原生两格式 MCP 导入/导出闭环，并新增 Postman owner 导入→HTTP MCP 与 OpenAPI owner 导入→stdio MCP，随后均冻结、真实执行、CLI、live/目标认证变化、备份恢复和重启。MCP interchange 仍只接受其声明的原生格式，未为测试扩大工具格式。五整文件 36/36 通过，全量 format/check/diff 通过；本候选须自己的组合 CI。
- 这不是已保存旧请求的自动迁移：过去已丢失的来源意图不能靠猜测恢复，不批量改写用户现有继承选择。标准无效的 OpenAPI null 与其既有元数据回退差异也不宣称已解决。旧 Windows XML RED 和原版/实验专项未完成边界继续保留。

## 06:59 历史认证与 URL 模式往返修复候选

- 最近完整 GREEN 为 `ad5192b0081ab3549c2da3eec56138000dcc187d` / local `a04b8cd9acacfe66775f1a4f15c38ea0fcf7319d` / tree `f12d9d5e8b27f4b94f7f6532ae511ffc7f750d03`。CI `40462874730` 首次 19/19 成功，19 checkout 同树；12 实际产物完整覆盖 357 文件（90/89/89/89），三平台各 1860 通过。Cookie、完整 SDK/CLI/原生往返、数据库、production stdio 和 ac4822 重建均通过；旧 8b5 Windows XML RED 不改判。
- 本候选修复真实 noauth 语义丢失：原生明确 noauth/none 导入后原先会因默认 inheritAuth=true 取目标项目/目录的认证。PR8 只对 legacy 显式两种拼写置 false；modern 来源项目/目录/接口认证已解析后统一锁定不继承目标。全系统普通 none 默认及 legacy 完全缺省不改；来源显式认证仍保留，不恢复数据库凭据。
- PR8 保存为 remote `86fb79f1a0e4fe04d2377f3ce38a85e98519c36a` / local `5116ff9d298b9271f91f15e0fc17aaa908c7ca7b` / tree `70750a2ece38a2fbec9e535f1f93ee96bdc8e5f7`，仍 target PR22 的 feat/aws-query-presigning，不把导出器或 root 倒灌。独立最新 CI 待终态；功能本地六整文件 49/49 通过。
- PR14 同时修复 SDK URL 模式丢失：原生导出没有已验证模式字段时明确拒绝 scriptURLMode=sdk，包括无脚本接口及冻结步骤；不默默变成 legacy 或改写脚本。已有真实 SDK query 编辑照常发 proof=kept，完整备份恢复/重启后仍可执行。remote `54e6438769297c1345f2ef962cb4eb753082f7a6` / local `e8519f4b58c2e8c8313836d804c709fd44a3d672` / tree `b500b1f9c462612ba54e6d1a4794530095f9bf2e`，pure base 87ffd 未变，独立本地三整文件 22/22；此新头 CI `40463524805` 首次 19/19 成功，全部实际检出同 tree，12 份分片清单已核，不沿用 bbf1 的绿灯。
- 根新增 SDK HTTP/JSON 与 stdio/目录的实际 noauth 全链：导出→MCP 导入已有 global/folderAuth 的目标→冻结计划→MCP 和 CLI 真实执行→live/全局认证变化→恢复/重启。修复前两个有效夹具都从真实上游收到虚构 folder Basic Authorization；修复后两个上游响应均 auth:null。目录导入的原生冻结计划也实际执行，目标原有普通继承请求仍取得其本来 Bearer/Basic，源和其他项目不变。没有访问真实账户或发送真实秘密。
- 首次目录测试夹具遗漏 strict200，因此被既有导出保护拒绝；只修夹具，未放宽出口。有效 RED 反例与之后 PASS 分开保留。最终六整文件 32/32 通过，包含新两修复、MCP 四种格式/transport、原生任务导出及备份冻结链；全 format/check/diff 通过。
- 本候选尚须独立组合 CI；没有 main/develop 合并、部署、新增前端或重启被暂停审查。

## 06:42 历史 Cookie 提取候选

- 最近完整 GREEN 为 `0b0a9ddb801cbebeb2ad4c7a3d71ec50f04e66a1` / local `f93f91bafb80517683244e79810a469eafe057e6` / tree `27f51c880416e8b34b88150d39631e072022b755`。CI `40460959814` 首次 19/19 成功，全部 actual checkout/tree 已核；12 份实际产物覆盖 354 文件（89/89/88/88），三平台各 1849 通过，Mock/SDK/CLI/恢复、DB/production stdio/固定引擎均通过。旧 `8b5` 的 Windows XML 超时保留为 RED，不据本次通过证明原因已修复。
- PR14 Mock 出口 `bbf1feed` 的独立 CI `40460664108` 已首次 19/19 成功，三平台各 1134；全部 actual checkout `ee131ef80ae75e06774f8e2c09c426d7e21733d0` 同 feature tree `1b76ac81`，12 清单完整覆盖 247 文件。仍 draft，无合并或部署。
- 本候选同 PR25 添加 AFTER-only responseCookie pick，保留原始目标名，仅 expression trim。使用现有完整传输证据和普通唯一名称子集，不新建 Cookie parser；bootstrap 固定并验证原 map，后续允许原来有证据字段的当前安全字符串编辑，公开 map/方法替换不能换源。新增/删除/访问器/非字符串/歧义/过限等明确失败，所有行验证完才写入，原阶段回滚/strict-stop 及预算不变。
- 纯公共依赖 `deps/native-cookie-evidence` 的远端 `875943c81e777ec79cadbeeff77b9aabc2998186` 从 GitHub develop `88f70bb` 的精确 tree `107767d4` 恢复出发；旧本地 develop tree 不同，未沿用。两个生产模块逐字等于当前根已有实现，仅增加独立证据测试，公共分支本身不代表接入 transport。PR25 纯 base `f8965e98d46a12386d259a94bdd4caaf51191efe` 只包含 PR9/common/PR3/35/38，无 PR25/26 业务祖先。
- PR25 Cookie feature `87b2b4cdf6bef0d3b2c1b82944ee0e1f9d215472` / local `4241159bbbc019cf07a48ddddc48bd42e98acdab` / tree `c02188ba054922d64b221dd03c33cbc186223e5f`，独立 CI `40462248586` 首次 19/19 成功：全部实际 checkout `5831ec396f07197cec22967a4eb70dd45139f6b5` 同 feature tree，三平台各 1249 通过，256 文件每分片64完整覆盖。PR26 未为纯祖先调整而改动；根共用同一 Cookie evidence，assertion 入口保持原样，只向 pick 增加当前捕获 map 与证据参数。
- 根定向四整文件 30/30 通过：H1/H2 Set-Cookie、三作用域、当前编辑/缺失回滚/冻结恢复，及真实 MCP HTTP/stdio、CLI、两格式往返主链。主链首个 Cookie pick 之前已编辑原 map 并替换公开 map/setters，提取后下一请求回显 edited-token，而非伪造 map；目标前后空白保留、原始 Cookie 快照与提取结果区分。既有 62 个原生断言与任务16项上限不减少。
- 前置请求快照/metadata、Mock SDK/CLI 往返、原生任务导出四整文件 12/12 通过；全量 format/check/diff 通过。本候选须自己的完整 CI；不将十类来源均有有界实现等同于原版完整兼容或产品交付。原版 GUI、XML 独立审查及关闭的实验运行时仍未完成且未重启。

## 06:23 历史条件 Mock 往返候选

- 前一请求快照组合 `8b5bb079c3779333e115257da61b77db3027dcda` / tree `91dfa9163d5322d907c3ba1c8b6a9f5141084e30` 的首次 CI `40459167073` 为 **18 成功、1 失败**。唯一失败为 Windows 既有 XML 输入/节点边界测试触发 250ms 活动预算（compatibility 160ms + userScript 91ms）；不认定为环境偶发，也不重跑或放宽预算。19 个 checkout 和 12 份实际产物已核，352 文件四等分无漏重；Linux/macOS 各 1844 通过，Windows 1843 通过、1 失败。新增请求提取、MCP/CLI/导出完整链均三平台通过，但不抵消组合 RED。
- 请求快照 PR25 最终 `5011486601df6c910cf7b81421da4c50bb81a586` / tree `79200c4123d36cd027abb9bbc4fa74d6ffdea8c3` 独立 CI `40459090937` 首次 10/10 成功，三平台各 1197；全部实际 merge `18d3c8c124a754fe9864df72b643468f2f07f916` 同树。前阶段取消的部分结果保留，不当作最终验收。
- 本候选继续同 PR14 的导入导出闭环。修复已复现的 `settings.mockEnabled=false` 被忽略问题：原生格式无已验证的项目级映射时明确拒绝，项目备份保留关闭状态；不把项目关闭偷偷转换为逐接口禁用。单接口 nativeMock.enabled 则支持无损反向映射。
- 条件 Mock 导出现在支持既有有界条件/顺序/启用值、query/header/body 路径、固定 200 与独立 sourceStatus、响应头/延迟、普通 JSON 正文或 object/array schema。内联期望不覆盖文档 examples/responses；目录使用最终项目/API 标识生成独立 mock 配置，回读深比较确认可逆。未知档案/全局依赖、模型引用、普通 mockRules 混用、scalar/raw-XML 等继续明确拒绝。转换不运行脚本或生成 Mock 数据。
- PR14 feature `bbf1feed4dff3688e17b6658dd5996b671db6467` / local `c90a7f7b3d1545120498c8c51fcd1e883cb4dcd1` / tree `1b76ac8171253fbb3a47c75e877ed3868fb7f82f`，目标纯依赖 `deps/native-mock-export-base` (`87ffd88da8e44e96ac50802623b1a79d43fc6d49`)。该 base 仅合 PR7/11/3/35/38，不含 PR14/26 或 root；功能差异只有 10 个导出文件。独立 CI `40460664108` 待终态。
- 根组合保留原生任务导出、运行时全部校验及结果收据，只合入 Mock 导出增量。首批四个整文件 23/23 通过；合入 Header+body bracket 条件及禁用状态测试后，Mock 导出/SDK 入口、既有路由/媒体及原生任务导出五整文件 14/14 通过。SDK HTTP+JSON、stdio+目录均验证只读不能导入/越项目不能导出、源无修改、两种路由与新ID选择一致、真实 CLI 消费 Mock 并保存结果、恢复与重启。
- 本候选仍需自己的完整 CI；最近完整 GREEN 仍为下节 `26c51181`，不以本地通过替代组合验收。原版 GUI、独立 XML 审查及关闭的 PR37 实验边界均未改变。

## 06:05 历史请求快照候选与验证

- 最近完整通过的组合为 `26c51181e1f7eced67ab6c56bb5f1208f6830a59`，本地 `f2db1eacd46a792da229a8da705ad708ac107144`，同树 `336463a77d17c11ec113970265c2718a7349287e`。CI `40455614645` 首轮 19/19 成功，全部实际 checkout 同提交/树；12 份实际清单完整互斥覆盖 350 文件（88/88/87/87），三平台各 1836 通过。元数据提取的 H1/H2、全部作用域、后续真实请求、冻结计划、备份重启和严格失败回滚，以及既有数据库、production-only stdio、固定 ac4822 引擎复现均通过。
- 本候选在同 PR25 的已保存元数据阶段之上继续接入前置 requestHeader/requestBody：私有阶段启动配置快照，Header 为唯一普通字段名，Body 为有界严格 JSON 对象/数组或唯一纯文本表单。SDK 在同阶段改动不改变初始快照，实际发送请求仍遵从 SDK 编辑；后置请求提取暂拒绝，不声称最终 wire/auth/system header 投影、JSON5、文件或原版所有 legacy 修改语义兼容。
- 根组合保留断言/等待及终态预算入口，仅向 pick 增加私有请求读取器。新增现有 MCP HTTP/stdio、CLI 和原生往返整链中的“前置提取→SDK修改→快照再次提取→私有变量断言/预期展开→实际 wire 99 而提取值仍为 7→下一请求使用提取结果”。主链和新请求提取三个整文件 27/27 通过；随后合入前置成功后后置失败及 disabled 策略测试，重新跑请求两个整文件与原生导出两个整文件 17/17 通过。全量格式/check/diff 通过。候选尚待自己的组合 CI，不能复用上一个绿色提交作为本候选通过依据。
- 功能复核发现 host 数组形状校验可能让稀疏索引和额外属性抵消，导致 JSON 序列化静默丢失；修复与稀疏+额外键、数组原型冒充负例已在同 PR25 保存并合入本候选。成功前置提交后发生后续错误时，提示必须明确只回滚后置变更，不能误称已提交的前置值被撤销。
- 首次本地组合批次 20/26：根测试新增 pre-pick 污染旧 disabled/soft 夹具，以及新正文缺少原生导出要求的明确 Content-Type、任意正文直接回显到 HTTP header。仅修测试：只主成功链启用新请求提取，保留旧 disabled/soft 行为和错误文案期待，明确 Content-Type，并用 base64 回显正文；随后三个整文件 27/27。没有为这些夹具失败放宽生产策略。
- 05:59 重读 PR1/PR2：各自仍为 `88f70bb515c48b93536b28b7fe3ec780f2e150f3` / `a3ffbcd00134d5846b2a8550a5d096cec9139b7f`，draft/open/unmerged。未合 develop/main、未部署。
- 原版 GUI 往返、XML 独立专项审查和 PR37 最终实验审查仍未完成；PR37 默认关闭，不进入本组合。没有继续已暂停的 Schema OOM 调查，没有提高任何运行时预算。

以下为历史阶段记录，其“当前/候选/仍待验证”措辞仅属于各标题时点，不替代上述最新状态。

## 05:23 当前功能增量

- 组合9139e65131cde8556c3803cc034d0ad3b5a6cf1f/treea77fd1331a27df36f81c67eff98e7233c9755a85=local1880048522f15e6a726d165df2c1d7c795682996的CI40452482154首轮19/19成功；全部actualcheckout及12份清单348文件87/87/87/87已核。三OS1830，历史模板Source零执行与CLI/恢复、19轮私有预期展开、15比较/11来源与DB/生产stdio/固定引擎重建均通过；edad失败记录不改判。
- 同PR25新增Code/Time/Size提取，headbeefafdbaa702fe4b7023713758e2de4d5e02232/tree81f3c60aea4f6cf5ec1430363ef306457ab75c76=local1e0d257a443a1715d63978cd663f04c7a1b41ec4，仍PR9 base，无PR26依赖。独立CI40452601457首轮10/10，三OS1189；全部实际checkout0240570483af6ed44008cd4eb56d28d85e659594同树。
- 元数据每task只从启动时捕获facade当前自有数据字段读取一次，有限JSON scalar保持原类型；缺失/undefined/getter/非有限数/对象明确失败，String不隐式转换。目标name按原Text共同分支trim；expression可缺省，存在时有界原样保存但不解释。原子行验证、阶段失败不提交及严格计划停止保持。
- 新组合已保留assertions私有工厂并只向pick installer追加捕获facade参数。元数据与原预期展开15项、完整MCP/CLI/nativeexport等28项定向通过；主链将当前view改为201/12.5/2048，三来源×三scope提取，公开setter替换不能劫持写入，后续真实请求header回显这些数值，原始wire状态/耗时/大小保持初始快照。数值保持number，原生定义/冻结/恢复原样。
- 本候选尚需自己的组合CI。requestHeader/requestBody/Cookie提取仍未接入：原版request来源属于legacy阶段投影，WB当前live facade/配置行与认证或系统头不全等，不能直接套用。未运行原版或重启XML专项审查。

## 04:54 先前组合取证与夹具纠正

组合edad4c549b0700938b1db512eac05b73ae30aa9f/tree076ece168af6aba4b5166c7bb30e1f72601f95bf的首轮CI40450856271为16成功/3失败：三个OS均在旧native-text-entrypoints:1047把已支持的普通expected marker当作导入错误，期望400、实际200，各OS1829通过/1失败；不是超时。全部actualcheckout与12份清单348文件87/87/87/87已核，DB/生产stdio/固定ac引擎通过，不抵消RED。

本次只调整该旧fixture：用真正非法的对象expected保留400、错误类别、磁盘/内存原子性与零网络验证；另将有效历史原生source改成普通expected marker，并明确断言CLI/备份重启仍保留原文、零断言执行和不修改token。没有弱化生产校验或删除失败检查。三个原有Text/Header/XML入口整文件30项重新通过；这是普通功能回归，不是重启未完成的XML独立审查。修复提交仍须自己的CI，旧RED保留。

## 04:36 先前更新

- 最新完整绿色组合9b3ca434b63c30c22291a329e6304dc6d10e38ec/tree95e1efb7f68a53b23452bc2df3815ccce78bcd0a=local6c05a6952d5049608f900cda079710f03685b035，CI40445982435首轮19/19，全部实际checkout/tree已核。三OS1819，12清单347文件87/87/87/86互斥完整，hash79f8066978f836f3f6f245a5fdea987c05f2c0f7e8f72cb86e57624c6dc7ae9f。15比较/11来源MCP HTTP/stdio、CLI、原生往返/恢复与Unicode OOM清理、DB/生产stdio/固定ac4822引擎重建均通过。
- 当前同PR26新增有界compareValue展开：feature9f268e51ad3154eea225050475bd45b7c5b5babe/treee516b356422a225a3c5896aea44d53151392ff4d=local688d14de7bf3b079c80ae329b9d758fefd6ae03e。独立CI40449589366首轮19/19，actual mergedbfb99312ec150f97f6a040a16623f9655e85263同树、三OS1369；12清单263文件66/66/66/65完整。仍target纯依赖base4a79927b，差异仅断言相关24文件。
- 预期值在安全actual读取后、比较或RegExp构造前按当前own scalar映射展开；精确键不trim、不解释路径。最多19轮、无变化固定点可提前停，阶段共享1000次匹配尝试。缺失保留marker、own undefined遮蔽下层并为空串，null/false/0正确转换，替换值$&保持字面；每片追加前计算Unicode/64KiB UTF8上限，regex展开后再限1024 UTF16码元/4096字节。不调用公开replaceIn/has/get、getter或对象转换，不额外扫描第20轮新marker；遇到$builtin、原型保留名或非标量明确失败。支持普通变量预期，不声称动态函数/原版完整scope层等价。
- 本次组合37项定向通过：原生两格式往返、HTTP1/2+官方MCP+CLI+重启，新增前置当前变量、嵌套Text预期、集合/数值/正则展开，以及实际替换公开helper后仍读取私有当前map。MCP另验证一元provided expected也拒绝builtin、展开后非法regex到实际任务才失败。原配置始终保留marker，不把展开结果写回定义。新组合仍需自己的CI。
- 首WIP410020e/CI40448948787实际mergef91aee05af927c59d5d4a558f8539414003635e5同tree5c09cdc8，7成功/12core失败，各OS1362/1367；五处旧“模板导入拒绝”fixture不再符合新增支持，改成真实结构错误，另补执行期builtin/各来源错误路径，并非放宽检查。该RED保留。
- PR37最新实验a423f480b1c52f40c7e7669a2b0ada6a77ac0eee/tree4d459c5572bd2b49a4bcd2515dab9bc844f52a99，CI40448807120独立10/10成功（三OS1039+36、Linux来源9）；真实in-VM lazy getter路径已有测试。但source-mode13MiB下parser/disposal assertion仍保留，最终独立ownership/reentry/budget复核未完成，相关进一步复核暂停，默认关闭且不并入本次组合。实验GREEN不是生产启用许可，也不证明外层生产worker错误恢复已经覆盖。

以下保留先前阶段的精确记录，以本节最新状态为准。

## 先前已核实与候选

- 最新完整绿色组合6e138867a9a44f2cf50a06aab29f24023213d911/tree81ad150cd6af0c0ec4e1653289ed294a485c77b3=local7f3c392822633450d5635db2c8afa60dad3f7bc8，CI40441667524首轮19/19；全部实际checkout/head/tree核实。三OS1807，12清单345文件87/86/86/86完整无重漏，hash2ae68cf19473b1a2f31e57708748f6ab26ed213e5d396dd3352a5d9be49da922。新OAuth1完整SDK/CLI/冻结认证/重启链、11来源14比较器及真实DB/stdio/固定c09引擎重建全部通过；不因此改判历史Mac RED或宣称唯一根因已修复。
- 本次新候选在同PR26接入第15种regularmatch：原始/trim后模式≤1024 UTF-16码元及4096 UTF-8字节、有效Unicode；实际有限原始值String后≤64KiB UTF-8。仅去除边缘斜杠、无flags，不将/abc/i误作忽略大小写；///为空模式仍执行。活跃原始空串明确拒绝（原版跳过），该历史阶段动态expected尚不支持；本次已按上文支持纯标量变量。到任务实际执行才构造，语法错误在pm.test之外成为阶段错误；captured构造器/direct exec、私有完成性及全部共享预算保留。
- 正则编译与部分C内循环不是250ms硬抢占；编译/匹配/结果处理全部进入既有charged-wall与最终超额拒绝，仍有2s worker终止。没有新增host async权限或重置每条断言预算，也不以尺寸cap冒充毫秒保证。
- 新候选使用PR38最新官方Unicode OOM一行修复817509a87c3c0af362df576574784bae0dae8129，新WASM ac4822f75275ccf8cb936649383dc947843511784379518948cf61087a418c9e；六源hash、双干净构建和CI已核。没有引入大型自制compiler取消补丁。
- 新组合15比较器/11来源入口、运行期坏pattern经MCP失败、两原生格式往返与备份重启26项通过；新operator正式8项与原等待/终态预算在前一组合批次也通过。那次批次35/36，唯一失败是root旧fixture仍把合法regularmatch当unsupported；保留未知operator/别名拒绝，改为实际空模式和超模式限额拒绝，补运行期语法错误后重新通过。没有改生产来迎合旧fixture。新组合仍等自己的CI。

## 历史组合与保留的失败

- 最近完整绿色组合：4ab68b2ffa5fd8ee1429c6a3da2e56b8e699d8dc，tree7cd48cd61a8c716b1e0d992dac69ccf500ed225e，对应本地ff358ac70d0a1408051526bfdd6081a1b0c65336。CI40434862187首轮13/13成功，全部actual checkout同head，三OS各1766；六份实际清单339文件170/169，无遗漏重复。
- 变量组合5962cca4b81a3dc9eb87603fdb3b82923f0f6457/treee694470d05b1dfdb0057aa94f8c803359abaa56d，CI40436500912为12成功/1Mac shard失败；旧script-url-state:104直接QuickJS URLSDK求值被250ms中断。Ubuntu/Windows1774，Mac1773，全部checkout和340文件清单已核。测试/URLSDK/engine相对前绿树未变，不等于证明调度根因。
- Cookie组合7d97baf7311a7f35c8f05e52f1a9e34df0fe8386/treeccdde69f154c894b82f5b817ab9a88ebdbe8560c，CI40438420588为12成功/1Mac shard失败。旧script-sequence:7 folder阶段remaining204ms，兼容层墙钟264ms/CPU9.525ms，user0；Ubuntu/Windows1782，Mac1781。11来源/14比较器HTTP1.1/HTTP2、官方HTTP/stdio SDK、CLI、导出/回读/重启整链三OS均通过，但整体仍RED。六份清单341文件171/170已核。
- 这些组合的真实DB、三平台production-only stdio、固定引擎重建均通过，不抵消核心失败；没有盲重跑或放宽运行预算。

## 本轮保存与精确独立 CI

所有PR仍draft，未合入develop/main、未部署。PR检出test merge，以下均核对实际checkout与Git tree，不只看关联head。

| PR                   | 当前head                                 | 精确独立CI与内容                                                                                                                                            |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1                   | 88f70bb515c48b93536b28b7fe3ec780f2e150f3 | 40136832590，首轮成功；02:41重读仍open/draft/unmerged                                                                                                       |
| #2                   | a3ffbcd00134d5846b2a8550a5d096cec9139b7f | 40275759477，首轮成功；02:41重读未变化                                                                                                                      |
| #3 终态预算          | b7fc0df3ca74abf56a583d122af57b214f2951e5 | 40434429389，10/10；mergea438ffd8f188f646a54cb5ffc22d4152e1a54513/tree6c4d77a008c8feeb310d39acd525d3850969ceaf=head；三OS1038                               |
| #26 原生断言         | 73feb85b2b9c4d1d9302871df70b8f93c6efb262 | 40444849052，19/19；mergec92d78fde00436f9feb1b1d5c18333fbdca7451b/tree8191bc287c0fc049a95e2dbb93bae04fc230b0a4=head；三OS1360；262文件66/66/65/65完整无重漏 |
| #35 CI文件隔离       | e13d60afa9e6f7dad3bebd3de6cc033e640f5bbd | 40439898640，19/19；mergeb8c7e4b57a3e24e3581c5231786c69bb62794d07/tree3f36b15ba5cef3266863e49b580e5b617822f968=head；三OS1033                               |
| #36 实际堆计费       | 355bf9a2c68766a56769ba5359922dbff9432f5b | 40434252890，10/10；mergee10d71ced849a111ecd8b3d80ff18bb8c13a2ce9/tree46f52d3d0c13791d89a42488748c9a95bbe9beb3=head；三OS1028                               |
| #38 正则中断/OOM修复 | 05c8f5834285b0dce866f4b8703fc4d7ba63c94e | 40443229089，10/10；merge8aaaafff50bfc779ea7b6c07b9b919215fad6b97/tree88195a31c9e7f02c89ef6772baef4dbf7e99ad88=head；三OS1039                               |
| #39 OAuth1回调       | 5aa96e820186e30bde00f1aeecda4f580da5561a | 40440442949，10/10；merge4ed5e5a199bbadef6e9712dcc68431e58f235920/tree6e2ddea51467ab6d73f8c91a10060693346ba160=head；三OS1038                               |

PR26现依赖deps/native-assertions-runtime-base：4a79927b16f7691bb85f5dbf124b1e6a8af4f4f1/tree2fbe5546e22ebc089024d5810f1430f937f2b909，仅合PR25/3/35/38，不含PR26；feature diff仅23个断言相关文件，无runtime/vendor/CI。PR38依赖PR36；其他本轮功能优先develop为base。PR37固定库bytecode仍为独立实验，依赖PR36，未进入默认运行时；实验自身检查不能算生产优化已交付。

## 先前6e138绿色组合的本地构建证据

本地阶段2db224fcbfb0e563b3cc055fa3c4871a30d1bcf5已整合上述最新PR35/38/39，保留PR31 OAuth2与新增OAuth1的caller取消及shutdown开始时中止两个manager，随后仍执行既有协议/数据库/导入服务清理。未把其中任何独立绿灯移作组合通过。

- 初始OAuth1/正则/CI合同36项通过；最初命令误写不存在的oauth2-lifecycle.test.mjs，Node未执行该文件，不能计作OAuth2验证。随后使用正确oauth-lifecycle.test.mjs和oauth2-workbench-entrypoints.test.mjs独立17项通过；新增临时执行前文件存在检查，避免遗漏模式再次被误计。
- OAuth1取消竞争修复合入后，真实OAuth1 callback/完整MCP+CLI+备份重启链与既有OAuth2 lifecycle/入口33项重新通过；同新引擎下11来源完整入口16项通过。全量format/check和diff检查通过。
- 新OAuth1完整链由独立crypto RFC5849 oracle验证请求令牌、换取令牌与资源HMAC，包含重复query/Unicode与每次新nonce。交换本身不写项目；明确owner保存后consumer/access secrets会持久化，冻结计划不随live auth修改而漂移。只用虚构loopback服务，不访问真实账户或扩展第三方授权。
- 正则只回移官方MIT commit25aaa7737020d7ca98926abc532acc6c5755d562匹配期轮询，deadline/heap/stack与公开QTS签名不变；双干净源码和CI复现WASM c09ec397ce8419fc385b46044659da9a4a9ac35d6dec8ccb1cedb3821d56fd3c。原引擎正常回溯例只能被2s wall guard终止，候选在既有活动期限内不可catch地中断。编译与单个backreference内扫描边界仍开放，该历史阶段尚未启用native regularmatch；本次候选按上文的有限契约接入。

## CI隔离变更，不是预算放宽或根因证明

每OS四个互斥文件分片、每job文件并行1；npm test默认文件并行2不变。所有文件内Promise.all项目并发、60worker生命周期及跨进程锁竞争保持；应用250ms/2s/16MiB和10分钟job上限不变。12core/19总job使用标准runner，代价是更多VM/setup/排队。

独立PR35下载12份manifest/TAP，225文件57/56/56/56无漏项重复。新增白名单诊断实际记录Node/arch/availableParallelism/CPU数量/内存/image；同macos-latest实测曾出现3核7GiB和5核14GiB以及不同Node/image patch，不能用官方规格替代实测或凭一轮绿灯宣称根因修复。

## 已保留的功能范围与关键限制

- 项目存储/导入导出：真实事务日志、恢复/隔离、原生混排任务定义往返与MCP/CLI执行已验证；有历史MCP来源、冻结DB等无法完整原生表达时继续fail-closed，Workbench备份不是原版无损迁移。
- 请求/认证：已有多协议与OAuth2 lifecycle、Digest/AWS等；OAuth1新增owned loopback，OOB/PIN默认不变，随机路径/token/verifier绑定、单次领取、取消/过期/断连/关机均有真实HTTP验证。高级协议/部署及真实第三方账户不在虚构fixture验收内。
- 前后置：11来源、14非regex比较器及本次regularmatch仅有限primitive/absence域。变量路径只剥边缘花括号，不解析模板；WB有效scope层与原版iteration/collection层并不全等。Cookie只支持完整普通唯一名/非空无外围空白，私有transport证据与Header分离；不支持任意lodash路径/重复覆盖语义。普通gzip解压后字节有原版静态依据；Time原版ceil与WB小数duration差异保留。
- Mock/数据库：真实PostgreSQL/MySQL写入、取消、timeout、锁/清理，以及Redis/MongoDB/TLS/ClickHouse与SQLite链有证据；SQLServer许可未接受，更多变体未完整交付。
- 计划/结果/MCP：冻结状态、只读/写入/执行授权隔离、SDK HTTP/stdio、CLI、取消及journal未知保存收据已验证；保存失败不伪造网络失败，不自动重放。真实外部宿主客户端并未全部接入验收。
- 独立XML专项审查未完成；原版GUI未运行验证。保留之前XML/JSON/Text/Header/源码模板的明确兼容边界，不因CI绿扩大声明。

旧PR26/组合Mac时限RED、PR36最初Mac309ms、PR38初始错误测试文案RED、PR3最初格式误报及所有取消均保留在各PR/ADR和Git历史，不改判为成功。完整项目尚未交付。

PR26首轮regularmatch CI40444392209为13成功/6失败，各OS1358/1360，新8项全过；本次曾改坏Header/XML错误消息中的“字面”，已恢复原词而非放宽测试，后续73feb精确CI才成功。PR37实验head468691dc/CI40441988958独立10/10通过（三OS1028+18、Linux来源5项），仍只证明host直接加载路径；生产lazy getter→host callback→同VM重入尚未验收，默认未启用。
