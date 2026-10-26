# 有界原生文档与目录生命周期

## 决策与静态证据

本功能是独立实现，不包含、执行或复制原版实现。依据合法取得的 Offline2 静态接口：`utils/mcp-stdio.js` 的 `list_apis` / `get_api_detail` / `delete_apis` 输入；renderer `1550.0381c5a8bb4d.js` 的列表/详情/删除分派；renderer index 模块 977835 的项目内父子关系和回收行为。静态枚举为 `target_type: "doc"`，内置文档的正文位于顶层 `description`。已检查的真实项目文件中没有文档 fixture；这些不是原版 GUI/运行往返证明。

原版列表按直接父级和不区分大小写的名称/方法/URL关键词筛选；详情为 `{api: ...}`；删除须 `confirm: true`，并受项目写授权约束。静态删除底层展开子树，返回的 `deleted` 和 `target_ids` 却按原选中 ID 计数。本实现保持该输出，不把递归实际影响数量冒充原版计数。

## 输入与读取

- 现代和 legacy JSON 均支持有界 `doc`：名称→title，description→原样 content，父目录→folder；文档来源身份/排序/版本等声明保留。现代 mark_id 映射已验证的状态；未知状态、非空请求/响应/URL/任务、附件和其他未支持字段明确拒绝。正文不执行、不插值、不获取外部资源。
- ID 以来源项目和原 target_id 命名空间确定生成；重复来源内容冲突、已回收文档 ID、HTTP/协议 ID 冲突拒绝。请求专用导入入口拒绝含文档输入，不能悄悄只导入 HTTP。
- 两个不同来源目录不能折叠为相同路径。虚拟目录 ID 是 `folder:<path>`，根 `0` 不能删除；文档不能占用这些保留 ID。native 资源解析对跨资源命名空间及旧 HTTP 墓碑歧义 fail closed，但不在全局 Store 强制改变所有旧项目命名空间。
- 目录详情的 `workbench_folder_settings` 与文档/HTTP详情均明确标注 Workbench 定义格式；不宣称原版完整嵌套输出等价。

## 删除、持久化与边界

只支持 HTTP + 文档 + 普通目录。全批次预检后在 detached project 上修改并单次 Store.save；未知/重复 ID、协议子树、无法定位目录的 gRPC/Socket.IO 定义、未知活动 folder 设置等拒绝，不部分删除。

PR13 的原生 TCP 空连接容器可能只有普通目录和 `apipostProtocolSources`，没有可执行 protocol。该来源记录没有可信的当前 Workbench 目录关联，因此只要此来源集合非空，本批保守拒绝任何目录删除（仍允许单独 HTTP/文档 ID 删除），来源档案保持原样；未来须由协议导入提供可靠关联才能放开精确子树判断。原生目录声明仍沿用既有导入边界，不宣称新增完整原生目录配置编辑/往返模型。

`folders` 仍是活动字符串数组，不改变旧存储布局。新增可选 `apiResourceTrash: {version:1,batches:[...]}`：每批保存原选中 ID、时间、所有移出的目录路径、原显式目录、HTTP历史关联 ID、完整文档以及移出的四类目录声明（folderParameters/folderAuth/folderScripts/folderServices）。这些声明不留在活动继承作用域，也不被执行。HTTP继续使用现有 deletedAt；文档直接移出活动集合，避免既有导出/读取路径再次显示已删内容。仅从活动资源推导目录，已删 HTTP 后代不会令目录复活。路径边界是精确路径或 `path + "/"`，不会误删同前缀兄弟。

HTTP批次关联是历史事实，不锁住现有 HTTP 恢复按钮：删除 deletedAt 后仍能普通 PUT 保存，再次删除产生新批次；旧批次中的文档和目录声明不丢失。现有 HTTP 恢复不恢复已删除目录的继承声明。本批不提供恢复删除资源的工具，不声称一键回收站恢复。

批次最多100，合计最多10000资源及4MiB，不自动淘汰。Store.save 和 restoreProject 共享严格结构校验；访问器、unsafe键、非JSON原型、稀疏/附加属性数组、未知批次字段及超限在写 journal 前拒绝。文档内容单项最多1MiB。旧无字段项目不添加空默认字段。

完整 Workbench 备份/恢复保留 tombstone，恢复成新项目也不会自动激活已删资源或继承 MCP 授权。冻结计划、历史和来源档案不随资源删除；原有冻结 HTTP 步骤仍可显式执行。服务引用作为惰性历史声明保存，不据此授予运行权限。

这不等于 Apipost 定义/原生目录反向导出。PR14 组合必须显式拒绝或完整处理活动文档和回收声明，不能忽略后宣称往返。真正原生目录输入须在 PR6 组合上另验；本分支独立测试使用自编字段 fixture，不把手工 Workbench 文档当原版导入证明。

## 本地验收

`tests/native-document-lifecycle.test.mjs` 验证源输入不变、现代/legacy文档、冲突与不支持输入原子拒绝、直接父级/关键词、目录详情、完整官方SDK HTTP导入→混选删除→落盘→冻结请求真实HTTP→旧PUT恢复HTTP→再次删除→备份恢复→重启、项目与授权隔离、HTML/Markdown导出不复活文档，以及非法墓碑在Store写journal前拒绝。

无原版程序/GUI执行、许可接受、外部服务访问、前端功能或新依赖。
