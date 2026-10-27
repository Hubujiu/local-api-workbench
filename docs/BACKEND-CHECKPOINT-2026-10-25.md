# 后端检查点 · 2026-10-27 03:43 UTC

本文按精确提交区分已保存、已验证与仍未交付。历史完整记录保留在本文件 Git 历史、各功能 ADR、PR 与 Actions；旧 GREEN 不覆盖新 RED，测试数量不是产品交付率。

## 最新已核实与本次候选

- 最新完整绿色组合6e138867a9a44f2cf50a06aab29f24023213d911/tree81ad150cd6af0c0ec4e1653289ed294a485c77b3=local7f3c392822633450d5635db2c8afa60dad3f7bc8，CI40441667524首轮19/19；全部实际checkout/head/tree核实。三OS1807，12清单345文件87/86/86/86完整无重漏，hash2ae68cf19473b1a2f31e57708748f6ab26ed213e5d396dd3352a5d9be49da922。新OAuth1完整SDK/CLI/冻结认证/重启链、11来源14比较器及真实DB/stdio/固定c09引擎重建全部通过；不因此改判历史Mac RED或宣称唯一根因已修复。
- 本次新候选在同PR26接入第15种regularmatch：原始/trim后模式≤1024 UTF-16码元及4096 UTF-8字节、有效Unicode；实际有限原始值String后≤64KiB UTF-8。仅去除边缘斜杠、无flags，不将/abc/i误作忽略大小写；///为空模式仍执行。活跃原始空串明确拒绝（原版跳过），动态expected仍不支持。到任务实际执行才构造，语法错误在pm.test之外成为阶段错误；captured构造器/direct exec、私有完成性及全部共享预算保留。
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

| PR | 当前head | 精确独立CI与内容 |
| --- | --- | --- |
| #1 | 88f70bb515c48b93536b28b7fe3ec780f2e150f3 | 40136832590，首轮成功；02:41重读仍open/draft/unmerged |
| #2 | a3ffbcd00134d5846b2a8550a5d096cec9139b7f | 40275759477，首轮成功；02:41重读未变化 |
| #3 终态预算 | b7fc0df3ca74abf56a583d122af57b214f2951e5 | 40434429389，10/10；mergea438ffd8f188f646a54cb5ffc22d4152e1a54513/tree6c4d77a008c8feeb310d39acd525d3850969ceaf=head；三OS1038 |
| #26 原生断言 | 73feb85b2b9c4d1d9302871df70b8f93c6efb262 | 40444849052，19/19；mergec92d78fde00436f9feb1b1d5c18333fbdca7451b/tree8191bc287c0fc049a95e2dbb93bae04fc230b0a4=head；三OS1360；262文件66/66/65/65完整无重漏 |
| #35 CI文件隔离 | e13d60afa9e6f7dad3bebd3de6cc033e640f5bbd | 40439898640，19/19；mergeb8c7e4b57a3e24e3581c5231786c69bb62794d07/tree3f36b15ba5cef3266863e49b580e5b617822f968=head；三OS1033 |
| #36 实际堆计费 | 355bf9a2c68766a56769ba5359922dbff9432f5b | 40434252890，10/10；mergee10d71ced849a111ecd8b3d80ff18bb8c13a2ce9/tree46f52d3d0c13791d89a42488748c9a95bbe9beb3=head；三OS1028 |
| #38 正则中断/OOM修复 | 05c8f5834285b0dce866f4b8703fc4d7ba63c94e | 40443229089，10/10；merge8aaaafff50bfc779ea7b6c07b9b919215fad6b97/tree88195a31c9e7f02c89ef6772baef4dbf7e99ad88=head；三OS1039 |
| #39 OAuth1回调 | 5aa96e820186e30bde00f1aeecda4f580da5561a | 40440442949，10/10；merge4ed5e5a199bbadef6e9712dcc68431e58f235920/tree6e2ddea51467ab6d73f8c91a10060693346ba160=head；三OS1038 |

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
