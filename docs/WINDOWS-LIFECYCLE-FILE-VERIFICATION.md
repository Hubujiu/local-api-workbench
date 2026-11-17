# Windows 生命周期文件证据：只读比较，不是卸载器

`verify_windows_lifecycle.py` 将首次安装文件验收扩展为可执行的生命周期文件门禁：
先核对已安装应用的独立 pinned payload 身份，再记录**合成** profile 与邻近哨兵目录；
操作后比较应用状态与数据字节/目录集合。程序不安装、删除、移动、执行或终止应用，不改 NSIS。
已有 #258 安装器仍不支持升级、回滚和卸载；不能为通过本工具而手工删除真实安装目录，
也不能将测试 fixture 的删除当作产品卸载实现。本工具可在未来获准的隔离生命周期测试中复用。

## 先决条件与身份

仅用于受控静止、无其他写入方的临时账户。先退出应用和相关测试进程；本工具不检查进程。
记录真实账户 LOCALAPPDATA 与应用实际 profile 路径；不能猜测 profile 名称，不能扫描真实用户资料。
profile 和一个独立相邻哨兵目录应先写入不含秘密的合成文件；每个保护目录至少有一个文件。
可重复 `--protect`，最多 8 个；必须与固定 app/pending 及其他保护目录分离，先拒绝链接/reparse 祖先，再规范化现有目录，包含大小写及系统展开的短路径别名检查。
默认数据目录不是应用安装目录。保护集只覆盖显式指定目录，遗漏目录不能算保留证据。

从独立核验的构建输入取得 payload head、版本、manifest 摘要，不能从安装后的 manifest 自行推导。
这是安装文件身份，不是可信发布者/签名或可供删除的所有权证明。基线 JSON 由 capture 的 stdout 保存；
证据文件必须放在保护目录之外，以免日志本身改变快照。保存基线 SHA-256 到独立测试记录，后续不能重新
以被更改的基线计算期望值。基线含路径与内容摘要，勿上传真实 profile 信息。

```powershell
# $profile、$sentinel、$evidence 均为本次隔离测试确认的绝对路径。
# 用 PowerShell 的 UTF-8（无 BOM）写入；先检查退出码，不保存失败输出。
$baseline = python scripts/verify_windows_lifecycle.py capture --local-app-data "$env:LOCALAPPDATA" --protect "$profile" --protect "$sentinel" --payload-head <old-full-head> --version <old-version> --manifest-sha256 <old-pinned-manifest-sha256> --install-record-sha256 <old-pinned-install-record-sha256>
if ($LASTEXITCODE -ne 0) { throw 'Baseline capture failed' }
[IO.File]::WriteAllText($evidence, ($baseline -join "`n"), [Text.UTF8Encoding]::new($false))
Get-FileHash -LiteralPath $evidence -Algorithm SHA256
```

新记录格式 capture 须使用独立 `--install-record-sha256`；历史 #258 无记录格式省略该参数。
基线保存其已验收记录摘要；它不授权后续目标自动复用此 pin。

在**另行获准且实际实现的**卸载流程执行后：

```powershell
python scripts/verify_windows_lifecycle.py verify --local-app-data "$env:LOCALAPPDATA" --protect "$profile" --protect "$sentinel" --baseline "$evidence" --baseline-sha256 <independently-recorded-baseline-sha256> --state uninstalled
if ($LASTEXITCODE -ne 0) { throw 'Uninstall file comparison failed' }
```

`uninstalled` 要求固定 `LocalAPI-FirstInstall-Candidate` 与同级 `.pending` 完全不存在；
普通文件、空目录、悬空链接或不可读取状态都不能通过。保护目录的文件摘要、总字节、空目录集合须完全一致。
重装、升级或回滚后的**文件状态**使用 `--state installed`，并追加该次目标 payload 的独立
`--payload-head`、`--version`、`--manifest-sha256`，新记录格式还须追加该目标独立的
`--install-record-sha256`，对完整安装清单重新验收。uninstalled 不接受 payload 或记录 pin；
它只核固定路径缺失和保护数据不变。对回滚指定原 payload 身份。
升级前后有合法数据迁移的情况会被本工具严格拒绝；不能降低字节保留规则掩盖变化，应另写迁移语义验收。

## 拒绝与证据边界

- 任何缺失/新增/修改的保护文件、额外/丢失空目录、链接/reparse、不可遍历目录都失败。
- 基线摘要、schema、账户路径或保护范围不同就失败；安装状态必须有独立目标身份。
- 使用现有 inventory 限额（每树 100,000 entries / 4 GiB、基线 JSON 32 MiB），流式哈希；
  大型或活动真实 profile 不属于本合成验收用途。
- stdout 仅成功时输出一份 JSON；失败非零、无成功回执。回执始终标记
  `operationExecuted: false`、`nativeLifecycleVerified: false`、`signatureVerified: false`。
- 只能证明读取时的普通文件内容与目录集合，不证明卸载入口实际执行、注册表/快捷方式已移除、
  无遗留后台进程、ACL/ADS/时间戳等元数据保持、无恶意并发替换、运行成功或数据迁移正确。
- capture 后、verify 前必须另行保留真实操作日志、OS/账户身份、介质身份和流程结果。
  同一文件状态也可由人工操作产生，文件比较不能将其认证为原生生命周期成功。

## 本地测试与 CI

`python -m unittest discover -s tests -p 'test_portable_windows_lifecycle.py' -v`
执行真实临时文件树、CLI 和合成状态切换，包括卸载后缺失检查、同版本重装、下一 payload 身份、
坏基线、错误范围、部分安装、保留数据变化、链接、遍历错误与限额。
现有 CI 的 `test_portable_*.py` 自动收集此测试；Linux 通过不能替代真实 Windows/NTFS 执行。
