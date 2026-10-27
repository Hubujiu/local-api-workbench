# 原生 pickVars 响应提取

## 契约与证据

合法取得的 Offline2 静态 sender 模块 842216（Unicode 偏移
33593575–33600330）与 renderer 默认数据确认：`post_tasks` 中的
`{type:"pickVars", enabled:1, data:{source:"responseJson",variables:[{name,expression,type}]}}`。
`type` 为 `tempVars` / `envVars` / `globalVars`。空 expression 等于根 `$`。
项目、祖先目录与接口任务顺序拼接；路径读取当时的响应处理视图。
来源为 send.asar/index.js 模块 842216；renderer `9269.86937a8833e2.js`
Unicode 偏移 9913 为默认数据，work 主 bundle 模块 693291 偏移 1224434 为来源枚举。
来源包 SHA256 与合法来源记录见 `ORIGINAL-OFFLINE2-RESEARCH.md`。
本片使用独立编写 fixture；没有原版 pickVars 真实运行证据，不声称运行等价。

## 有界实现

- 启用任务仅限后置 responseJson / responseHeader / responseXml。responseJson 为严格 JSON 对象/数组根和 own-property 单值路径。
  保留选中值的 `0`、`false`、`null`；缺失与 null 不混同。
- 不执行 JSONPath wildcard/filter/function，不回退 XML，不插值路径；responseHeader 的有界契约见下节。
  禁用任务保留闭合、限额内的来源字段，但不执行、不要求路径有效。
- 任务仍在同一 QuickJS 阶段，前后 customScript 共享词法作用域。
  提取读取当前处理响应（包括先前 setBody），原始响应/状态证据保持独立。
  私有编译数据和捕获的可信解析/属性操作不赋予新的主机权限。
- 每阶段最多 16 个任务；每项提取最多 100 行/64 KiB，提取描述合计 256 KiB；
  单次任务选中结果复制最多 10,000 节点/64 层。沿用脚本运行时间/内存限制。
- 含启用后置 pickVars 的请求任一失败（包括前置阶段或网络失败）停止后续计划步骤。
  收到响应后，原始 wire 状态与全部断言、响应提取及后置脚本须成功才尝试持久化后置变量；
  失败恢复执行器内存中此前已提交的完整变量上下文（包含 runtime/hidden）。策略仅由主机规范化的冻结任务派生，
  不读取用户异常属性。禁用-only 与没有 pickVars 的旧提交/继续执行策略不变。
  Worker 的可信成功出口还核对所有启用提取已完成，不能以早退或跨任务 catch 隐藏未完成提取。
  全部提取完成后的 return 仍允许；原版静态材料未证明具备这个完成性保证。
  此为 Workbench 更严格的安全策略，原版外层事务行为未经证实；不回滚已完成网络请求、
  同一 VM 阶段中用户已执行的 `pm.sendRequest` 副作用或已成功提交的前置阶段。
- 持久化错误必须停止后续计划步骤，不自动重放已完成的登录。前置乐观并发冲突发生在写入前，
  不提交本次变量；发布 journal 后的磁盘 I/O 错误可能已部分应用，重新读取可能恢复并向前提交。
  因此内存恢复不代表磁盘回滚，`recordSaved:false` 也不证明变量未写入。
  本片不改变 Store 事务模型、不承诺网络或磁盘回滚。现有存储结果分类由对应存储模块负责。
  仅主机持久化回调的确切 `PROJECT_COMMIT_UNCERTAIN` 被投影为
  `scopeCommit:{outcome:"unknown",retrySafe:false}` 与固定提示，不传播路径、cause 或任意错误码；
  VM 伪造字段不生成该标记。独立 PR9 基线没有此存储类型，真实 journal 分类仍需组合存储层验收。

## 检查点与组合边界

`node --test tests/native-pick-vars.test.mjs` 覆盖真实登录 HTTP→提取→同阶段脚本→
后续 Bearer HTTP、并发项目/环境隔离、冻结后编辑、原响应/处理视图区分、完整备份恢复和重启。
错误矩阵含真实第二个 Store 并发写入导致的变量冲突，确认无后续计划 HTTP、磁盘保留并发写者值，
冲突时不提交本次后置变量，已成功的前置变量保留。另有真实目录 I/O 故障测试，确认
`recordSaved:false`、无后续请求且不重放登录，恢复后允许已发布 journal 的变量向前提交。
另覆盖 strict JSON/路径、标量根、断言/脚本异常、
原 wire 500 不被 setCode200 掩盖、前置/网络失败、禁用-only 旧行为、不能伪造主机策略及限额。
首个 WIP 提交中已记录的断言/持久化 fail-stop 缺口由该批次修复；CI 与组合入口验收另行记录。

