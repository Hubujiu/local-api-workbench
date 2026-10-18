# 当前复刻进度

完整98项核验见 [PARITY-CURRENT.md](PARITY-CURRENT.md) / [parity-current.json](parity-current.json)。原始基线 PARITY-AUDIT.md / parity-matrix.json 不改写。

## 最近已核验

eb2935b9e5031e44cbc7f91b416072a6a74b3a5e / Actions39113795792：9项全部通过，175项核心测试。包含三平台核心、真实浏览器、Windows x64/macOS arm64/Linux x64实际成品包启动、数据库集成与格式/依赖/资源重建校验。Mac仅CI临时签名，未公证。

自定义函数验证、固定/变量/有界Mock动态参数、Raw Body插入、Markdown预览/导出、七类属性与文档状态均已核验。OAuth1/AWS/Hawk/EdgeGrid、stdio跨进程进度、步骤认证/断言/提取编辑、CryptoJS/Chai与有限Apipost JSON导入也已核验。脚本兼容助手、前置断言证据、失败步骤分组展示、函数预览可见性与参考垂直间距也已核验；后续步骤表单文件与连接编辑须独立CI。

## 已发现并处理的问题

- Windows压测出现项目锁 mkdir EPERM：加入同进程队列及仅针对Windows该系统调用的短暂重试。固定十组100次压测、独立进程计数校验保留，后续CI通过。
- 一次跨进程锁竞争超时：新增锁归属/进度诊断，未降低计数要求；后续通过，但根因仍未得到确定性证明。
- 一次Windows打包启动空白：已保留渲染器/网络/进程诊断；后续通过，根因未确认。
- 曾把“智能Mock”理解为条件响应、把“错误码字典”理解为HTTP状态码：根据官方文档分开实现并更正清单，避免同名功能虚报完成。

- 1f40c0d一次Windows正则串联提取失败：补充实际步骤错误日志后75da820通过；未放宽执行预算，根因尚未确认。

## 主要未完成项

- 完整Faker/Mock.js目录、全量脚本SDK；有界Mock源与Raw Body插入已经实现。
- 部分API设计/高级步骤编辑与截图细节。Markdown已核验，HTML/远程图片仍按安全边界限制。
- 完整脚本SDK与异步/数据库联动；当前受限同步沙箱不是原版全部能力。
- 原版原生项目格式迁移；正式签名/公证发行不包含在当前CI成品包验收中。
- HTTP/2代理与cURL导出、更多数据库类型、高级压测及NTLM等认证缺口。
- Trae等真实外部客户端连接仍未执行；不派发外部Agent任务。

仍在同一PR #1 / develop迭代，未合入main、未部署。CI全绿只证明此提交的固定验收通过，不代表已完成完整复刻。

CI触发异常曾在673acb3/3eabe40出现；用户授权后于08:59UTC关闭并重开同一PR一次，恢复运行。Windows CLI早前一次失败未重现、原因未定，stdout诊断保留。
