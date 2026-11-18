# 便携候选试用：先核版本，再用独立数据目录启动

本指南适用于开发候选的便携 ZIP，下载后手动校验和解压。每用户 MSI 的升级、卸载、回滚和签名流程见 [Windows 安装与发行](WINDOWS-RELEASE.md)。各平台与版本的实测范围见[交付矩阵](DELIVERY-STATUS.md)。

## 下载当前 main 的便携包

打开 main 的最新提交，记下完整 SHA，再打开同一提交的成功构建。该运行的 Artifacts 区提供三个便携包，下载时 GitHub 可能要求登录。[main 最新提交](https://github.com/Hubujiu/local-api-workbench/commits/main/) · [main 构建记录](https://github.com/Hubujiu/local-api-workbench/actions/workflows/ci.yml?query=branch%3Amain)

| 平台 | 下载项 | 完整展开后的入口 |
| --- | --- | --- |
| Windows x64 | `LocalAPI-Windows-portable` | `LocalAPI/LocalAPI.exe` |
| macOS arm64 | `LocalAPI-macOS-portable` | `LocalAPI/LocalAPI.app` |
| Linux x64 | `LocalAPI-Linux-portable` | `LocalAPI/LocalAPI` |

在源码目录运行 `node scripts/delivery-index.mjs` 可直接取得三个下载链接。保存此次输出，后面的校验都使用其中同一个 `head`。索引同时给出源码树、成功的构建编号、各平台外层 ZIP 的 SHA-256 和到期时间。主线正在构建或包已过期时，命令会报告原因。[验收索引](DELIVERY-STATUS.md)

CI 的协议草稿关闭旅程通过真实 Electron 关闭事件和取消结果验证，但 OS 对话框响应由测试适配；不代表人工点击原生安全警告/系统模态已验。便携包仍非安装器，无正式签名/公证保证，完整产品未交付。

## 核对与展开

在 Windows PowerShell 中可把索引保留在当前会话，然后核对实际下载的文件。将示例路径换成自己的 ZIP 路径。

```powershell
$index = node scripts/delivery-index.mjs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $index.head) { throw '未取得主线索引' }
$windows = $index.downloads | Where-Object platform -eq 'Windows'
$windows.url
# 下载这个链接中的 ZIP 后继续
$actual = (Get-FileHash -Algorithm SHA256 'C:\Downloads\LocalAPI-Windows-portable.zip').Hash
if ($actual -ine $windows.sha256) { throw 'ZIP 的 SHA-256 与索引不符' }
```

macOS 可用 `shasum -a 256`，Linux 可用 `sha256sum`，将结果与索引中对应平台的 `sha256` 比对。一致后再核对包内清单。

1. 使用新建的空目录解压外层 artifact ZIP，不覆盖现有程序或项目。Windows 包含 `LocalAPI/`。macOS/Linux 外层包含 `LocalAPI-<平台>.tar.gz` 和 manifest；保留外层结构供校验。
2. **进阶完整性检查**：从同一精确提交取得源码，安装 Python 3.12（仅此校验工具需要；运行桌面程序不需要 Node/npm/Python）。在源码根目录执行以下命令，将平台换成 `win32`、`darwin` 或 `linux`，路径换成自己的绝对路径：

   ```text
   python scripts/verify_portable_download.py "<外层ZIP解压目录>" --platform <平台> --head <本次索引的完整head>
   python scripts/materialize_portable_download.py "<外层ZIP解压目录>" "<不存在的新启动目录>" --platform <平台> --head <本次索引的完整head>
   ```

   在上面的 PowerShell 会话中，`--head` 可直接传 `$index.head`。若系统仅提供 `python3`，将命令中的 `python` 换成 `python3`。校验和展开期间保持输入目录不变。新启动目录的父目录须已存在、由你控制，各级路径须为实际目录。展开工具将程序直接放在新启动目录中，入口省去上表的 `LocalAPI/` 前缀。任一校验失败就停止。

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