不扩展原生反向导出。基线没有 PR7 惰性原生 flow 来源或 PR2 CLI DB grant collector；
组合时须显式识别/验证新类型或原子拒绝，不能把 flow API 快照惰性任务提升为执行。
完整 Workbench backup 保留来源/冻结计划，与原版导出往返不同。

## responseHeader：有界的单字段登录令牌闭环

独立契约仍来自上述合法静态包，非原版运行结果。sender `index.js` SHA256 为
`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`。
按 Python `read_text` 通用换行后的 Unicode 字符偏移（不是字节）：
`responseHeader` 分支 33595020，trim(expression) → HeaderList.get → scope.set
33598468；HeaderList 大小写不敏感 26121132，get 26181997。
原版 transport 在 27940679 / 27942549 先按原始拼写分组，27964991 再展开，
随后交给 HeaderList。因此混合拼写交错重复不能推定为最后 wire 字段值。
本实现不复制原版代码，不运行原版 GUI，不宣称原版重复头或吞错行为等价。

- 数据为 `source:"responseHeader"`、`variables:[{name,expression,type}]`。
  expression trim 后必须是字面 HTTP token 字段名，匹配不区分大小写；
  没有模板插值、JSONPath 求值、XML 回退、cookie 提取或 header assert。
  类似 `$.token` 若本身符合字段名语法，也只是字面头名，不是选择器。
  禁用任务只验证已知来源、闭合字段和已有限额，不编译/激活其表达式。
- 必须有**完整、有界的真实传输证据**，选中字段按大小写折叠后恰有一次。
  HTTP/1 从 `IncomingMessage.rawHeaders` 计数；HTTP/2 仅从 `response` 事件
  第三个 rawHeaders 参数取证（排除伪头，不从已合并 headers 反推）。
  缺证据、畸形数组、重复或超限一律拒绝，绝不逗号拆分、数组取尾或猜测。
  单字段值 `one, literal` 与空字符串原样保留；当前值必须为 own primitive string，
  包括单个 set-cookie 仍为数组时也拒绝。原版缺失值可能继续传 undefined 并吞错，
  Workbench 为避免旧 token 流入后续请求而严格失败。
- HTTP/1 显式维持原生默认 `req.maxHeadersCount=1000`，在 request 返回后、
  socket/parser 的 nextTick 绑定之前设置；不降低普通响应可见头范围。
  独立 Node 24.22.1 loopback 证明小于 16KiB 的短字段也可触发 1000 对截断，
  所以不能仅凭头字节预算宣称完整。饱和前缀不得作为唯一性证明。
  native 证据另限 **256 个原始字段对**（HTTP/2 的伪头占原始对数），
  字段名合计最多 64KiB；超限只让 Header 提取失败，不影响普通响应或 JSON 提取。
  HTTP/2 现有 session 头限额、全部网络/脚本预算保持不变，不放宽其拒绝超限行为。
- 传输返回对象的身份通过主机私有 WeakMap 关联冻结的 count-only 证据。
  不重复保存敏感字段值，不增加公开响应字段；历史 JSON、克隆对象、导入对象或
  JS 伪造同名 metadata 都不能恢复证明。runScript 将证据单独传给 worker，
  bootstrap 在用户代码前捕获私有 JSON 数据和原归一化响应头 map、own-descriptor/
  hasOwn/字符读取器；不调用可替换的公开 `headers.get/has/all`。
  本阶段原 map 已有字段的直接字符串修改可被读取，但整体替换 map/facade 无效；
  新增无 wire 证据字段、删除字段、getter、非字符串、无效 Unicode 或超过 64KiB
  的 UTF-8 值拒绝。getter 不执行，也不能通过 Object.prototype.value 冒充数据属性。
