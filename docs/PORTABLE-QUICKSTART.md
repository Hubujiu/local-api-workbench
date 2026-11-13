# 便携候选试用：先核版本，再用独立数据目录启动

这是开发候选的操作指南，不是正式发行公告。没有安装器、自动更新或正式签名/公证保证；CI 中三平台通过不等于任意用户机器都兼容。当前完整产品缺口见 [交付矩阵](DELIVERY-STATUS.md)。

## 选择一个精确候选

不要从不同运行混用可执行文件、manifest 或证据。通过该候选 PR 的原 Actions 运行页下载对应平台 artifact；可能需要 GitHub 登录，工作流当前保留产物 7 天。过期或缺少产物就停止，不拿旧包替代新版本。

已独立核验的下载后启动基线：[#239](https://github.com/Hubujiu/local-api-workbench/pull/239)，head `3a8d9ee8e66b1744e11256396635663621f32b35`，原运行 [43466017423](https://github.com/Hubujiu/local-api-workbench/actions/runs/43466017423)，46/46 jobs。该运行三平台均实际下载、解压、启动并完成正常重启和崩溃恢复。下载后的正常及崩溃重启旅程均包含无效导入无副作用、只读核对后纠正导入的检查。验收树为 `914276d5ebc4b1a169220d1025dcb35bcb85efcd`。旧运行中的超时、上传等失败证据仍保留，不能由本轮成功倒推根因已修复。

| 平台 artifact             | 该运行 artifact ID | 完整展开后的启动入口    |
| ------------------------- | ------------------ | ----------------------- |
| LocalAPI-Windows-portable | 14057898061        | `LocalAPI/LocalAPI.exe` |
| LocalAPI-macOS-portable   | 14058157104        | `LocalAPI/LocalAPI.app` |
| LocalAPI-Linux-portable   | 14059630386        | `LocalAPI/LocalAPI`     |

该运行实际架构为 Windows x64、Linux x64、macOS arm64。架构仍必须核对该包 `LocalAPI/build-manifest.json`，不依据 artifact 名称猜测。平台名不意味着同时包含 x64 和 ARM 版本。

## 核对与展开

1. 使用新建的空目录解压外层 artifact ZIP，不覆盖现有程序或项目。Windows 包含 `LocalAPI/`。macOS/Linux 外层包含 `LocalAPI-<平台>.tar.gz` 和 manifest；保留外层结构供校验。
2. **进阶完整性检查**：从同一精确提交取得源码，安装 Python 3.12（仅此校验工具需要；运行桌面程序不需要 Node/npm/Python）。在源码根目录执行以下命令，将平台换成 `win32`、`darwin` 或 `linux`，路径换成自己的绝对路径：

   ```text
   python scripts/verify_portable_download.py "<外层ZIP解压目录>" --platform <平台> --head 3a8d9ee8e66b1744e11256396635663621f32b35
   python scripts/materialize_portable_download.py "<外层ZIP解压目录>" "<不存在的新启动目录>" --platform <平台> --head 3a8d9ee8e66b1744e11256396635663621f32b35
   ```

   若系统仅提供 `python3`，将命令中的 `python` 换成 `python3`。校验和展开期间不要修改输入目录。新启动目录的父目录必须已存在、由你控制，且各级路径不能是符号链接或 Windows reparse point。后一个命令在新启动目录中直接放置程序内容，因此入口没有额外的 `LocalAPI/` 前缀。任一校验失败就停止，不跳过、不补文件凑通过。哈希只能证明一致性，不是发布者数字签名。

3. 不使用校验工具时，macOS/Linux 仍需在独立空目录完整解开内部 tar.gz，保留符号链接和可执行权限，不能只复制 `.app` 内某个文件或执行文件。此人工路径不等于执行了上述完整校验。
4. 若系统阻止未知或未签名应用，停止并核实来源；本指南不提供关闭安全机制、移除隔离属性或绕过系统警告的命令。

## 首次试用与数据保护

便携程序不意味着数据默认写在程序旁边。默认项目位置在 Electron 的用户数据目录下 `projects`。试用前关闭正在运行的 Local API；应用有单实例保护，不要让旧实例与候选混用。

建议用新的绝对路径作为 `LOCAL_API_DESKTOP_DATA`，只在当前启动终端设置，不使用已有生产项目目录。启动入口以实际展开方式为准：

Windows PowerShell（人工展开后）：

```powershell
$env:LOCAL_API_DESKTOP_DATA = 'C:\LocalAPI-Trial-Data'
& 'C:\LocalAPI-Trial\LocalAPI\LocalAPI.exe'
```

Linux（人工展开后）：

```sh
LOCAL_API_DESKTOP_DATA="$HOME/LocalAPI-Trial-Data" "$HOME/LocalAPI-Trial/LocalAPI/LocalAPI"
```

macOS（人工展开后，直接启动包内进程使变量传递明确）：

```sh
LOCAL_API_DESKTOP_DATA="$HOME/LocalAPI-Trial-Data" "$HOME/LocalAPI-Trial/LocalAPI/LocalAPI.app/Contents/MacOS/Electron"
```

这些路径是示例，目录应由你选择且保持独立。不要删除既有数据来排除问题。项目界面另选目录会改变该项目实际位置；使用空白试用项目而非直接迁移真实数据。

## 一条可以检查的使用路径

- 新建项目，导入一份不含秘密的 OpenAPI 文档，确认请求内容后再主动执行。不要默认向生产系统发送请求。
- 编辑并保存，创建执行计划并核对执行顺序；运行结果未知时先只读核对，不重复发送。
- 导入失败后若界面提示需要核对，关闭对话框，显式重新加载项目再尝试；HTTP 400 本身不是可安全重复写入的收据。
- 查看历史，确认导出后只应产生一份原始记录文件。导出、备份、历史可能含敏感正文和凭据，不会自动脱敏。
- 正常退出后再次启动，核对保存的项目与历史。不要在自己的真实数据上人为制造崩溃；崩溃恢复证据来自隔离 CI fixture。

遇到问题记录平台、manifest 中的 head、原运行链接和错误步骤。分享日志或导出前先检查秘密。此候选不承诺原生自动化全兼容、未实现数据库 provider 或远端业务恰好一次，也不授权合并、部署或正式发行。
