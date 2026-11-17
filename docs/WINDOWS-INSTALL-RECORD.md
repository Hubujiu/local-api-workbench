# Windows application-only 安装记录 v1

这是首次安装器的真实元数据切片，不是卸载器或升级器。生成器在独立构建目录生成
`localapi-install-record.json`，NSIS 将它作为**最后一个文件**提取到新建的 `.pending`；
沿用逐文件不存在检查、`SetOverwrite off` 与错误捕获。它与 payload 一起经 no-replace 改名
进入固定 final。没有向已存在安装目录补写记录，没有删除、执行、注册或 profile 写入。

## 记录与信任合同

记录字节为确定性 UTF-8 JSON，包含 schema、产品/app 名、Windows x64、payload head/版本、
manifest 文件名和 SHA-256，以及固定 LOCALAPPDATA 子目录、current-user/application-only 范围。
不写入任意绝对删除路径，不包含账户秘密、主机名、profile 路径或运行时自报 SID。
`managedContent` 只描述精确 payload manifest 加记录本身；`userDataManaged` 与
`deletionAuthorized` 均为 false。payload 根层该文件名及其大小写别名/子目录命名空间被保留；
冲突在生成任何输出前拒绝，不允许 payload 冒充安装器记录。

构建回执 `build-input.json` 新增 `installRecord`、`installRecordSha256`、`installRecordBytes`。
记录不是 payload 的一部分，因此原 payload manifest 及其摘要不修改；安装器总库存增加一个文件。
验证器只有收到**独立核验构建输入中的**记录摘要才接受此额外文件，同时检查其摘要等于由预期
head/版本/manifest 和固定 schema 重新生成的记录摘要，再验证剩余完整 payload。缺失、改动、
不同产品身份、任意额外文件/目录仍拒绝；不会因为一个 marker 存在就信任或忽略整个目录。

```powershell
python scripts/verify_windows_first_install.py --local-app-data "$env:LOCALAPPDATA" --payload-head <full-head> --version <version> --manifest-sha256 <independently-pinned-manifest-sha256> --install-record-sha256 <independently-pinned-build-input-record-sha256>
if ($LASTEXITCODE -ne 0) { throw 'Installed files or install record did not verify' }
```

## 兼容性

- 历史 #258 无记录安装保持原验收命令与原回执语义；不能自动升级它，也不补写记录。
- 本切片生成的候选必须显式给 `--install-record-sha256`；省略该参数将按完整 payload 检查拒绝额外记录。
- 新模式的 `filesIncludingManifest` 包含 manifest 与记录；原 `files`/`bytes` 仍描述 payload，
  新增 `totalInstalledBytes` 包括记录，并回显记录摘要、字节数和 `deletionAuthorized: false`。
- 生命周期文件比较工具的 capture 与 installed verify 已显式透传该 pin，并有新格式/历史 #258 格式的组合测试；
  新目标仍需自己的独立 pin，不从基线自动继承。其他消费者也不得“自动忽略元数据”。

## 为后续卸载提供什么，尚缺什么

它提供可独立核实的**文件集合与安装布局合同**，让未来卸载器有条件拒绝错误版本、陌生目录、
缺失/改写记录或文件混入。但可复制的记录不是用户/机器绑定的所有权证明，也不是安装完成证书：
手工复制同一完整包也可通过。`current-user` 只声明固定安装范围，不认证实际 token/SID。
摘要不是可信发布者签名；输入 pin 的来源必须独立核验。记录甚至可能留在中断的 pending，
所以必须连同固定路径、pending 缺失和整个 payload 验收，不能仅检查 marker。

**后续仍不得直接根据记录删除**。实际卸载至少需要独立授权的安装身份/可信介质、真实用户与路径绑定、
运行进程/文件使用状态、句柄级路径与重解析竞争防护、精确 app-only 文件清单及额外内容拒绝策略，
并在原生 Windows 验证取消/部分失败/保留 profile/重装等流程。当前 NSIS 没有这些完整合同；
本切片不宣称支持并发攻击防护、签名、升级、回滚、卸载或新的原生验收。

## 检查

`python -m unittest discover -s tests -p 'test_portable_*.py' -v`

自动测试覆盖生成/源码顺序、记录 pin、保留命名空间、完整库存拒绝和旧格式兼容；
可另以已独立核实的 NSIS 3.12-1 工具链对合成 fixture 编译 `-NOCONFIG -WX`。
Linux 交叉编译不是 Windows 执行证据，测试不会执行生成的 EXE。