- Header-only 任务不解析正文；HTML 登录响应可用。安全 body/status 修改不影响头证明，
  原始 wire response/记录保持不变。不新增响应 HeaderList 修改 API，不支持跨阶段
  header override；原生任务与共享脚本 sequence 仍按基线互斥，不扩展证明转移权限。
- 沿用本 ADR 的原子赋值、整后置阶段回滚、严格停止及完成性检查；捕获异常、return、
  伪造公开证据都不能把未完成提取当成功。已发生的网络或存储副作用不承诺回滚。

`tests/native-pick-header-workflow.test.mjs` 用独立合成 fixture 覆盖真实 HTTP/1 和
HTTP/2：原生 import → 冻结计划 → HTML 登录单头 → env/temp/global → 同阶段脚本 →
下一真实 Bearer → 保存/备份/重启、多环境/项目隔离，及取消/缺失/同拼写与混拼重复/
set-cookie/超过 256 对/1000 对截断、断言/网络/前后置失败时不发旧 token 后续请求。
`tests/native-pick-header-boundaries.test.mjs` 覆盖信任身份、冻结 count-only 数据、禁用
闭合形状、全部行验证后才写入、零 getter/正文读取、原型/公开函数/map 篡改与 UTF-8
值限额。测试没有原版 runtime parity 证据。原生反向导出与惰性来源仍由其独立模块
负责整合，完整 Workbench backup 往返不等于原版导出往返。

## responseXml：WIP 有界标量适配

同一合法静态 sender SHA256 见上。Python 通用换行 Unicode 字符偏移：
当前 `pm.response.text()` 来源 33594847；XML row 分支 33597075；
trim / DOMParser / `String(xpath.select(...))` 为 33597666。
原版裸节点集会经节点 XML serializer 再 String 转换，不是 Workbench 旧 host
XML 提取的 first-node textContent；原版 parse/select 异常还可能吞错并赋空字符串。
本适配不复刻这些行为，也不声称与原版 XML 全功能运行等价。

- 仅 `source:"responseXml"`、后置启用任务；行和作用域仍复用同一闭合 normalizer。
  表达式仅 trim 后 `string(P)`，P 为绝对 child ASCII NCName 路径，不能有冒号、
  wildcard、predicate、descendant、变量/模板、其他函数或末尾 text()；末段可为
  `/@NAME`。路径最多 32 段；整个表达式沿用 1000 字符限制。禁用声明保持惰性。
- 用锁定的 MIT `@xmldom/xmldom 0.9.12` 和 `xpath 0.0.35` 执行真正 DOM/XPath。
  先对同一 P 查询节点集，要求恰好一个 Element 或 Attr；Element 必须没有子元素。
  再执行真正 `string(P)` 标量读取，保留空字符串、文本、CDATA、标准实体/数字引用。
  标准 XPath 对零节点会返回空、对多节点会取首，本片明确更严格并拒绝这两种输入。
  不以手写 XML/XPath 引擎替代成熟包。不新增 XML 断言、namespace resolver 或新公共 require。
- 私有可复现 bundle 仅在存在启用 XML 提取时装入同一 QuickJS，初始化也计入现有
  compatibility 活动预算；没有 host parse hook、第二 VM 或逐行独立计时器。
  `build-native-xml.mjs --check` 比较 bundle、来源 hash manifest 和 MIT notices。
  factory/readXML 与 pick installer 在同一个私有 IIFE 内，不留可被脚本直接调用的
  全局 lexical parser；selector 内还复用同一表达式语法检查。
- 读当前 response.body 的 own data descriptor，不调用公开 pm.response.text、xml2Json
  或 body getter；先前合法 setBody 有效，原始 wire 记录不变。所有行完成读取验证后
  才调用变量 setter，复用原有 post rollback / strict stop / completion。
- 输入和字符串结果各最多 64KiB UTF-8，拒无效 Unicode、XML 1.0 控制字符和非法
  数字引用（包括零、surrogate、FFFE/FFFF、超 Unicode 范围）。数字引用预检只检查
  会展开引用的正文/属性上下文；CDATA、注释和 PI 内字面 `&#0;` 等仍合法并保持原文。
  拒 DTD / ENTITY 声明（沿用保守预检，CDATA/注释内的声明字面也拒绝），
  strict onError 拒成熟 parser 的 warning/error/fatalError。整份文档的任何节点/属性
  都不得含命名空间声明或 URI/prefix，不仅限于选中路径；即便无关分支的 namespace
  声明、空 `xmlns=""` 或标准 `xml:lang` 也拒绝，避免隐式 namespace 匹配。
