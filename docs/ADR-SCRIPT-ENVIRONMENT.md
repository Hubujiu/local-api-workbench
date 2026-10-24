# 脚本环境标识与集合

依据官方 apipost-runtime8@3.1.9 的静态兼容层：environment.getName() 返回选择的环境名称；environment.getCollection() 返回该环境变量；variables.getCollection() 同样明确返回环境集合，而不是所有有效变量的合并视图。来源与包校验见 ADR-SCRIPT-DIALECT。

本工具新增上述 getName/getCollection 方法（apt.environment / pm.environment、pm.variables；apt.variables依所选兼容模式引用其一）。pm.environment.id/name 是只读元数据，不混入变量集合，也不由CSV或同名环境变量覆盖。集合读取返回深拷贝，不泄漏全局/运行时/请求局部变量，修改副本不修改环境。

调试、用例、手工计划、CLI和授权MCP沿用实际选择环境的 scopedExecution 上下文；压测各迭代也携带实际选择的同一环境标识。名称/id在本次执行开始时快照，不因中途变量持久化重读或漂移。纯脚本测试/函数预览未提供环境时返回undefined，不伪造默认环境。元数据只接受id/name两个字符串字段，每字段最多200字符。

getPreUrl 暂不提供：原运行库历史单一前置URL与现代多服务URL语义并不相同，不能从本工具某个服务地址猜测全局前置URL。本次不是完整环境SDK或全部原版版本兼容。

先失败回归后验证环境与合并变量隔离、深拷贝、只读标识、非法输入和真实HTTP并发CSV压测环境选择；真实浏览器及三平台成品包的身份断言纳入CI，以对应提交结果为准。原VM预算和所有权限保持不变。
