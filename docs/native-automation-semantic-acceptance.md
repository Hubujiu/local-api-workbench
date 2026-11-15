# 非空原生自动化：可复现语义验收边界

基线 #251 tree `7a79f59f1e339604c000551015958ad6d90fbef1`。
本轮不增加兼容导入、不运行原厂软件、不下载专有内容、不执行导入请求。
原生非空 automated_testings 仍明确不支持，不能称为只差实测。

## 证据来源及限度

本次只复用 [既有静态证据记录](NATIVE-AUTOMATION-STATIC-GAPS.md)，未重新获取原始材料：

- 公开第三方 [transcription-service 固定提交](https://github.com/dabiaoge252/transcription-service/tree/0a1fa719078f3177f0ea961aa8116abb9a751616)，
  blob `6eb1e120cfc2cba9b6cd1a40f8a999f439357018`，SHA256
  `4fe6820c21865b7ef8351191131e59e3ca1faf46e124014f941b2b3c6b470f07`。
  已记录事实是 1 项 automation、7 个根 API 事件；数组和 sort 同序、live 引用、apiData=null。
  不是官方或同版本原厂执行证明；仓库无许可证，不复制原始文件、身份、URL、凭据或实现。
- 已记录的 [EchoAPI 适配器固定提交](https://github.com/EchoAPI-Team/echoapi-for-vscode/tree/bc8ecb58271ac7a8b0289fad2f0455745b4562f1)
  只提供文件夹运行配置与根 API 事件的静态调用链，不提供 saved automated_testings 图转换证明。
  本轮不复制其代码或内嵌 runtime。

## 哪些证据才足以启用下一步

| 边界                         | 现有事实不能推出                         | 未来必须取得的可核验结果                                          |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| 数组与 sort 冲突、缺省、重复 | 任一排序优先级或默认值                   | 同版本输入、确切有序执行轨迹、保存后再导出结果；每种冲突独立结论  |
| parent 缺失、成环、嵌套      | 自动升根、修图或父先子后规则             | 原厂拒绝或规范化行为，以及合法层级的 ordered children 装配链      |
| live API、apiData、父层依赖  | live/snapshot 优先级或补依赖方式         | 具有明确来源的配置变化前后执行请求快照、引用解析和往返证据        |
| settings/env/data            | execute_count 等保存值等于 runner option | 保存→加载→runner 参数转换，默认与覆盖优先级、失败停止及变量作用域 |
| manual + 非空 frequency      | 调度可忽略或必须执行                     | 官方同版本调度含义；禁止把导入解释成启动任务                      |
| disabled 非空图              | 安全丢弃它就等于兼容                     | 原厂保存/导出保留与执行排除语义；未证前不能静默丢数据             |

不是索取笼统的运行许可，也不是要求复制未知专有格式。仅在合法可用参考环境和明确测试范围内补证；
在此之前，Workbench 自有 canonical repeat/if 只能声称自己的语义。

## 当前可执行门禁

```sh
node --test tests/native-automation-boundaries.test.mjs tests/native-automation-rejection.test.mjs
```

原创合成 fixture 保留 1 项/7 事件的结构规模，11 个独立变体覆盖上述未知处。
这些变体刻意不是“有效原厂出口”，也不定义它们应该怎样执行。
每个变体沿已有 direct、owner import/preview/apply、正式 MCP import/preview/apply 入口：

- 明确拒绝；失败预览不发可用 token；已有空 automation 预览 token 不能用于替换后的来源。
- 输入对象、两个项目对象、完整持久化文件字节和重开 Store 结果不变。
- 真实 loopback 业务请求计数不增加，不把拒绝当自动修复、忽略或重放许可。

本轮没有更改泛化错误合同。给公开预览增加“可迁移项/数量”会涉及 owner/MCP 结构与敏感内容展示合同，
不能绕过当前整块拒绝，或让用户误以为已经支持自动化。
测试通过仅证明上述失败关闭边界，不代表原生执行/往返兼容已通过。
