# 明文 WebSocket 原生完整消息组出口（WIP）

本片仅迁移 source-backed 完整 `websocket2.message[]` 定义组，不声称原版完整会话、重连或 TLS 等价。JSON 与目录两代须保留消息顺序、消息身份及惰性 response 元数据，活动定义须全部一一消费，不能根据显示名称拆分重建来源。已有规范化及最终完整回读比较继续作为出口条件。

## 静态依据

合法 sender `index.js` SHA256 `5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`。以下均为 LF 规范化 Unicode 字符偏移（0-based），不是字节：模块844076位于37647016，clientConfig37648980，requestOptions37654343，connect37667512。实际使用 websocket 1.0.35（版本59098970），客户端模块557643位于37834776；37840129按wss判断secure，37843452直接Node http/https.request，37843855普通response处理，37844406对非101失败。实际sender不注册httpResponse，无自动redirect分支。因而字面量ws的302不会自动升级TLS；不能拿同bundle其他ws实现冒充这一调用链。

WSS仍拒：sender requestOptions 的 rejectUnauthorized:false 未证明能安全反向表达。保存的reconnect字段未在该sender模块消费，但不据此声称所有上层重连语义相同。Workbench继续保持验证开启、不跟随跳转、握手/消息/collect限额，不改变运行时预算。

## 当前阶段边界

只支持非空字面量文本、ws://、已知配置profile及已有安全握手行；WSS/http(s)别名/fragment/凭据剥离/requiredHeaders/未知配置/模板继续拒绝。缺失、额外、改名或改payload等非等价定义及历史身份塌缩均拒绝。原生空文本会实际发送空帧；等待PR13明确sendEmptyMessage意图及结构化身份guard最终依赖，当前空文本仍拒，不能借templateMode偷改旧receive-only行为。

基线PR14 16d0fdd / remote64167a69，纯base ad1e9e90未移动。首次新增完整组双格式两代测试实际RED于原WS拒绝；窄实现后与既有TCP/SSE完整文件5/5通过。此为工作中阶段，不是完整owner/SDK/CLI/冻结/恢复闭环或CI验收。后续必须记录最终依赖、空帧、loopback跳转控制及完整入口批次。
