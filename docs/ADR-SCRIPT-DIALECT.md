# 显式脚本兼容模式

## 原因与来源

2026-10-22 静态复核官方 npm 包 apipost-runtime8@3.1.9（ISC，仓库 https://github.com/Apipost-Team/apipost-runtime）：其 dist/index.js 将 apt 绑定到 pm。这意味着现代 apt.response.json() 是方法、apt.variables 是请求局部变量，而本工具旧模式按此前独立 API 文档提供 JSON 属性和环境变量别名。不能用函数代理冒充 JSON 对象，也不能静默改变现存脚本语义。

包通过 npm pack --ignore-scripts 获取，只静态读取，不运行包代码、不引入其依赖、不复制实现。来源 SHA-1：4dca7d8012bbcf062ef70511a5316d4b84d29bc9。官方 Offline2 安装包此前静态研究确认引用此运行库，但不证明每个原版版本/GUI 行为完全一致。

## 契约

- 请求保存 scriptDialect：legacy（缺省）或 apipost8；未知值明确失败。
- legacy 完全保留 apt.response.json 属性、Header/Cookie 值视图及 apt.variables 环境别名。
- apipost8 子集让 apt.response、apt.variables、apt.info 使用已经实现的 pm 对应对象。JSON 使用 json()，Header/Cookie 使用集合读取接口，variables 写入只属于当前请求；前后阶段共享局部变量，不回写环境。前置 eventName 为 prerequest。
- pm API、旧全局 response、apt.setVar/getVar 和已有扩展不改变。不是把所有 apt 扩展声明为原版 API，也不是完整 runtime8 实现。
- 接口脚本页显式选择并确认切换；取消恢复原模式。计划步骤编辑器显示同一选择和语义警告，保存时校验；快照保留模式，源接口后续改变不影响快照。
- 本请求继承的共享脚本使用同一模式，界面明确警告；不自动推断或改写代码/导入数据。
- 不扩大 VM、时间、网络、文件或凭据权限。

## 验证

先失败回归确认旧实现无法调用 apt.response.json() 且未保存兼容模式；随后验证两种语义、请求局部变量跨阶段、无环境回写、非法模式和快照隔离。真实浏览器覆盖取消/确认切换与请求执行；三平台桌面包覆盖现代 JSON/集合接口与局部变量隔离。这些浏览器/成品包项目须以本提交 CI 成功为准，不能以本地核心测试替代。

## 剩余差距

文本表单集合与活动项的有界契约见 ADR-SCRIPT-FORM-BODY.md；响应正文/状态的有界处理视图契约见 ADR-SCRIPT-RESPONSE-MUTATION.md；完整 SDK、其他响应修改方法、环境元数据、完整第三方库/旧扩展、原版原生项目迁移和精确 GUI 对齐仍未完成。模式名称明确为子集，不能标记完整兼容。