- 本片节点及属性总上限收窄为 **2000**（含 Document、元素、文本、注释、属性等），
  元素深度最多 32。构 DOM 前另作元素数预检。既有 xml2Json 的 10,000 上限不变。
  真实 QuickJS 10,000 节点样本在原 250ms 预算超时；2048 样本约 123ms，故选 2000
  留余量，不放宽 16MiB 内存、512KiB 栈、250ms phase 活动或 2s wall 预算。
  各上限只是安全边界，并不承诺所有最大组合/多任务都能在共享预算内成功。
- 成熟包依赖可变 JS 内建方法。bootstrap 捕获指定全局绑定、constructor/prototype、
  方法函数自身和迭代器原型链的 descriptor/prototype 图；每次 XML 任务前用捕获的
  descriptor/ownKeys/prototype/Object.is 检查，篡改即拒，不修复或冻结用户全局。
  检查路径不调用脚本 getter；失败使用固定原语，不依赖可改的全局 Error。
  这是针对锁定依赖的保守检查，不是对任意 JS 篡改的一般安全证明。

检查点：真实 HTTP XML 登录→env/temp/global/同阶段→下一 Bearer→Store/备份/重启，
冻结后编辑、项目/环境隔离、失败回滚/停止/取消、JSON/Header/XML 同阶段共存首批 20 项通过。
独立审查已指出并复验关闭一个 global lexical parser 暴露缺陷；随后独立 guard 完整审查
被平台中断，**尚未完成**，本片按 WIP 保存，不将局部修复证明宣称为完整独立安全验收。

### XML 共享 phase 资源修正

组合 CI 的并发项目场景包含同一当前正文上的 7 条 XML 断言，每次仍必须先检查完整
intrinsic 图。正常资源分段测量显示，约 200B 文档每次 DOM parse 为 0–2ms、select
为 0–3ms，而旧 guard 约 8–16ms；主要额外开销是比较 descriptor 的 6 个字段时，
对双方 descriptor 再分别创建 descriptor。改用 bootstrap 捕获的 hasOwn 检查双方
字段是否存在，再以捕获的 Object.is 比较**存在的 own data 字段**。这些记录均由
捕获的原生 getOwnPropertyDescriptor 生成；缺失字段绝不读取继承值或触发 getter。

全部对象/方法函数、symbol own keys、原型身份、全局绑定和每任务前置检查均不减少，
没有 DOM 缓存、跳过检查、预算提升或并发串行化。本地相同 7 次读取的 guard 合计由
约 61–72ms 降至 33–37ms；真实 worker 的两项目并发资源回归继续使用原预算。
数值是本机样本而非跨设备性能保证；正式全量 guard 回归保留，仍不代表已完成此前
被中断的独立专项审查。

## responseText：有界当前完整正文

同一合法静态 sender SHA256 见上。按 Python 通用换行后的 Unicode 字符偏移，
33594865 / 33594935 在整任务开始读取一次 `pm.response.text()`；33599541 的每行
直接把该文本赋给 trim 后的 name，完全不读取 expression。SDK text 的 30688624
优先解码当前 stream，否则返回当前 body；本片仅采用 Workbench 已有 decoded body /
setBody 合同，不声称原 SDK 的 stream、charset 或缺失值持久化逐项等价。

- 新增 `source:"responseText"`，仅启用后置任务；所有行取得同一份完整当前正文，
  不 trim 正文、不做 String 强转、JSON/XML 解析、正则、子串或模板求值。空字符串、
  空白、非 JSON 文本及合法 Unicode 原样保留，仍限每值 64KiB UTF-8。
- Text 行仍为闭合 `{name,type,expression?}`。仅此来源的 expression 可以缺省；若自有
  则必须是现有 1000 字符内的有效 Unicode 字符串，原样保存（包括模板字面），但不执行。
  自有 undefined、非字符串、getter、隐藏字段、稀疏数组和未知来源继续拒绝。其他来源
  的必填字段及表达式语义不变。原始 name 保存用于往返，仅编译时对 Text name trim，
  并在 trim 后执行安全变量名校验，包括拒绝带空白的 `__proto__` 等保留名。
