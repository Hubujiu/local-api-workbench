# Windows x64 正式发行

维护者通过 Actions 的 **Prepare verified Windows release** 创建 GitHub Release 草稿。选取受保护的 main，并输入同一提交上开启回滚的 **Opt-in disposable Windows product journey** 手动运行编号。入口校验 main、同一提交的三平台 CI 及普通 Windows 用户的安装、失败回滚、升级、卸载与重装记录。[发行工作流](../.github/workflows/windows-release.yml)

工作流从验证过的 Windows 便携包生成发行介质。签名机为应用主程序和达梦原生助手签名，更新文件清单，然后编译稳定产品系列的每用户 MSI。开始菜单入口指向安装的 LocalAPI.exe。版本必须高于上一份公开发行。最终 MSI 完成发布者签名与时间戳后固定 SHA-256。

签名机使用标签 `workbench-signing` 和环境 `windows-signing`，Windows SDK 的 SignTool 从当前用户证书存储使用授权的证书。设置仓库变量 `WORKBENCH_PUBLISHER_THUMBPRINT` 与 `WORKBENCH_TIMESTAMP_URL`。标准用户验收机使用标签 `workbench-disposable-standard-user`、环境 `windows-acceptance` 和机器变量 `LOCALAPI_DISPOSABLE_RELEASE_VM=1`，在启用正常 Windows 信任策略的全新一次性系统中运行。两个专用 runner 只接受受保护的发布工作流。交互信任提示按[安装验收协议](INSTALLER-RELEASE-ACCEPTANCE.md)记录。

正式介质在标准账号安装后逐文件核对，再运行已安装程序的真实桌面重启旅程。已有公开 MSI 时先核对上一版签名、摘要、产品系列和版本，在上一版保存测试项目与执行历史后升级。每次升级、卸载与重装前后逐文件核对已保存项目，并通过 Windows Installer 的当前用户注册信息确认新旧版本的安装状态。最终卸载还检查安装目录与开始菜单入口。所有步骤成功后，`windows-release` 环境允许生成附带最终 MSI、SHA256SUMS 和 verification.json 的草稿，由维护者决定公开时间。当前公开版本见 [GitHub Releases](https://github.com/Hubujiu/local-api-workbench/releases)。

## 升级失败后恢复上一版

升级返回 1603 后先等待 Windows Installer 完成回滚，再从开始菜单打开上一版并核对项目。如果 Windows 只保留了旧版的“已通告”注册，使用原先安装的同一版 MSI。先对照该版 Release 的 SHA256SUMS 和发布者签名，再在原 Windows 账号运行以下命令，将文件名替换为旧版完整路径。

```powershell
msiexec.exe /i "C:\Downloads\LocalAPI-0.1.0-windows-x64.msi" WORKBENCHRESTORE=1 ADDLOCAL=ALL
```

安装器核对当前账号下该产品的通告状态和版本关系，使用原包恢复程序及卸载注册。验收记录会标明系统自行回滚或使用原版介质恢复，并核对恢复后的程序、项目、历史和后续卸载。
