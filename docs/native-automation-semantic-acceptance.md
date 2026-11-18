# Apipost 8.2.7 联网版自动化迁移

Workbench 能将联网版项目 JSON 中的手动 HTTP 测试用例导入执行计划。支持按序执行的实时引用、冻结副本、独立 HTTP 步骤、禁用步骤、固定轮数、逐请求间隔和一个固定次数的根循环。每个用例保留执行环境和遇错策略。

## 2026-11-18 同版本对照

在 Windows x64 的 Apipost 8.2.7 协作版中新建独立项目。三个 GET 接口仅访问本机回环地址。用例按“第二个接口实时引用、第一个接口实时引用、第一个接口的冻结副本、已禁用接口”排列。对照使用同一个桌面客户端执行和导出。安装介质 SHA-256 为 `4f52f43ef0402f119d1ac2f8e9c6760177768e275ef7f074cc297e05cc4b08dd`，桌面原始项目出口为 `be912df319994cda91b1054f0514ecd85964631efc371b8504911237dff4d303`。[官方下载安装入口](https://www.apipost.cn/download.html) · [8.2.7 安装介质记录](https://github.com/microsoft/winget-pkgs/blob/master/manifests/a/Apipost/ApiPost/8.2.7/Apipost.ApiPost.installer.yaml)

| 操作 | 回环服务收到的请求 |
| --- | --- |
| 首次手动执行一轮 | `/second → /first → /first` |
| 将第一个接口地址改为 `/first-new`，再手动执行两轮 | `/second → /first-new → /first`，重复两次，共 6 次，失败 0 次 |
| Workbench 导入原厂出口、执行，再导出到第二个项目重导入执行 | 两次运行分别得到相同的 6 次请求。导入和预览期间请求数为 0 |
| 8.2.7 自己重导原文件 | 外层执行次数重置为 1；实时引用和冻结副本均指向修改后的当前接口 |
| 8.2.7 导入带原生固定次数循环和独立 HTTP 步骤的回放文件，再执行 | `/second → /first-new → /first`，重复两次，失败 0 次。原厂报告记为 1 次外层执行、6 个成功请求 |
| 8.2.7 平铺用例中设置外层两轮和 800 毫秒间隔 | 连续五个到达时间差为 1008、1006、1005、1012、1002 毫秒。零间隔对照约为 200 毫秒。间隔作用于连续已启用的请求，跨轮边界也生效 |

实时步骤的缓存 `data.url` 在修改源接口后仍可保留旧地址。运行时按 `target_id` 解析当前请求。冻结步骤按 `data.apiData` 还原，后续源接口修改不会覆盖它。

手动用例导出的 `scenario` 为 `manual`，同时带有默认的五小时频率预设。原厂把定时任务列在独立页面，启用需要本地发送代理。Workbench 导入、预览、保存与重启均不注册后台任务。活动定时任务、非默认频率、测试数据集、用例间依赖、任意嵌套控制图、顺序歧义及悬空引用会在写入前报错。[原厂测试用例编辑说明](https://wiki.apipost.cn/docs/test/edit/)

## 操作入口

1. 在目标项目选择「导入」，打开 Apipost 项目 JSON，或在手动导入中预览并应用选择。进入执行计划，确认环境后运行。
2. 在「导出项目」的整项目格式中选择「Apipost JSON（保留自动化引用与副本）」，可供 Workbench 重导入，保留原始引用关系、冻结请求与两轮配置。
3. 要交回官方 8.2.7 执行，选择「Apipost 8.2.7 桌面回放」。实时引用仍随接口变化。冻结副本展开为独立 HTTP 步骤，失去回到原接口的编辑关联。外层轮数写入原生固定次数循环。该选项仅接收已验证可展开的根级副本和零逐请求间隔。

Owner 整项目出口使用 `GET /api/projects/{id}/export?format=apipost`。追加 `automationMode=desktop-replay` 可生成原厂回放定义。已授权的 MCP `export_project` 接受同名选项，`import_project` 支持相同项目 JSON。自动化支持范围限定于此处列出的结构和版本。

## 复现

`node scripts/observe-apipost-automation.mjs <单独的输出目录> [端口]` 启动仅监听回环的记录器，写出一份含三个接口的 Postman 集合。省略端口可使用随机端口，重放本机留存的原始出口使用 9009。导入原工具后按上表顺序新建手动用例，保存、执行、修改第一个接口，再执行和导出。接收器仅记录上述测试路径、HTTP 方法和到达时间。

仓库中的 [脱敏原厂出口](../tests/fixtures/apipost-cloud-827.json) 保留步骤、引用关系、运行配置和响应定义。项目标识、环境地址与监听端口已替换。回归使用临时项目和随机回环端口，并核对真实网络到达顺序、逐请求延时和两个出口的重导入。

```sh
node --test tests/apipost-cloud-automation.test.mjs tests/native-automation-boundaries.test.mjs tests/native-automation-rejection.test.mjs
```

更早的第三方静态样本只用于生成拒绝变体。缺失或冲突的排序、未知父节点、定时与沙盒变体继续测试失败后的持久化状态及零网络副作用。[历史静态分析](NATIVE-AUTOMATION-STATIC-GAPS.md)
