# 后端检查点 · 2026-10-27 10:08 UTC

本文按精确提交区分已保存、已验证与仍未交付。历史完整记录保留在本文件 Git 历史、各功能 ADR、PR 与 Actions；旧 GREEN 不覆盖新 RED，测试数量不是产品交付率。

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
