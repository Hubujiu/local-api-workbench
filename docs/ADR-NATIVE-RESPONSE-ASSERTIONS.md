# 原生响应断言

## 静态契约

合法取得的 Offline2 sender `send.asar/index.js` 模块 842216（LF 归一 Unicode
偏移 33582887–33593575）包含 `type:'assert'` 任务，数据为
`{type,expression:{path,compareType,compareValue}}`；测试名称使用任务 name。
`responseCode` 读取当前响应处理视图 code，`responseJson` 读取当前处理正文，
`responseHeader` 以未经 trim 的原 path 查询当前 HeaderList（大小写不敏感）。
Header 查询、预期变量替换及 eq/uneq 回调分别位于归一 Unicode 偏移
33584710、33586463、33586680–33587425；SDK casefold 位于 26121132。
eq/uneq 对实际值与预期值先 String 转换，比较失败由 pm.test 记录而不终止后续任务。
JSON 解析/路径读取在测试回调外，出错是阶段错误。UI chunk
`9269.86937a8833e2.js` 偏移 9656 的禁用默认形态允许 compareType 缺省。
来源/包哈希见 `ORIGINAL-OFFLINE2-RESEARCH.md`；本片只有静态证据与独立 fixture，
没有原版 assert task 的真实 wire 运行证据，不声称原版往返等价。

## 有界实现

- 启用 POST 任务仅支持 responseCode/responseJson/responseHeader/responseXml、eq/uneq，预期值必须为字面字符串。
  主动拒绝 `{{` 模板；原版递归变量替换与 Workbench 不同，不猜测映射。
  JSON 路径仅 own-property 单值段，空路径为 `$`，不 trim，不执行表达式、wildcard/filter。
- JSON 根必须为对象/数组，不回退 XML。选中 undefined/null/false/0 分别比较
  `undefined`/`null`/`false`/`0` 字符串；对象/数组及非有限数字明确拒绝，不隐式 stringify。
- Header path 只 casefold，不 trim、不解析 JSONPath、不验证为 pickVars 的字段名语法。
  空 path、带空白或 `$.x` 都是原样字段名；可信缺失值与字面值 `undefined` 都按
  String 比较为 `undefined`，空字符串与含逗号字符串原样保留。
- Header 复用 PR25 的私有 WeakMap 计数证据：HTTP/1 显式公共 1000 对解析上限，
  原生证据独立 256 对上限；HTTP/2 从真实 response 事件第三参数 rawHeaders 计数。
  无值证据不由响应字段、JSON 克隆、公开 get 或用户字段生成。缺失/不完整证据、
  选中重复、解析截断均为任务位置的阶段错误，删除/重写当前字段也不能清掉重复证据。
- 三态查询只接受：完整证据 count=0 且当前无自有字段→undefined；count=1 且
  初始有自有字段、当前为自有字符串→当前字符串；初始有且当前删除→undefined。
  Node 初始投影已丢失的 `__proto__` wire 字段不是脚本删除，明确拒绝；
  新增无 wire 证据的字段、getter、非字符串、数组（包括单个 Set-Cookie）、
  无效 Unicode 或超过 64 KiB UTF-8 的当前字符串也拒绝。
- 启动时仅捕获原归一化 map、自有字段存在性和安全内建函数；取值仍发生在声明任务位置。
  后续替换公开 HeaderList/get、整个 map 或内建函数不替换捕获来源。Header 分支完全
  绕过 body/code reader；即使这两者有 throwing getter，也不调用。wire 响应不可改，
  原 map 内字段允许同 phase 受上述约束的编辑。本片不新增 HeaderList mutator。
  pickVars 读取器未重构：仍 trim 字段名且缺失/删除严格报错，不变成断言的缺失语义。
- 禁用任务有界保存已知字段及未配置 compareType，不解析路径或展开模板。
  仍拒绝首片外来源、比较算子及未知字段，不把禁用任务变成任意不透明来源容器。
- 同一 VM 内保持项目→目录→接口顺序与词法作用域。调用捕获的 quota-wrapped pm.test；
  新声明式断言另保留私有真实结果，由可信出口合并，普通脚本改写公开 tests 不抹去它。
  私有结果使用无原型记录及自有 toJSON 屏蔽的数组，独立读取；公开结果引用碰撞时追加，
  不能用后一个 passed 覆盖前一个 failed。声明数和合并后结果仍受调用者断言配额及输出 1 MiB 约束。
  用户来源/路径/名称不拼入代码；没有新增主机 I/O 权限或函数求值。
- responseCode 捕获原响应 facade 后读取当前 code，包括 setCode 与直接 code 赋值；
  后者只是脚本处理视图，不将原 wire 状态或 responseOverride 伪造为已改变。
- `nativeTasks`、`importedScriptTasks`、`importedNativeTaskSource` 是声明/来源而不是 wire 字段，
  与 before/afterScript 一样不经请求整体插值。这是来源保真修正，不是新增模板能力；
  wire URL/header/body 仍正常插值，显式 pm.variables.replaceIn 仍使用既有运行时语义。
- 比较 false 是软失败：后续任务和普通计划步骤仍运行，沿用普通后置作用域提交规则。
  有启用 pickVars 的请求继续沿用其独立严格 fail-stop；本片不把 assert-only 改为 fail-fast。
- 未执行完声明断言（早退、吞取值异常）在可信 worker 出口判为阶段错误，是 Workbench
  显式更严格的完成性策略。比较 false 算完成，不因此产生阶段异常。
