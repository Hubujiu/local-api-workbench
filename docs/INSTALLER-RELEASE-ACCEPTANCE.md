# 安装发行的清洁机器验收协议（尚未执行）

基线 #252 tree `06193d50bf99db21129e617a822fce2285e84c5a`。
当前只有 CI 便携包，没有安装器、升级器或 GitHub Release 发布流程。
`scripts/build-manifest.mjs` 记录文件摘要和构建身份，不记录可信签名或安装验收；
macOS 构建中的 `codesign --sign -` 是 ad-hoc，不能称为 Developer ID 签名或公证。
本协议不创建占位安装器、不签名、不上传、不接受条款、不更改安全设置。

## 先冻结真正要交付的安装介质

每个平台/架构、每种包格式独立验收。便携 ZIP 的成功不能继承给 MSI/EXE、PKG/DMG、DEB/RPM。
记录最终签名/公证/装订完成后的**最终分发文件** SHA-256；签名前的摘要不能作为用户下载摘要。
若任何字节改变，重新计算并重新验收。既有包内 manifest 与外层摘要分别记录。

仅使用合法授权的临时 VM/干净机器，标准用户、无开发依赖、没有旧 Workbench 或预置项目。
VM OS 版本、补丁、架构、网络/信任条件必须明确；不得以关闭 SmartScreen/Gatekeeper、移除隔离属性、
导入自签根证书或强制安装来换取通过。必要账号/证书/新许可另行授权，不写入证据包。

## 平台可信度检查：保留真实 OS 输出

- Windows：对最终安装器及关键已安装可执行文件分别运行已安装 SDK 的
  `signtool verify /pa /all /v "<file>"`，记录完整输出与退出码，检查预期发布者、链和时间戳。
  真实标准用户启动时另记录 SmartScreen/UAC 的发布者及结果；签名验证成功不等于没有信誉警告。
  参数含义见 [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)。
- macOS：独立记录应用签名验证、预期 Developer ID 身份、对应发行文件的公证结果与装订验证。
  对适用的 `.app`/`.pkg`/`.dmg` 使用其相应 OS 验证流程，不把某个内层 app 的结果套给外层安装器。
  在保留正常下载隔离属性的干净机器上验证 Gatekeeper 和首次启动；若宣称离线首次安装，另在断网
  测试条件下验证装订票据可用。参考 [Apple 公证流程](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)。
  本协议不提供提交公证/签名命令，不需要测试者持有私钥。
- Linux：先明确发行版、版本、架构、包格式和分发渠道；按该渠道验证包或仓库签名及受信发布者，
  保存验证工具版本、完整输出、退出码和信任来源。DEB/RPM/独立归档的签名机制不能互相替代。
  摘要一致不等于签名可信；尚未选定安装格式和信任渠道时，该项保持“未决定/未验”。

验证失败或工具/证据缺失就停止，不提供 bypass。真实原生对话框的人工点击需独立记录；
CI 中适配 dialog 返回值的测试不能替代这个步骤。

## 三条必须分开执行的使用旅程

### A. 清洁安装与首次运行

1. 从可追溯候选源下载最终介质，复算外层摘要并完成上述 OS 验证。
2. 按安装器正常 UI 安装，记录选择的用户/机器范围、安装路径、权限提示及每个选项。
   未请求的自启动、遥测、关联、服务或网络访问不得默认为接受。
3. 在无 Node/npm/Python 的标准用户会话启动。核对版本/head/架构和实际数据路径。
4. 使用独立合成数据：创建项目、loopback 请求、保存、计划和历史、导出、正常退出再启动。
   记录原始结果与持久化数据摘要，不使用生产接口或真实凭据。
5. 验证快捷入口、桌面文件/应用菜单和卸载入口确实指向本次安装；记录非预期外部网络行为。

### B. 从明确旧版本升级

