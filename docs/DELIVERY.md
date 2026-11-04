# 当前后端候选交付说明 · 2026-11-04

这是独立整合候选，不是完整复刻、正式签名发行或部署。本文只对下面固定的提交、CI与实际包负责；`develop`、单功能PR和文档PR自身的代码/CI都不能替代该候选。旧交付记录完整保留在下方，旧功能缺口与原版运行记录不代表当前状态或当前许可。

- 候选提交：[`f11e4bbcb9d2b707a35893693ab6c8852a858847`](https://github.com/Hubujiu/local-api-workbench/commit/f11e4bbcb9d2b707a35893693ab6c8852a858847)。
- Git tree：`16d200c52772e4017ca8cfff778c0ecdb3bb3d3e`。
- 精确 CI：[41774839917，attempt 1，push](https://github.com/Hubujiu/local-api-workbench/actions/runs/41774839917)，25个展开job全部success。这个数量只描述流水线，不是产品完成率。
- 包的实际checkout、`BUILD_HEAD`及内包manifest.head均是上述提交。三份实际下载ZIP的SHA256匹配GitHub artifact digest；内包、外附与metadata manifest逐字一致。
- 本次只读逐文件核验通过：Windows9866文件/0链接、macOS10056/19、Linux9855/5。每包429份应用源码对照上述精确Git树；macOS/Linux字节一致，Windows390份仅CRLF差异、其余一致。实际PE/Mach-O/ELF头与下列架构一致；macOS/Linux主程序保留0755权限。没有在此次下载物审计中启动包或原版程序。

## 当前包下载与校验

这些是Actions artifact的**外层ZIP**，不是release asset。7天有效期以本次artifact记录为准；过期后不要把另一提交的同名包当成本候选。长期交付位置须另行确定，本文不创建或发布release。

| 平台 / 架构 | 精确下载入口 | ZIP字节数 | 到期时间（UTC） |
| --- | --- | ---: | --- |
| Windows x64 | [LocalAPI-Windows-portable](https://github.com/Hubujiu/local-api-workbench/actions/runs/41774839917/artifacts/13297290576) | 197008540 | 2026-11-11 04:44:46 |
| macOS arm64 | [LocalAPI-macOS-portable](https://github.com/Hubujiu/local-api-workbench/actions/runs/41774839917/artifacts/13296656940) | 160991972 | 2026-11-11 04:44:41 |
| Linux x64 | [LocalAPI-Linux-portable](https://github.com/Hubujiu/local-api-workbench/actions/runs/41774839917/artifacts/13296148957) | 154294136 | 2026-11-11 04:43:48 |

外层ZIP SHA256（下载后核对；不要拿它校验内层tar.gz）：

- Windows：`223f322268f155ce6d039abfa7304bce4d1abf5780658c738f8a0790beb039c1`
- macOS：`02c183a2b71b2cbf60aff238ea3d98f787e49bac1b888eebcdf95541a58ae6f0`
- Linux：`5db74ec77fac32fed0b0da43490e52fbc6c8ae625b1495b4a61e2badcae41226`

实际 `build-manifest.json` SHA256：

- Windows：`30b0710ca00efe42a6a307526eb9566fbfd85e6b2a148178251156dc8662ad35`
- macOS：`a32701d9f21c6884451bdeb3d62da018f4cccdcfad8fcbea5fa7be15f8440e60`
- Linux：`cb12e7e118a45376969d2c04a0bfa3ef703e30eabe4075619fd392593a4173aa`

### 使用和升级顺序

1. 选择匹配架构的精确包，核对外层ZIP哈希，再核manifest中的提交、platform、arch。不能只看固定版本号`0.1.0`，也不能以manifest完整性PASS代替来源身份核验。
2. 升级前导出当前项目备份并检查其敏感数据。正常退出旧桌面程序及其后端，确认旧进程停止后，把新包完整解压到独立目录；第二实例可能只激活旧窗口，不代表新包已经启动。不要覆盖运行中的文件，或让新旧进程同时使用同一数据目录。
3. Windows必须保留完整`LocalAPI`目录，再运行`LocalAPI.exe`，不单独复制exe，不要求另装Node.js。macOS/Linux解开外层ZIP后，还须解开其中`LocalAPI-macOS.tar.gz` / `LocalAPI-Linux.tar.gz`，保留执行权限与符号链接，再使用`.app` / `LocalAPI`。
4. 首次验证优先选择独立数据目录，用备份副本确认读取、保存、正常退出与重开；核对不会重放已完成的请求。默认桌面数据位于Electron userData/projects，和便携程序目录不是同一概念。
5. Windows正式签名尚未完成；macOS只有CI ad-hoc签名，不是Apple Developer ID签名或公证。遇到系统安全拦截时不要绕过警告。CI通过不等于目标机器已经验收，详见[桌面验证边界](DESKTOP-VALIDATION.md)。

## 六类后端范围与未完成项

这些边界属于上述候选，不能据此断言当前`develop`已经合入相同功能。详细实现与限制使用[候选提交的固定文档目录](https://github.com/Hubujiu/local-api-workbench/tree/f11e4bbcb9d2b707a35893693ab6c8852a858847/docs)，不借用后续变更。

- **存储与导入导出：** 项目保存、备份恢复、已支持原生定义往返和项目隔离已有组合合同。原生交换不等于完整Workbench备份；无法保真表达的资源/配置明确拒绝，不保证全部原生版本与业务数据。
- **协议与认证：** 已支持协议和认证保持各自范围、取消/超时与显式凭据边界；有界OAuth1本机回调已实现，不再列为完全缺失。部分原生协议/交换语义仍不能保真，更多协议扩展和真实第三方账号互操作不由本地fixture证明。
- **脚本：** 隔离运行时与受支持任务的顺序、配额、失败证据已组合；完整原版SDK、任意npm/文件访问仍不支持。脚本`Mock.mock`仅有界JSON模板子集，不是完整Mock.Random、占位符语言或全量模块。
- **Mock与数据库：** 受支持条件Mock/Schema及数据库能力已有明确合同；SQLite/PostgreSQL/MySQL有限DML和有界Redis SET均保留各自显式授权边界，但不是数据库全功能、完整Faker/Mock目录或通用Schema求解器。SQL Server、Oracle、达梦尚非此候选可用provider；独立WIP不能算接入完成，真实服务/许可/样本条件需分别满足。SQLite额外能力不替代这些原版模块。
- **计划与结果：** canonical冻结计划、有界repeat/IF、可选`failurePolicy: stop`及实际失败/保存证据已组合；默认continue和更高优先级的强制停止保留，已提交副作用不回滚、不自动重放。原生非空`automated_testings`仍明确拒绝，保存事件图/设置到执行器的装配桥和可信同源、同版本往返证据未闭合；已知第三方非空平级样本与文件夹适配器不能补齐该链路，不能把canonical控制流称为该原生格式兼容。
- **MCP：** 官方SDK HTTP/stdio的权限、执行、撤权与结果读取合同不等于所有外部Agent/客户端实机验收；项目allowlist、读写/执行、数据库授权仍各自受限。

GUI的原版完整操作流程与像素一致性未完整验收，本轮不扩大前端开发。支持平台限本次Windows x64、macOS arm64、Ubuntu22.04 x64实测包，不承诺Intel Mac、其他架构/系统版本或全部Linux发行版。正式签名、公证、安装器和长期发行渠道也不由本次portable候选自动获得。

## 历史失败与证据边界

- 旧完整根`da97a0e9` / CI`40549158177`曾通过；其后的`6c238a41` / CI`40551216982`有macOS脚本跨作用域配额失败，底层原因未记录，仍不能宣称已解决。当前绿灯不改判那次失败。
- `d8fa00d1838b445c8bd7041798739d67159005a9` / [CI41772182856](https://github.com/Hubujiu/local-api-workbench/actions/runs/41772182856)新增四条SDK撤权合同失败，实际差异为JSON持久化省略undefined对象成员与内存期望不一致。后续只修正期望的JSON表示并加反例控制，没有放宽权限、结果、次数、隔离或应用安全预算；旧run仍是失败，不以当前绿灯覆盖。
- 早期Windows路径断言、历史XML/SQLite及其他偶发失败按各自记录保留。本文没有重跑已暂停专项、运行原版、接受新许可或证明未知根因。
- [当前精确CI](https://github.com/Hubujiu/local-api-workbench/actions/runs/41774839917)和本次下载物核验只覆盖所列合同；不能据此承诺完整复刻或计算交付百分比。更改代码或重打包后须重新核验新提交和实际产物。

## 以下为早期交付记录（历史原文）

以下能力、缺口、原版试用/运行和下载指引只属于各自历史版本，不授权当前运行原版，不替代上面的候选链接和边界；尤其旧“非OOB OAuth1/远程写入缺失”等表述不能当作当前状态。

## Local API Workbench 0.1.0 历史交付候选验收

> 本文更新至2026-10-21。可运行候选不等于完整复刻；最新提交的验收结果见 [CURRENT-PARITY.md](CURRENT-PARITY.md) 与 [迭代记录](ITERATION-2026-10-18.md)。

### 范围

独立、免费、本地优先的 API 客户端，按 Apipost 单机版公开页面与操作文档实现常用工作流。使用原创品牌和前端代码，不包含付款、许可证激活、付费 AI、云账号或团队协作；不绕过原产品授权。原站没有独立免费功能版，因此“排除付费模块”按上述边界处理。

已下载官方Offline2 2.0.0安装包并完成静态互操作研究，但原版正常GUI启动被当前环境socket权限限制，尚无真实原生导出样本。本项目不能证明所有未公开行为或每个像素完全相同。当前属于可以安装、运行和验证的独立实现，不能表述成原版源代码、原生项目文件完全兼容版或完整兼容其脚本 SDK。

### 能力与固定证据

| 能力                                             | 实现                                                                                                                                             | 固定验证入口                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 项目/接口/文件夹/搜索/标签/复制/回收站/归档/恢复 | JSON 本地持久化、自选目录、原子保存、配置版本冲突检查                                                                                            | runtime.test.mjs、server.test.mjs、ui-smoke.mjs                                     |
| HTTP/HTTPS                                       | Query/Path/Header/Cookie，JSON/raw/form/file/binary/MessagePack，Basic/Bearer/API Key/Digest/OAuth2/OAuth1 HMAC/RSA-SHA1/AWS SigV4/Hawk/EdgeGrid | runtime.test.mjs、connection.test.mjs、digest.test.mjs、oauth.test.mjs              |
| 网络边界                                         | 超时/取消、8 MiB 请求响应上限、压缩响应、自定义 CA、客户端 PEM、HTTP(S) CONNECT 代理                                                             | runtime.test.mjs、connection.test.mjs                                               |
| 导入/导出                                        | OpenAPI JSON/YAML、本地递归引用、Postman、cURL Bash、有限Apipost公开JSON、备份恢复、独立 HTML/Markdown 文档                                      | core.test.mjs、document-export.test.mjs、ui-smoke.mjs                               |
| API 设计                                         | 描述、请求 Schema、响应示例、数据字典、loopback Mock                                                                                             | core.test.mjs、server.test.mjs、ui-smoke.mjs                                        |
| 断言/提取/脚本                                   | 可视化规则、全局/环境/运行时/本请求变量、隔离QuickJS脚本、受限HTTP回调与CryptoJS/Chai、子请求/断言/日志证据                                      | scripts.test.mjs、server.test.mjs、core.test.mjs、ui-smoke.mjs                      |
| 执行计划                                         | 独立请求快照、重复步骤、顺序执行、失败继续、hash、逐步证据、最近 50 次                                                                           | core.test.mjs、plan-snapshots.test.mjs、cli.test.mjs、server.test.mjs、ui-smoke.mjs |
| 用例与压测                                       | 独立接口用例与执行计划、最多 100 请求/10 并发的有界压测                                                                                          | core.test.mjs、server.test.mjs                                                      |
| 协议                                             | WebSocket/TCP 交互、SSE 接收；最长 15 分钟、8 MiB、最近 200 消息                                                                                 | protocols.test.mjs、protocol-sessions.test.mjs、ui-smoke.mjs                        |
| 数据库                                           | SQLite/PostgreSQL/MySQL/Redis/MongoDB/ClickHouse只读查询、SQLite显式DML、临时会话授权的只读前后置查询与变量联动                                  | database.test.mjs、remote-database.mjs、desktop-smoke.mjs                           |
| MCP                                              | stdio 与可选 HTTP、显式项目 allowlist、独立读写/执行权限、同步 OpenAPI 稳定 ID                                                                   | mcp.test.mjs、server.test.mjs、ui-smoke.mjs                                         |
| 桌面与 Git 入口                                  | Windows x64/macOS arm64/Linux x64 Electron成品包、自选项目位置、打开目录/终端、关闭未保存提示                                                    | desktop-smoke.mjs、terminal.test.mjs                                                |
| 可视界面                                         | 浅色/深色、紧凑布局、编辑器行号/JSON 高亮、响应/日志/历史                                                                                        | code-format.test.mjs、ui-smoke.mjs 的截图/视频/trace                                |

CI十项：Linux/macOS/Windows核心测试、真实Chromium测试、真实PostgreSQL/MySQL服务测试、格式/依赖/构建资源审计、三平台实际打包程序启动测试。测试访问本地临时fixture，不使用用户业务账号或压测第三方服务。macOS仅CI临时签名；未经Developer ID签名或公证。

### 安装与数据

1. 打开PR #1已验证成功提交的Actions，根据平台下载LocalAPI-Windows-portable、LocalAPI-macOS-portable或LocalAPI-Linux-portable。必须核对运行关联的提交；不能以旧版本绿灯替代最新失败版本。
2. 完整解压：Windows运行LocalAPI.exe；macOS/Linux先解开内部tar.gz以保留执行权限和符号链接，再运行LocalAPI.app或LocalAPI。先核实仓库来源及build-manifest.json中的提交和SHA256。若系统阻止未签名程序，应由用户自行决定，自动操作不会绕过安全提示。
3. 默认桌面数据位于 Electron userData/projects；可以在项目界面选择单独目录。
4. 源码方式：Node.js 24，npm ci，npm start，使用终端打印的带一次启动令牌的本地链接。安装依赖需要联网，之后运行无需云服务。
5. 项目备份、历史、脚本输出和导出文件可能包含凭据或业务数据。发送、提交 Git 或分享前自行检查。恢复备份前建议导出当前项目。

### 明确限制

- 不解析或声称兼容 Apipost 专有原生目录格式；使用通用 OpenAPI/Postman/cURL 或本工具备份迁移。
- 原站脚本 SDK 的完整兼容未实现。支持范围见 README：同步 apt/pm 变量、response、test/expect、console；支持有界HTTP/定时器/$.ajax回调，无任意npm或文件访问，有界Promise/await已验证，完整SDK仍未实现。
- cURL 导入不执行 shell、不自动读取 @file，也不支持 -L 自动重定向；不支持的选项显式报错。
- cURL 导出是 Bash 语法，非 cmd.exe/PowerShell 语法；会包含解析后的变量与凭据，不执行前后置脚本。二进制、MessagePack、文件上传或内联证书需单独组织文件，界面会明确拒绝不完整导出。
- 外部 OpenAPI 引用不自动联网下载；本地引用保留。远程文档分享采用用户自行分发 HTML/Markdown，不提供公共托管服务。
- 新建UI/MCP执行计划默认strict200，非200即失败；既有计划保留显式assertions策略，避免改写已保存的预期错误场景。
- Git 入口只打开项目位置与终端，用户执行自己的 Git 命令；不会自动提交/推送含密钥的项目。
- 数据库只读事务不能保证用户自定义数据库函数没有外部副作用；只连接可信数据库。
- TLS 证书验证不可关闭。MCP默认禁用；用户显式选择时可持久化本机配置及授权，端口冲突时关闭MCP。HTTP服务只监听loopback。
- 未完成签名、公证、商店发布、自动更新、跨机器同步和生产负载认证；不把 CI smoke 等同于所有人工边界验收。

### 验收状态

已核验功能提交dde1ea720242bb9dda15eae985563fa05a7146b6：402项核心测试、10项CI首轮通过，Actions39743195242。涵盖三平台核心与成品包、真实浏览器、数据库服务、生成资源与QuickJS可复现构建。后续提交须检查其独立CI，不能自动沿用此结论。未合并main、未部署。

本轮新增已验证：有界XML、嵌套目录及子树原子操作、显式开启的递归作用域、awaitable ajax与异步回调、保守allOf与引用交集样例、离线PNG/JPEG文档图片、OAuth1 OOB/PIN假服务流程。具体边界见对应ADR。OAuth未连接真实账户；图片不开放远程加载；生成器不是通用Schema求解器。

### 剩余交付缺口分类

- 实际功能缺口：完整脚本SDK和数据库高级操作/任意顺序联动、完整Faker/Mock目录、部分高级Schema和压测配置、NTLM高级部署、非OOB OAuth1流程、更多数据库与远程写操作等。SQLite 单语句显式写入的范围与验证见 ADR-SQLITE-WRITES，不等同数据库全功能。
- 互操作证据缺口：Offline2真实原生项目样本和全部隐含操作顺序尚未取得，不能声称原生迁移或所有历史格式兼容。
- 环境/分发缺口：原版正常GUI启动受限；未运行真实外部AI客户端；macOS仅临时签名，正式签名/公证未提供。
- 界面差距：保持原创品牌，主布局已按参考截图调整并验证，但没有逐像素等价结论。

以上明确区分已实现、已验证与尚未完成。测试通过说明指定契约的证据，不替代完整复刻验收。

2026-10-21 17:11 已核验：d0abac93 / Actions39640729111，363核心与10项CI通过。ClickHouse真实服务只读/精度、固定Faker别名与mockExp、数据库编辑及显式重绑定、脚本info与只读CSV迭代数据均有对应证据。保留之前ClickHouse两次差异与弹窗观测时序失败记录；后续修复没有放宽原断言或预算。

2026-10-22：449a52a 模型目录新建、改名、移动、仅删除空目录和取消/保存/刷新已通过全部CI。后续新增 PostgreSQL 逐次授权单条写入与只读扩展协议保护，详见 ADR-POSTGRES-WRITES；本地回归通过，真实服务和浏览器须检查本次提交CI，不能沿用449结论。

2026-10-22：dde1ea7 的 PostgreSQL 单条写入与只读批次拒绝已完成真实服务、浏览器和三平台验证，Actions39743195242全部通过。后续MCP参数形状/自有属性校验和数据库旧结果清理需检查其独立CI。仍不等于完整复刻。
