# 有界脚本文本表单集合

## 依据

对照 Postman Collection SDK 固定提交 b378e3febf34c74da1d5ba8509ce4c1fe764172e 的 RequestBody、PropertyList、QueryParam 和 FormParam 接口，独立实现当前请求的文本表单子集，未引入上游依赖或复制其实现。

来源：https://github.com/postmanlabs/postman-collection/tree/b378e3febf34c74da1d5ba8509ce4c1fe764172e/lib/collection

上游集合保留重复字段，get/one 取最后一项，toObject 可保留重复值数组，all 返回独立数组但其中的项仍是活动记录。不能用只读副本冒充可修改项。

## 已定义的接口

- pm.request.body.update({mode:"urlencoded",urlencoded:[...]}) 和 formdata 对应形式替换当前执行请求的表单；缺省列表为空。已有 raw/字符串更新语义保持不变。两种现有脚本模式都可通过 apt.request 使用同一对象。
- 只接受文本项的 key/value，以及可选 type:"text"、disabled 布尔值、文本 description。新值须为字符串，缺省值为空；数字/布尔值须显式转为字符串，不静默丢弃 0/false 或把对象变成字符串。
- 活动模式下提供 body.urlencoded / body.formdata；其他模式返回 undefined。支持 get、one、has（可比较值）、all、idx、count、each、toObject(excludeDisabled)、add、upsert、remove、clear。
- 字段名区分大小写。重复项顺序保留；get/one/upsert 选择最后一个同名项，remove 删除全部同名项。upsert 新增返回 true、修改返回 false，未指定 disabled 时保留原值。get/one 包含禁用项；toObject 缺省包含，传 true 排除。实际网络发送仍排除禁用项。
- all 返回独立数组；one、idx、all、each 返回的文本项支持 key/value/disabled/type/description 赋值及 update 对象方法。变更经过校验后原子应用；upsert 保留项身份。toJSON 返回独立快照。
- 项被移除后，其旧值仍可读取，但旧引用不能写回请求。整个 body 更新后旧集合与项不能修改新数据，需重新获取当前集合。未提供删除属性、冻结对象、修改原型、任意 PropertyList 方法或字符串形式的 urlencoded 解析。

## 文件与边界

- 文件项只显示 key/type/filename/disabled 的只读元数据，不通过这些集合读取器返回文件内容。get(file) 为 undefined；one/all 仍能识别该文件项。已有上传数据与重新选择标记原样保留。
- 不能新增文件项、指定 src 路径、用文本 upsert 覆盖文件或写入文件项属性。文件须经现有界面选择；不扩大文件系统访问权。remove/clear 或整个 body 替换只移除本次请求的引用，不删除磁盘文件或原接口配置。
- 最多1000项；字段名1 KiB、单文本值64 KiB、描述8 KiB；所有字段名/文本值/描述/文件名合计256 KiB，含禁用项。字段名非空；multipart 字段名拒绝引号与换行，防止与实际编码后的名字不一致。拒绝无效 Unicode。
- 原有250 ms活动/2秒总期限、16 MiB VM、512 KiB栈、1 MiB序列化输出限制不变；其他数据及序列化开销仍占预算。没有脚本文件加载器或额外网络权限。
- 前置阶段修改影响本次请求；共享阶段继续传递请求数据，不保证活动对象引用跨独立 VM。后置阶段改请求不回写已发生的网络请求或原接口。
- 不自动改变显式 Header，不支持任意 GraphQL/file 模式或完整 SDK 的全部对象/描述类型。

## 固定验证

核心回归先确认现有实现拒绝表单更新，再覆盖重复/禁用项、活动项赋值与 upsert 身份、独立数组/快照、陈旧引用、Unicode/容量、失败原子性和文件拒绝。独立 HTTP 服务核验 URL 编码后的重复/中文值，以及 multipart 里原有选中文件字节和文本变更。浏览器从脚本编辑、保存到真实发送检查相同数据；三平台实际成品包执行集合和活动项断言。最后两类结果以对应提交 CI 为准。


## 隐藏属性的原子校验

新增、upsert、活动项 update 和结构化表单 body.update 对未知自有属性
同时检查普通、不可枚举及 Symbol 键，防止忽略未知字段后仍返回成功。
活动项 patch 中合法但不可枚举的字段按名称读取和应用，不因对象展开而
静默丢弃。校验在提交前完成，失败保留原行与活动项身份。
这是一致性修复，不宣称发现了主机权限突破；文件只读、容量和 VM 限额不变。
