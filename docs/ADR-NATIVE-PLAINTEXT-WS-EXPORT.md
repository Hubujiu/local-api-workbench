# 明文 WebSocket 原生完整消息组出口（WIP）

本片仅迁移 source-backed 完整 `websocket2.message[]` 定义组，不声称原版完整会话、重连或 TLS 等价。JSON 与目录两代须保留消息顺序、消息身份及惰性 response 元数据，活动定义须全部一一消费，不能根据显示名称拆分重建来源。已有规范化及最终完整回读比较继续作为出口条件。

## 静态依据

合法 sender `index.js` SHA256 `5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`。以下均为 LF 规范化 Unicode 字符偏移（0-based），不是字节：模块844076位于37647016，clientConfig37648980，requestOptions37654343，connect37667512。实际使用 websocket 1.0.35（版本59098970），客户端模块557643位于37834776；37840129按wss判断secure，37843452直接Node http/https.request，37843855普通response处理，37844406对非101失败。实际sender不注册httpResponse，无自动redirect分支。因而字面量ws的302不会自动升级TLS；不能拿同bundle其他ws实现冒充这一调用链。

WSS仍拒：sender requestOptions 的 rejectUnauthorized:false 未证明能安全反向表达。保存的reconnect字段未在该sender模块消费，但不据此声称所有上层重连语义相同。Workbench继续保持验证开启、不跟随跳转、握手/消息/collect限额，不改变运行时预算。

## 当前阶段边界

只支持字面量文本、ws://、已知配置profile及已有安全握手行；WSS/http(s)别名/fragment/凭据剥离/requiredHeaders/未知配置/模板继续拒绝。缺失、额外、改名或改payload等非等价定义及历史身份塌缩均拒绝。原生空文本会实际发送空帧；现依赖PR13明确的 `sendEmptyMessage=true` 意图及结构化身份guard，出口须有该显式标志且完整回读深等才接受。未设置/false的旧空消息仍receive-only，不能借templateMode偷改语义。

基线PR14 16d0fdd / remote64167a69，纯base ad1e9e90未移动。首次新增完整组双格式两代测试实际RED于原WS拒绝；窄实现后与既有TCP/SSE完整文件5/5通过。此为工作中阶段，不是完整owner/SDK/CLI/冻结/恢复闭环或CI验收。后续必须记录最终依赖、空帧、loopback跳转控制及完整入口批次。

## 完整入口与显式空帧检查点

在父任务审查并批准精确树后，纯依赖base仅合入PR13 f60c46c（含前序357b456身份guard），local dcd1e33 / remote03b3e52 / tree e0339b7；父项仅旧5f5c013（remote ad1e9e90）与f60c46c（remote1288991d）。不含root、PR14或PR43 ancestry；PR43独立固定base未动。导出功能先保存完整非空入口测试78eeb8e / remote388f144，再合入该纯base eebf747 / remote5a0c057。

空文本用例在放开出口前明确RED于“WS非空字面量文本消息”，随后仅允许显式标志、保留完整回读比较。两原生格式各两代包含普通/Unicode/空消息三成员，逐项保留param_id、顺序和惰性response元数据。真实owner HTTP及官方MCP SDK HTTP/stdio执行冻结计划；编辑活动URL/payload后原生出口400，而CLI仍执行原冻结三成员。项目备份恢复、owner服务关闭重开、新Store读盘后再次CLI运行，核验保存run IDs、源/第三项目隔离及转换/重启零网络。每组合实际12个文本帧（含4空帧），安全Accept-Language、重复Query镜像、原始%2f拼写与新增Unicode参数上线路一致。另验证ws端点302指向wss目标不会连接目标。

此检查点无原版运行、无源实现复制、无VM/XML压力验证、无预算放宽；功能的独立CI及root组合必须按最终tree另验，不继承旧绿灯。
