# Windows x64 正式发行

维护者通过 Actions 的 **Prepare verified Windows release** 创建 GitHub Release 草稿。选取受保护的 main，并输入同一提交上开启回滚的 **Opt-in disposable Windows product journey** 手动运行编号。入口校验 main、同一提交的三平台 CI 及普通 Windows 用户的安装、失败回滚、升级、卸载与重装记录。[发行工作流](../.github/workflows/windows-release.yml)

工作流从验证过的 Windows 便携包生成发行介质。签名机为应用主程序和达梦原生助手签名，更新文件清单，然后编译稳定产品系列的每用户 MSI。开始菜单入口指向安装的 LocalAPI.exe。版本必须高于上一份公开发行。最终 MSI 完成发布者签名与时间戳后固定 SHA-256。

签名机使用标签 `workbench-signing` 和环境 `windows-signing`，Windows SDK 的 SignTool 从当前用户证书存储使用授权的证书。设置仓库变量 `WORKBENCH_PUBLISHER_THUMBPRINT` 与 `WORKBENCH_TIMESTAMP_URL`。标准用户验收机使用标签 `workbench-disposable-standard-user`、环境 `windows-acceptance` 和机器变量 `LOCALAPI_DISPOSABLE_RELEASE_VM=1`，在启用正常 Windows 信任策略的全新一次性系统中运行。两个专用 runner 只接受受保护的发布工作流。交互信任提示按[安装验收协议](INSTALLER-RELEASE-ACCEPTANCE.md)记录。

正式介质在标准账号安装后逐文件核对，再运行已安装程序的真实桌面重启旅程。已有公开 MSI 时先核对上一版签名和摘要，再用新版升级。卸载、重装和最终卸载都检查安装目录与快捷方式。所有步骤成功后，`windows-release` 环境允许生成附带最终 MSI 和 SHA256SUMS 的草稿，由维护者决定公开时间。当前公开版本见 [GitHub Releases](https://github.com/Hubujiu/local-api-workbench/releases)。
