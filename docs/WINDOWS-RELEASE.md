# Windows x64 正式发行

维护者通过 Actions 的 **Prepare verified Windows release** 创建 GitHub Release 草稿。选取受保护的 main，并输入同一提交上开启回滚的 **Opt-in disposable Windows product journey** 手动运行编号。入口校验 main、同一提交的三平台 CI 及普通 Windows 用户的安装、失败回滚、升级、卸载与重装记录。[发行工作流](../.github/workflows/windows-release.yml)

工作流从验证过的 Windows 便携包生成发行介质。签名机为应用主程序和达梦原生助手签名，更新文件清单，然后编译稳定产品系列的每用户 MSI。开始菜单入口指向安装的 LocalAPI.exe。版本必须高于上一份公开发行。最终 MSI 完成发布者签名与时间戳后固定 SHA-256。

签名机使用标签 `workbench-signing` 和环境 `windows-signing`，Windows SDK 的 SignTool 从当前用户证书存储使用授权的证书。设置仓库变量 `WORKBENCH_PUBLISHER_THUMBPRINT` 与 `WORKBENCH_TIMESTAMP_URL`。标准用户验收机使用标签 `workbench-disposable-standard-user`、环境 `windows-acceptance` 和机器变量 `LOCALAPI_DISPOSABLE_RELEASE_VM=1`，在启用正常 Windows 信任策略的全新一次性系统中运行。两个专用 runner 只接受受保护的发布工作流。交互信任提示按[安装验收协议](INSTALLER-RELEASE-ACCEPTANCE.md)记录。

正式介质在标准账号安装后逐文件核对，再运行已安装程序的真实桌面重启旅程。已有公开 MSI 时先核对上一版签名、摘要、产品系列和版本，在上一版保存测试项目与执行历史后升级。每次升级、卸载与重装前后逐文件核对已保存项目，并通过 Windows Installer 的当前用户注册信息确认新旧版本的安装状态。最终卸载还检查安装目录与开始菜单入口。所有步骤成功后，`windows-release` 环境允许生成附带最终 MSI、SHA256SUMS 和 verification.json 的草稿，由维护者决定公开时间。当前公开版本见 [GitHub Releases](https://github.com/Hubujiu/local-api-workbench/releases)。

## 升级失败后恢复上一版

升级返回 1603 后先等待 Windows Installer 完成回滚，再从开始菜单打开上一版并核对项目。如果 Windows 只保留了旧版的“已通告”注册，从该版 Release 取回原 MSI 和 verification.json，核对 SHA256SUMS。关闭 Workbench，在原 Windows 账号以普通权限打开 PowerShell 7，从相同版本的源码目录运行恢复工具。

```powershell
.\scripts\recover_windows_release.ps1 -Media "C:\Downloads\LocalAPI-0.1.0-windows-x64.msi" -Verification "C:\Downloads\verification.json"
```

恢复工具核对发布者、时间戳、安装包摘要、旧版程序清单，以及当前账号的产品注册。它先将程序目录整体保存在同一磁盘的 `LocalAPI-R-…` 目录，再通过 Windows Installer 注销旧通告并从原 MSI 全新安装。人工放入程序目录的文件可在输出的保留目录中取回。项目和历史位于独立的数据目录，验收会逐文件核对。

## Publisher rollover during signed acceptance

New MSI and installed binaries remain pinned to `WORKBENCH_PUBLISHER_THUMBPRINT`.
The predecessor is the exact latest official non-prerelease version, with its MSI
and `verification.json` independently SHA-256 checked against their GitHub asset
metadata. Receipt size is bounded before parsing. Receipt version, MSI hash and
source commit must match that release and the resolved `commits/tags/vX.Y.Z` ref,
not a possibly moving `target_commitish` branch. This commit API resolves the tag
to its commit for both lightweight and annotated tags.

By default the predecessor must have the same pinned publisher. A deliberate
certificate rollover requires an independently authorized, single-entry
`WORKBENCH_PUBLISHER_ROTATION` environment configuration (not a receipt field):

```json
{"schema":"localapi-publisher-rotation-v1","previousVersion":"0.1.0","previousPublisher":"<40 hex old thumbprint>","currentPublisher":"<40 hex current thumbprint>"}
```

All four fields must match exactly (thumbprints case-insensitively), with no extra
fields. This is not a generic certificate allowlist. A downloaded receipt cannot
introduce trusted publishers. The verifier still requires trusted, timestamped
Authenticode and signtool verification; explicit publisher override is forbidden
for signing. No certificate, trust store, environment setting or permission is
changed by the code. Final verification retains the predecessor hash/publisher
pins and whether the matching rollover authorization was used.

This change does not modify the separate recovery command or authorize its use.
Audit limitation: that older command derives publisher trust from its supplied
local verification receipt; do not treat an unverified local receipt as independent
publisher authorization. Recovery hardening needs a separate reviewed change.
Portable mocks do not constitute native signed upgrade or certificate-rollover
acceptance; no actual signing, release or Windows installation was run for this slice.

Parsing rejects top-level arrays (including one-element arrays), scalar coercion,
array-valued string fields, and unrecognized schemas. Official predecessor receipts
must identify `localapi-signed-windows-release-acceptance-v1` or `-v2` and contain
literal boolean `signedLifecyclePassed: true`; older schema-less receipts fail
closed rather than silently gaining authority. Partial predecessor argument sets
are rejected even when no media path was supplied. Draft verification requires
predecessor evidence exactly when an upgrade was performed, with older version,
complete pins and a rollover flag consistent with the two publishers.
