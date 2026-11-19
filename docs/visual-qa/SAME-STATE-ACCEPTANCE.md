# Workbench / Apipost 单机同态像素验收

## 当前核对根与真实状态

本工具在 main `d89cc05ca368a157c169615731c587f40d6bafba` 上准备，不改产品样式。
此文档是可重跑验收方案和覆盖清单，**不是已完成截图审计**。缺少任何一侧本轮截图、同态元数据或人工/模型看图确认，结果必须为 blocked，不能用旧图、官网宣传图或帮助文档补齐。

在本轮 QA shell 中，普通及批准升级后的 Chromium 启动均遇到 UNIX socket `Operation not permitted`，未获得此路径新截图；这不等于云 GUI 不可用。主线程另在云 GUI 拍摄官方 Apipost 2.0.1，不能抢占桌面焦点。若采用 GUI 截图，应记录实际内容区域和显示缩放，不能把整个桌面的尺寸当网页 viewport。

## 最小同态覆盖（每项浅色/深色，共14对）

| ID | 页面与应固定状态 | Workbench 已有入口/脚本依据 | 同态验收要求 |
|---|---|---|---|
| 01 | HTTP编辑，raw JSON正文，响应为空 | ui-smoke `#request-name/#url/#body-code`；配套HTTP baseline helper | 相同项目名、树展开、标签、请求名、方法、URL、参数页、JSON、未发送状态；无弹窗 |
| 02 | HTTP响应JSON | ui-smoke 响应相关截图及 `.response-body` | 相同成功状态、响应body/header、所选响应页、滚动/布局；耗时等动态值必须记录，不能悄悄遮蔽 |
| 03 | 项目基本设置 | settings `settings-basic`、`#project-select` | 同一虚构名称/描述和已保存状态；原厂若是弹窗而非整页，应记录差异，不硬配 |
| 04 | 环境变量编辑 | `settings-environments`、`[data-edit-env]` | 相同环境、变量行、初始/当前值、展开状态；禁止真实secret |
| 05 | 用例列表/选中用例 | ui-smoke cases及case-groups截图 | 相同API、用例名、分组、选择、空运行结果；不得拿自动化计划替代接口用例 |
| 06 | 数据库连接配置 | helpers/mcp-database-ui；ui-smoke数据库操作截图 | 先核对原厂入口：连接配置、SQL步骤、MCP授权不是同一状态。只配实际等价状态，否则blocked |
| 07 | MCP未开启概览 | `settings-mcp`、`#mcp-live-summary` | 两侧禁用、无授权、配置未揭示。Workbench专有权限区不得默认为原厂已有；结构不同如实报告 |

`tests/ui-smoke.mjs` 已有大量成功路径截图，但它是功能流程，不是严格视觉回归器。当前原light截图在约598行，dark参考截图在约1265行，经过不同操作且viewport可能不同，**不能直接组成像素对**。其它可复用脚本有 `gui-restart-journey.mjs`、`desktop-smoke.mjs`、`desktop-restart-journey.mjs`、`sqlserver-owner-ui.mjs`。这些只证明自己的运行/截图流程，不是原厂匹配度。

## 捕获合同

1. 每轮使用独立临时项目、虚构本机URL和确定性fixture；不得读取或截图用户真实数据。
2. 记录 Workbench 精确commit/dirty patch身份、Apipost版本、时间、平台、系统字体、浏览器/Electron版本。不得修改产品CSS来隐藏差异后称原始界面通过。
3. 固定内容viewport和DPR/OS缩放、locale、主题、浏览器zoom、滚动、侧栏/分隔线、选择与响应状态。1328×875只是HTTP helper候选值，须以本轮原厂内容框可复现尺寸为准。
4. 等待字体加载、双帧布局稳定，关闭光标/选择高亮等临时焦点状态；不得注入替换样式或伪造响应。动态网络耗时若不同，保留差异并注明。
5. 每张原PNG须实际查看，确认非loading、空白、错误页、错误窗口、错误状态。只有确认后才填 `inspected:true`。文件存在不是看图确认。
6. 若底部有序列号/机器信息，先明确记录内容框 `contentCrop:[left,top,right,bottom]`。工具只输出裁剪图，不复制完整原图。被裁掉部分不在验收范围，不能声称整窗一致；不允许自动对齐、拉伸或遮盖UI差异。
7. `fixtureDigest` 由两侧一致的公开fixture契约JSON算SHA256，不能为了通过手工填写相同hash。HTTP baseline helper目前只hash name/url/body，还需确认method、header、选择和未发送状态才能作跨产品对应。

## 产物格式与运行

复制 `pairs-template.json` 到本轮证据目录，逐对填入两侧证据；未拍页面保持null。
每侧结构：

```json
{
  "product": "Apipost standalone",
  "version": "2.0.1",
  "capturedAt": "2026-11-19T00:00:00Z",
  "file": "01-reference-light.png",
  "inspected": true,
  "contentCrop": [0, 0, 1328, 875],
  "state": {
    "page": "http-editor",
    "theme": "light",
    "fixtureDigest": "替换为真实64位小写SHA256",
    "viewport": [1328, 875],
    "deviceScaleFactor": 1,
    "locale": "zh-CN",
    "zoom": 1,
    "scroll": [0, 0],
    "selection": "raw-json",
    "responseState": "empty"
  }
}
```

Workbench侧使用不同product和精确commit version。两侧state必须相等，截图尺寸必须相等。crop可省略，工具不猜裁剪框。
配套HTTP helper manifest里的 `captures[].file/theme/metrics.deviceScaleFactor`、`implementationCommit`、`capturedAt`、`fixtureDigest` 可映射到上述字段；`reference:null`必须继续保留，直到原厂同态证据到齐。

运行（Python 3 + Pillow；不自动下载依赖）：

```sh
python3 scripts/compare-visual-states.py /path/to/pairs.json /path/to/new-report-directory
python3 -m unittest discover -s tests -p test_visual_state_comparison.py -v
```

输出只写新目录：`report.json`、`report.html`，每对的裁剪reference/workbench、50% overlay、变化像素heatmap。原图SHA256、原尺寸、crop、比较尺寸保留在JSON里。HTML无远端资源。

退出码：0全部exact；1至少一对different且无blocked；2任何blocked/配置错误。**exact要求每个RGBA通道完全一致，1级颜色差也算不一致**。报告提供changedPixels/changedFraction、平均绝对通道误差、最大通道差、变化包围框。不提供虚假“整体相似度通过”阈值，也不把视觉相同当作功能、键盘或无障碍验收。
