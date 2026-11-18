# 便携候选试用：先核版本，再用独立数据目录启动

本指南适用于开发候选的便携 ZIP，下载后手动校验和解压。每用户 MSI 的升级、卸载、回滚和签名流程见 [Windows 安装与发行](WINDOWS-RELEASE.md)。各平台与版本的实测范围见[交付矩阵](DELIVERY-STATUS.md)。

## 查询当前 main

运行 `node scripts/delivery-index.mjs` 可获取 GitHub 上当前 main 的精确提交、源码树、成功的 CI 运行、三个下载地址、到期时间和 SHA-256。产物过期或 main 尚在构建时，命令会报告具体原因。[Windows 正式发行入口](WINDOWS-RELEASE.md)

## 选择一个精确候选

不要从不同运行混用可执行文件、manifest 或证据。通过 `main` 的原 Actions 运行下载对应平台 artifact；可能需要 GitHub 登录。过期或缺少产物就停止，不拿旧包替代这一基线。

当前试用基线：`main` 整合提交 `f59b11ac3dc96c567db155dd871ef08ba445937c`，tree `4869acc4fc433b16b1d6b62750c310884c6f2f96`，[原运行 44130790449](https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449) 47/47 jobs 成功。该运行的三平台下载验证与重启 jobs 均通过。这是开发候选，不是 release。

| 平台与便携包下载                                                                                             | 到期（UTC）          | 完整展开后的入口        |
| ------------------------------------------------------------------------------------------------------------ | -------------------- | ----------------------- |
| [Windows x64](https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449/artifacts/14350955078) | 2026-11-24T16:56:47Z | `LocalAPI/LocalAPI.exe` |
| [macOS arm64](https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449/artifacts/14348309920) | 2026-11-24T16:56:25Z | `LocalAPI/LocalAPI.app` |
| [Linux x64](https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449/artifacts/14349842125)   | 2026-11-24T16:54:50Z | `LocalAPI/LocalAPI`     |

不要误下 metadata 或验证日志包。架构以包内 `LocalAPI/build-manifest.json` 为准。以下为 GitHub 公布的外层 artifact ZIP SHA-256，不是内部压缩包或可执行文件的摘要，也不是发布者签名。本次更新未重新下载这三个 ZIP 计算字节摘要。

- `LocalAPI-Linux-portable`：`sha256:1f60da065d87e9617c2fd2355ee4a69ba28d71187ac1dc2c5b6e6517624b30f0`
- `LocalAPI-Windows-portable`：`sha256:380da9823403679ff7ead1a24a62f38f4526bc0046e4b0bc73c3326ca829b1bb`
- `LocalAPI-macOS-portable`：`sha256:252ae1fcde6176be4bfb9a518ee86c751be6b84af53f5da87d9ee0d2271df2b0`

旧候选请查[历史验收记录](DELIVERY-STATUS.md)，不作为当前下载。

CI 的协议草稿关闭旅程通过真实 Electron 关闭事件和取消结果验证，但 OS 对话框响应由测试适配；不代表人工点击原生安全警告/系统模态已验。便携包仍非安装器，无正式签名/公证保证，完整产品未交付。

## 核对与展开

Windows 可先核对下载 ZIP（路径换成实际文件）：

```powershell
Get-FileHash -Algorithm SHA256 'C:\Downloads\LocalAPI-Windows-portable.zip'
```

输出 Hash 应与上方 Windows SHA-256 完全一致（忽略大小写，不含 `sha256:` 前缀）。不一致就停止。此步骤只核外层 ZIP，不替代以下包内 manifest 校验。

1. 使用新建的空目录解压外层 artifact ZIP，不覆盖现有程序或项目。Windows 包含 `LocalAPI/`。macOS/Linux 外层包含 `LocalAPI-<平台>.tar.gz` 和 manifest；保留外层结构供校验。
2. **进阶完整性检查**：从同一精确提交取得源码，安装 Python 3.12（仅此校验工具需要；运行桌面程序不需要 Node/npm/Python）。在源码根目录执行以下命令，将平台换成 `win32`、`darwin` 或 `linux`，路径换成自己的绝对路径：

   ```text
   python scripts/verify_portable_download.py "<外层ZIP解压目录>" --platform <平台> --head f59b11ac3dc96c567db155dd871ef08ba445937c
   python scripts/materialize_portable_download.py "<外层ZIP解压目录>" "<不存在的新启动目录>" --platform <平台> --head f59b11ac3dc96c567db155dd871ef08ba445937c
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
