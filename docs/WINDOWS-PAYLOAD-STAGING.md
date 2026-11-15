# Windows 安装工程前置：独立 payload staging

基线 #253 head `a2a084904694442cf2a736a90d7086ba24610538`、tree
`1e2277b14a8560dac3a1508ab72eac4d59fc4d95`。这是打包工程的局部工具，**不是安装器**。
不改变现有便携构建/上传链，不创建快捷方式、注册表、卸载入口或服务，不执行包内代码。

## 输入与执行

先从已核验的精确运行获取 Windows artifact，核外层 ZIP 摘要，并安全解压至独立目录。
该目录应直接包含 `LocalAPI/`，与 [便携指南](PORTABLE-QUICKSTART.md) 一致。
使用 Python 3.12；已有依赖仅为标准库和本仓库的校验/materialize 工具。

```text
python scripts/stage_windows_payload.py "<已解压artifact目录>" "<不存在的新staging目录>" --head <完整已核head> --expected-version 0.1.0 --arch x64
```

明确选择实际 version/arch，不从包名猜。arch 检查只比对 manifest 元数据，不解析 PE 机器类型，不能据此证明可执行文件的实际 CPU 架构。目标父目录必须存在且由操作者控制；输入必须静止，
不允许其他进程同时改输入/输出。目标不得是整个输入目录的祖先或后代，也不得覆盖现有路径。
路径检查不保证抵御恶意并发写入者；失败后可能存在部分新 staging，只能视为失败，不发布或执行。
工具不自动删除失败输出或既有数据，不在同一路径重试覆盖。

## 额外保护与现有校验

- 复用精确 head/platform、完整文件摘要清单、reparse/link 和非覆盖 materialize 检查。
- 增加 Windows ADS/非法字符、保留设备名、尾点/空格和 casefold 碰撞拒绝；采用保守跨平台规则。
- 目标与源按 resolve 后路径及 casefold 路径均须分离。
- 验证 `resources/app/package.json` 的 name 为 `local-api-workbench`、main 为 `desktop/main.mjs`、
  type 为 module，拒绝未经复审的 productName 覆盖；version 必须与 manifest 和显式期望值一致。
  manifest 保持既有 32 MiB 上限，app package JSON 单独限制 64 KiB，二者拒绝重复 JSON 键。
- staging 后再次核对身份。只承诺检查这些元数据，不证明实际运行时数据路径或代码行为；
  app name 稳定是未来升级兼容的前置条件，不是升级通过证明。

成功输出 `installationPerformed:false`、`signatureVerified:false`。摘要验证不是可信签名，
脚本不认证发布者；只接受操作者已经核验来源的包。

## 验证范围

```text
python -m unittest discover -s tests -p "test_portable_windows_stage.py"
python -m unittest discover -s tests -p "test_portable_*.py"
```

原创合成 fixture 将两个不同 head/version 分别放入新目录，核旧 payload、源和相邻合成数据字节不变。
其他用例覆盖错误身份/entrypoint/productName/version、架构、重复键、过大 package、有效大 manifest、
Windows 路径陷阱、源目标重叠与已有目标拒绝。部分非法名称在原生 Windows 无法创建，相关构造测试显式跳过，
不能因此声明已经做过原生 Windows staging/安装。

还需独立核真实 CI payload 的该步骤并保存输入 artifact ID/digest、head/version、工具提交、命令、
输出和字节比较；无论该步骤是否成功，[安装发行协议](INSTALLER-RELEASE-ACCEPTANCE.md)中的签名、
干净机器首次运行、升级/卸载/重装仍须单独完成。当前没有安装/卸载或 Windows 原生运行验收声明。