- 沿用每阶段 16 项任务、每项 64 KiB/总来源 256 KiB、路径 1000 字符/64 层、
  250ms active/2s wall/1000 条共享断言限额，不增加网络、脚本或数据库授权。

## 当前验收与组合边界

本地 focused 97 项通过（native-response-assertions、native-pick-vars、native-task-phase、
native-task-plan、dynamic-values、script-test-registration、apipost-modern 七个测试文件），
随后补 numeric prototype setter 的证据篡改用例定向通过；最终 CI 另行记录。
覆盖真实 HTTP business false→失败测试→后续脚本/计划请求、原 wire/当前视图区分、
变量/失败 run 保存、冻结后编辑、完整备份恢复/重启、两项目/两环境并发隔离与外项目环境拒绝。
错误矩阵覆盖解析/非原始值、早退与吞异常、禁用默认形态、soft failure 与 pickVars strict policy
共存、真实配额、取消、来源不可隐式插值，以及公开记录/重复引用/序列化/原型篡改不能擦掉原生失败。
第一阶段已知证据 index 碰撞由后续修复封闭；不能把三个初始成功测试当作完整验收。

不扩展原生反向导出。PR2 CLI DB collector 与 PR7 惰性 flow 来源的类型接入仍属组合依赖，
不复制整分支，也不得把 flow API 来源任务提升为实际执行。

### responseHeader 增量验收

新增 `native-header-assertion-boundaries` 与 `native-header-assertion-workflow` 独立 fixture。
真实 HTTP/1、HTTP/2 非 JSON 响应闭环覆盖导入、同阶段顺序、casefold/不 trim、当前 map
与原 wire、软失败后续脚本/请求与作用域提交、启用 pick 严格回滚、冻结后编辑、Store 保存、
手工 execute scope receipt、备份恢复/重启、项目/环境并发隔离和取消。
对抗覆盖缺失/空/删除/undefined/逗号、重复或伪造证据、getter 零调用、body/code 零读取、
投影丢失、原型/公开测试篡改、可信完成性及共享配额。H1 300 对是原生证据溢出，1100 对
是公共解析截断；H2 300 对先由既有 HTTP/2 传输限制拒绝，不声称进入原生断言后才拒绝。

这里的 receipt 是本分支已有手工 execute 入口。组合分支的 typed journal、CLI/MCP、
API-local export/reimport 与惰性来源仍须另外验收，不声称本片独立包含这些组合依赖。


## responseXml：WIP 有界字符串断言

本增量在同一 PR26 内复用 PR25 的私有 QuickJS XML 运行时及锁定 MIT 依赖；
不是主机 XML 提取器，也不是第二个 VM。原版 XML 断言异常可能吞为 null；本片明确
不复制这一兼容行为，解析/选择失败在 pm.test 回调外成为阶段错误，不能因预期为
`null` 或空字符串而误判成功。独立 intrinsic-guard 完整专项审查此前被平台中断，
**仍未完成，本增量不重启该专项，也不把正常正式回归当作其替代品**。

- 仅 `data.type:"responseXml"`、后置启用、字面字符串 expected 和 eq/uneq。
  `expression.path` 原样保存；编译时允许最外层空白，内部语法严格为 `string(P)`。
  P 仅绝对 ASCII 无冒号 child 名称路径，可用末段 `/@NAME`；最多 32 段/1000 字符。
  不支持裸节点集、count/boolean、wildcard、predicate、descendant、namespace、
  text()、任意函数或模板；禁用已知声明继续闭合、有界、惰性保存。
- 成熟 DOM/XPath 先要求 P 恰好选中一个 leaf Element 或 Attr，再执行 `string(P)`。
  零个/多个节点、含子元素的 Element、坏 XML 均拒绝；空叶节点和空属性可以与 `""`
  正常比较，CDATA/标准实体/合法数字引用保持文本值。CDATA/comment/PI 中看似非法
  数字引用的字面文本不被错误解析为实体；DTD/ENTITY 仍采用共享运行时的保守拒绝策略。
- XML 断言通过私有 reader 读取当前 response.body 的自有字符串 descriptor，不读取
  code、不要求 Header transport proof、不调用公开 text() 或 body getter。
  先前 setBody 可影响下一个 XML 断言；wire response 保持原样。每项任务重新解析
  当前 body，断言和提取混排时不错误复用前一次文档。
- 同一阶段只装入一次 XML bundle、创建一次 factory；factory/readXML 与两个 installer
  在同一私有 IIFE 内，共用 reader，不新增全局 lexical parser、DOM 或 require 入口。
  bundle 初始化、解析、XPath 与正式任务同受 16 MiB 内存、512 KiB 栈、250ms active /
  2s wall 共享预算。输入/标量字符串限 64 KiB UTF-8，节点及属性总计最多 2000、深度 32。
  上限不承诺所有最大组合都能在同一阶段时间预算内成功。
- 比较 false 仍是已完成软失败：可信断言记录、共享 quota、claimed index 与完成性检查
  不变，后续普通任务/计划继续；共存启用 pick 时继续其既有整后置阶段回滚/严格停止。
  禁用 pick 不激活严格策略。网络与存储已发生副作用仍不声称回滚。

正式验收包括 XML 原生导入/来源保真、真实 HTTP、当前 body 与 wire 区分、混排提取、
失败计划/变量持久化、手工 execute receipt、冻结、备份恢复重启、项目环境隔离及取消；
资源矩阵覆盖 64 KiB UTF-8、2000 节点属性、32 层、共享测试及输出限额。现有正式安全
回归与构建重现检查保持启用。此处不宣称原版完整 XML parity 或独立安全专项已完成。
