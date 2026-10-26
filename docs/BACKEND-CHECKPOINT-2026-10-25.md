# 后端检查点 · 2026-10-26 20:32 UTC

这是精确提交及已验证范围的检查点，不是完整产品交付声明。更早阶段的实现、RED 和修复证据保留在 Git 历史、各 ADR 与 PR 正文，不以旧绿灯替代新组合。

## 最新完整验证基线

- 组合：ebc26e1ebaf9dfe90fe15d017e6d7054e139fef1。
- Tree：f6d1ef6b3193b3a0a1c850fe68653912ad3fd4f8，与本地fff3637b3b552cfc84fcc066c00fd5f118aa1a20一致。
- Push CI：[40393711265](https://github.com/Hubujiu/local-api-workbench/actions/runs/40393711265)，首轮全部10个job成功；全部实际checkout为该SHA。
- 覆盖原生混排任务定义导出/回读、真实HTTP/MCP/CLI执行、隔离/冻结/备份恢复；MCP两种原生格式导入导出、权限边界、真实journal未知提交恢复及stdio完整转义帧限制。
- 既有真实数据库/TLS、三平台production-only stdio、脚本累计预算仍通过。测试结果不是交付百分比。
- **该基线包含MySQL显式写生命周期，不包含下述PostgreSQL ACK后清理修复。**

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

PR31 OAuth2生命周期当前head b8212924c139497196ebb28faa1742a75382c23d/tree640595564efa1f3aa82404b69e0db67b9c82233d，CI40388177786全部10个job成功（actual merge42d08a8dc50e90ace367b7164d9d1e161408f0de，tree=head）。PR32 Base64早拒head2d5f390270e52037bc48f437eb45c52aeca54106/treec27663db3e9cc2689ef7bc673806230157527148，CI40387995935全部10个job成功（actual merge5f691087ac8734879f0cb7031ed4719464786886，tree=head）。二者都直接基于develop88f70bb，独立功能diff，未把认证或模板生产修复塞进PR7。

PR1/2最后重新读取于19:45 UTC，head/test merge未变化，未重复跑旧CI。PR28临时基线仅连接PR14与PR27依赖，PR29基于PR28，PR30基于PR17；功能差异隔离，没有把新功能累积到PR1。依赖可用后才适合改以develop为目标，不自行合并。

## PR30已验证：真实执行完成与保存结果分开

真实回环POST已收到201或200，但历史保存可在journal发布前或发布后失败。旧manual HTTP会只返回错误并丢掉实际响应；部分已有计划/协议路径把typed保存状态压成可能含路径的字符串。本片复用原执行器和Store，只改证据保存与结果投影：

- 保留实际响应、断言、脚本诊断及执行passed/failed/cancelled，不因保存错误伪造网络失败。
- attemptedRecordId标识拟写记录；recordId只在保存确认后给出。recordSaved:false不证明回滚，未知提交恢复后可能已有相同记录。
- generic与真实typed unknown/recovery分开；固定脱敏文字，不回传磁盘路径、cause、凭据。外项目typed状态不误归当前记录。
- Socket.IO缓存同一finalSnapshot/finalRecord；恢复后只有整条canonical evidence一致才确认已保存，同ID不同内容拒绝且不覆盖。重复stop只重试保存/核对，不重放网络。
- 不扩展没有持久化历史的load/direct DB read，不改变协议网络、权限或预算。

功能final已在其独立分支保存；真实prejournal/postjournal、API/MCP/plan/TCP/SIO、冲突/隔离和scope提交定向验证通过。当前本地新组合保留原取消/数据库授权/原生MCP与环境状态；原生别名补充snake_case保存收据，manual HTTP单独保留scopeCommit，避免把变量提交未知与历史保存状态混同。

本地最终29项定向组合通过，包含实际SDK native API/flow、scope未知+历史确认/未知、stdio取消时抑制响应但journal可核对同ID，以及SIO恢复/并发/冲突。这些receipt组合检查已由d0aa自己的完整CI核实；后续PR7组合不能借用其绿灯。

## PR7继续原功能：原生MCP保存flow迁移

合法静态分析确认原版MCP可保存source:mcp及流程/步骤mcp\_\*比较基线；原执行只读取当前input、显式environment_id、步骤脚本及冻结快照。旧导入器拒绝这些元数据，新片继续同PR7，不另建重复导入PR。

新增闭合有界importedNativeFlowSource仅保留历史来源/导入时ID与基线，非当前steps补丁；source:mcp映射canonical ai但不授MCP权限，新运行source由实际入口记录。当前input/environment唯一权威，不从历史基线补缺省或重新合并删除键。克隆/重排/删除/编辑保留历史，source-only变化纳入版本/hash；Store/snapshot/restore克隆前验证，来源合计仍4MiB。

历史auth仅明确none/noauth；带凭证/连接/文件等不支持字段拒绝，不静默删除或恢复权限。body/header/cookie仍可能含用户输入敏感数据，不承诺自动去秘。旧manual/ai且无mcp元数据保持旧shape；组合原生目录导出对新历史来源明确拒绝并提示项目备份，不能静默丢失，旧无元数据目录往返继续支持。

功能final已保存，定向真实CLI/HTTP 503继续、输入/环境优先、取消、编辑/克隆/restore与独立getter回归通过。组合保留原active nativeMCP预算及手工编辑剥离语义，补原生SDK读写/执行授权隔离及导出guard。该导入组合已由a1a892自己的完整CI验证；静态来源+synthetic Workbench fixture不是原版GUI运行证明。独立PR7旧模板测试RED单独保留。

## OAuth2与Base64：组合已验证

OAuth2严格按RFC6749逐项form编码client ID/secret再Basic，不改变普通HTTP Basic；显式basic/body/none放置，错误类型模式、坏Unicode授权码/刷新值在网络前拒绝。使用owned取消控制器停止真实token请求，已关闭/已消费/失效flow不接纳迟到结果，隔离并发flow，不自动重试或保存。返回显式非Bearer类型时明确拒绝，防止现有客户端误改成Bearer；缺省及Bearer大小写保持已有兼容，不新增MAC/DPoP或真实账户权限。原15秒网络截止和容量约束不放宽。

新完整组合用真实token/resource服务验证owner交换→显式项目保存→SDK API/冻结flow→CLI→备份恢复/重启，活动请求编辑不影响冻结token；MCP权限不因此扩张，错误token类型不覆盖已有合法配置。Bearer已发后真实journal故障仍保留实际响应与unknown receipt，恢复核对同ID，不重放。关闭本地请求不保证服务端未签发或已撤销token。

Base64在CryptoJS编码前计算有效Unicode的UTF8长度与4\*ceil(bytes/3)+2 JSON字节；确定超出既有64KiB中间上限则早拒。保留原编码/解码、后置与最终field cap和250ms/2s执行预算。实际生成代码测试核对超限不调用编码器、合法仍调用；删除预检调用的mutant仍会调用编码器，原后置cap仍拒绝。不是把timeout当quota通过，也不声明原macOS具体超时成因已确定。

本地39项相关组合及一条完整SDK/CLI/receipt链通过，独立审查也通过；这些OAuth2/Base64组合范围已由a1b99自己的完整CI验证，不等于原PR7 macOS超时根因已确定。

## MySQL显式写生命周期：组合已验证

独立draft PR33基于PR24最终只读传输修复，head567bc1ea1f037558367f1fcb8b3daebb8c9aaf18/tree91630d98e0c6a08cc1d637a6a9e3f9724adbeef4；CI40392670629全部10个job成功，actual merge6d234217ae54d1dc8fcbe10fa3042f5b2045bbdd/tree=head。没有把新write行为混入PR24，也不扩MCP/CLI写入授权。

原真实owner HTTP回环红例证明：metadata COM_STMT_PREPARE可以绕过driver execute的2秒timeout；另SET超时虽然返回错误并释放write lease，mysql2.destroy仅end导致两个本地socket仍半开。本片拥有data/control公开stream，连接3秒、各事务阶段2秒，新增更严格8秒总工作期限，覆盖PREPARE+EXECUTE。最终清理强关owned transport并等actual close才放write/SSH lease，未用Promise.race冒充终止。

保留allowWrite、单语句/绑定参数、InnoDB/元数据锁、1000行/warning/精度、TLS证书/SSH指纹检查。只有DML中允许有限自身thread KILL；COMMIT发出未ACK不再ROLLBACK/KILL或自动重试，明确结果未知；已观察COMMIT/ROLLBACK最终ACK不因后续时钟或清理改成未知。关闭本地连接仍不能证明远端回滚或触发器等副作用消失。owner断开不会新增取消已明确授权写入的行为。

首阶段held TLS ClientHello关闭时暴露late error，最终通过public core connection先装error监听再await promise.connect修复，未读driver私有字段/升级依赖。真实wire、TLS、双SSH owner、ACK跨截止、容量/隔离/迟到回调与原两红例已本地通过。组合29项相关检查通过；独立与ebc26组合的mysql:8.4真实服务均已验证HTTP opt-in写入/读回、回滚/行数/warnings/timeout、只读授权隔离及pinned SSH写入。协议peer与真实引擎证据分开，不声称任意远端副作用可回滚。

## PostgreSQL显式写清理：新组合待CI

独立draft PR34同样以PR24为依赖，但与MySQL PR33分开：当前head6238c56456dd3509c55487ed856ff8ff521015fb/tree40c3c6d412b166059ae09af368718defb54ae97d，新增真实服务测试后的CI待核实。此前b4659495/tree67d03eb的CI40395088229已10个job成功（actual mergedb5998a7f9ce4599cd5a4fa71d223dc6a994af9c，tree与该旧head一致），但不包含新持锁超时检查。生产改动仅拥有公开Socket/SSH stream传入显式PG client，并在finally强关、等待实际关闭，不再无限await idle client.end。

真实协议peer确认COMMIT/ROLLBACK已ACK后，旧实现发Terminate/FIN仍会等待half-open peer，owner HTTP不返回；直连无兜底，SSH已有8秒总timer但占用lease。PG原query_timeout已覆盖extended PREPARE，不是MySQL的计时空洞。原3秒connect/query、2秒server statement timeout、身份/空密码provider/无PG环境回退、SQL与TLS/SSH约束全部不变；不新增PG五write lease、owner断开取消或MCP/CLI写权限。

已收到ACK保留committed/confirmed rollback；COMMIT未ACK仍unknown、不重放。独立44项相关检查与review18项通过，组合25项PG身份/写入/真实wire/TLS/SSH检查通过。旧b465实际postgres:17-alpine写/readback/row overflow和duplicate-key rollback/SSH已通过；不能借MySQL timeout marker充当PG超时。新6238仅追加真实PG额外连接先确认持有行锁，再调用owner HTTP写入，必须返回确认回滚+statement timeout，finally放锁后正常只读读回原值；独立marker为REAL_POSTGRES_LOCK_TIMEOUT_ROLLBACK_READBACK_PASS。无sleep/缩短生产预算。此新增真实服务case未在本地执行，**最新head及新组合完整CI仍待核验**；本地连接关闭不证明远端回滚。

## 历史失败与仍需调查的风险

- PR7独立8ece的macOS Base64测试超时仍为RED；2111ms是多个resolve所在整test累计，不能据此推断单worker2秒或精确阶段。PR32是确定性工作量早拒优化，非猜测性放宽预算。
- 985b955f / CI40374549274为真实RED：Windows重启第二轮后置pm.sendRequest尚未完成即到2秒wall，后续wait120尚未调度。不能由此认定native wait计时器错误。
- 确定性持有Cookie锁可复现同一签名，只证明旧日志不足，不能证明该次Windows原因。PR27增加上游接收/完成/关闭、重启轮次和fixture锁存在性诊断；没有提高预算、删除marker或放宽断言。9194和独立PR27本次通过仍不等于历史根因已修复。
- PR30旧a47的Windows故障fixture未保证提交前失败，真实返回typed unknown，保留RED。新89a使用真实损坏history JSON确保parser在journal前拒绝；严格generic/零journal/修复后零记录/revision不变/网络一次，生产分类不变。Windows底层errno未观测，不能把源码推断当实测。
- 99122、35153及a922最终cancelled不作完整绿灯；35153各平台观察到的非法ID错误回显已在PR19真实修复。旧失败与取消证据保留，不重跑碰绿。
- 短暂执行连接中断后已核对feature c48ccaa5与tree9a06aba5仍在，未发生工作区回退；只续存中断的GitHub对象上传，不把丢失前结果冒充恢复后验证。

## 明确剩余边界

- 原生task导出仅API-local非数据库混排声明；继承origin、冻结nativeTasks、纯脚本/空canonical管线及其他无法无损表达配置仍拒绝。没有完整反向导出全部原生资源。
- MCP仅在既有授权项目中对明确apipost/apipost-directory格式merge-only导入与只读导出；没有新增restore/newproject/扩权/隐式网络执行。
- 发送前4MiB文档/8MiB转义帧预检不保证传输送达。提交后断管或队列拥塞不能推断回滚或自动重试。
- 关闭数据库连接不能证明远端SQL回滚。保存定义、备份、显式发送正文和既有运行变量可能含敏感值，不承诺所有证据自动脱敏。
- 原版GUI重新打开/保存未验证；不运行未获许可的原版，不接受尚未确认的第三方许可。不宣称原版task ID稳定或其同步等待/执行安全语义与本实现完全相同。
- 更完整的协议/数据库高级配置、原生资源往返、分发签名和前端完整交付仍未完成；本轮没有新增前端或视觉工作。