1. 在另一干净快照安装指定旧介质，保存其签名、摘要及版本证据。旧版本不可用时标“未验”，不猜。
2. 建立含项目、环境、计划、历史及未保存草稿的合成数据，逐项记录预期保留边界；单独备份已保存数据。
3. 运行最终新安装器的正常升级流程。对“应用仍在运行”“用户取消”分别执行隔离场景；不得强杀真实工作。
4. 验证安装身份未复制出不可解释的第二实例，数据路径与所有已保存字段保留、无业务请求重放。
   升级前草稿不能静默丢弃；若设计要求先保存或退出，应有可验证阻止/提示。
5. 校验新版本实际启动并可读取旧数据。降级/回滚仅在产品明确支持且另有数据兼容证据时测试；
   不以备份存在宣称自动回滚成立，也不在原数据上试探性降级。

### C. 卸载与重装

1. 使用产品正式卸载入口，默认卸载程序应保留用户数据；先记录数据目录及字节摘要。
2. 验证程序、注册入口、快捷方式及本产品创建的后台组件按合同移除，不影响其他应用或相邻目录。
3. 若以后提供“删除数据”，必须独立、明确、默认不勾选，仅在这次已授权的合成目录测试；
   未获确认就不执行。不要以通配符清理或删整个用户目录补救失败。
4. 同介质重装，验证保留数据可恢复、无网络业务重放。记录不能卸载、残留及权限失败，不能只记成功屏幕。

## 每次验收的证据回执模板

以下是待填写记录，不是自我声明的签名证书或可供自动放行的 attestation。缺字段、缺原始输出或
缺独立复核均保持未验；不能把 `signed: true` 之类自报值当作验证。

```yaml
candidate:
  source_repository: Hubujiu/local-api-workbench
  head: REQUIRED_FULL_SHA
  tree: REQUIRED_FULL_SHA
  build_run_and_attempt: REQUIRED
  installer_format: REQUIRED_NOT_PORTABLE_SUBSTITUTE
  final_download_source: REQUIRED_EXACT_ASSET_OR_ARTIFACT_URL
  final_filename_and_bytes: REQUIRED
  final_sha256: REQUIRED_RECOMPUTED_AFTER_FINAL_SIGNING
  embedded_manifest_sha256: REQUIRED_OR_EXPLICIT_ABSENCE
machine:
  os_build_patches_arch: REQUIRED
  clean_snapshot_identity: REQUIRED
  standard_user_and_install_scope: REQUIRED
  network_and_trust_conditions: REQUIRED
verification:
  tool_versions_and_commands: REQUIRED
  raw_outputs_exit_codes_and_sha256: REQUIRED
  expected_publisher_and_observed_identity: REQUIRED
  notarization_stapling_or_platform_signature_evidence: REQUIRED_PER_PLATFORM
journeys:
  clean_install: NOT_RUN
  upgrade_from_exact_old_digest: NOT_RUN
  cancel_running_app_and_draft_behavior: NOT_RUN
  uninstall_default_data_retention: NOT_RUN
  explicit_test_data_removal: NOT_RUN_OR_NOT_SUPPORTED
  reinstall_retained_data: NOT_RUN
  raw_logs_screenshots_and_data_snapshot_hashes: REQUIRED
review:
  independent_reviewer_and_date: REQUIRED
  unresolved_failures_and_scope_limits: REQUIRED
  publication_authorization: SEPARATE_NOT_GRANTED_BY_THIS_RECORD
```

只分享合成数据证据；检查日志中的账号路径和秘密后再外传。私钥、密码、授权 token 不属于回执内容。

## 当前判定

当前三平台可提供的证据是便携包验证，不能填成安装旅程通过。安装格式、签名身份/公证和干净机器
升级卸载证据仍缺失；没有发行批准。以后选定实际安装实现后，按此协议新增相应测试，而不是编造空壳
安装器或总是失败但不检查真实证据的“预检”命令。