- `native-response-text.mjs` 的可信 factory 在既有 installer 私有 IIFE 内创建 reader，
  不留全局 lexical 入口，不增加 host 权限/依赖或 XML bundle/guard。bootstrap 捕获
  原 response 对象和 descriptor / hasOwn / 字符读取器 / Error；每任务一次读取当前
  own enumerable data primitive-string body，不调用公开 text()、getter 或 toString。
  safe setBody 及原对象 body 的字符串更新对后续任务可见，原 wire response 不改变。
- 缺失正文、非字符串、getter、无效 surrogate 或超限是阶段错误，不把 undefined
  转为空串或字符串。原版可能把 undefined 继续交 setter，本片为避免伪成功/旧 token
  后续请求明确更严格。仍复用全任务各行先验证再写入、整后置回滚、严格停止、完成性
  和取消规则，不提升任务/值/阶段/VM/网络预算。
- 冻结 nativeTasks 与既有脚本文本一样不参与 HTTP 字段的递归模板替换；否则惰性的
  Text expression 或禁用任务会在登录请求之前被意外执行。任务中的脚本只在自身执行
  时显式 replaceIn，HTTP URL/header/body 模板和数据库任务既有约束不变。

`native-pick-text-boundaries.test.mjs` 覆盖闭合形状/optional 字段/trim 安全名、单任务
单读取、零 getter/强转、原语捕获、空值/Unicode/64KiB、当前正文和私有 reader。
真实 H1/H2 workflow 另覆盖原生导入→三个 scope→后续 Bearer、冻结定义、项目/环境隔离、
Store/备份/重启，以及后置失败/取消不提交、不继续使用旧 token。Workbench backup
往返不是原版 native export 等价证明；XML 未完成的独立 guard 专项状态保持不变。

## Request body snapshots: bounded JSON5 and empty bodies

The existing PRE-only configured request snapshot now accepts JSON5 object/array
bodies using the already locked MIT `json5` 2.2.3 and its existing same-VM entry.
No new library, loader, public API, host parsing capability or execution budget is
introduced. Only a nonempty raw/json body requests the parser; Header-only, none,
and exact-empty body snapshots do not activate it for this feature. The parser is
obtained and invoked during private phase initialization, before custom tasks.
SDK body edits still change the actual wire request, not this phase's snapshot.
Original raw bytes and native declarations remain unchanged in stored/frozen data.

Static evidence uses the sender SHA-256 already recorded above, LF-normalized
Unicode character offsets (not bytes): legacy request.data at 28717191 takes
raw/form/formData/file content and falls back to {}; RequestBody.isEmpty in
26241000–26242900 treats an empty string, but not whitespace, as empty. At
33567496 request.data is tentatively JSON5-parsed and JSON-stringified into
request_bodys; at 33594003 the pick task parses a string again. These are static
observations, not original GUI execution or complete legacy transport parity.

Workbench accepts none, missing raw/json body and exact empty string as a new
empty object. Whitespace/comment-only documents still fail parsing. Input remains
valid Unicode and at most 64 KiB UTF-8. A quote/escape/comment-aware resource scan
rejects nesting beyond 64 before parser invocation; this is not a second syntax
parser. JSON5 alone validates syntax, with no reviver. Existing copied-value
checks retain finite numbers, object/array root, Unicode and string byte limits,
10000 nodes, 64 levels, own data properties and reserved-key rejection. Invalid
syntax, primitive roots, NaN/Infinity, files/GraphQL and ambiguous text form rows
remain unsupported. In particular, original swallowed errors or stringify's
nonfinite-to-null coercion are not reproduced.

Per-source errors remain deferred to the corresponding task. All-row validation,
phase rollback, active-pick strict plan stop and shared runtime budgets are
unchanged. Original JSON5 acceptance does not imply that a raw wire body is
canonicalized: ordinary request sending keeps its existing mode contract.

Verification includes actual HTTP/1.1 and HTTP/2 native import, initial snapshot,
three scopes, SDK wire edits, later request consumption, frozen definitions,
backup/restart, isolation and later-row/phase failure. Empty bodies and strict
JSON are controls. The new grammar/empty-source fixtures failed before this
change; existing source/accessor/array/depth protections remain regression tests.
