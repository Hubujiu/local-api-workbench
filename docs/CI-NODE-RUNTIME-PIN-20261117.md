# 固定 CI 的 Node 24 补丁版本

2026-11-17 的整合验证实际使用了不同的 Node 补丁版本和 macOS runner 镜像：

| 验证                                                                                                       | 实际 Node | macOS 镜像版本  | 计时器配额用例                 |
| ---------------------------------------------------------------------------------------------------------- | --------- | --------------- | ------------------------------ |
| [首轮 shard 1](https://github.com/Hubujiu/local-api-workbench/actions/runs/44104118453/job/134111717905)   | 24.22.3   | 20261112.0504.1 | 通过                           |
| [第二轮 shard 1](https://github.com/Hubujiu/local-api-workbench/actions/runs/44107589801/job/134124057422) | 24.22.2   | 20261102.0473.1 | 兼容准备阶段先触及活动墙钟预算 |

原 workflow 的七处 `actions/setup-node` 均指定浮动的 `24`。现在统一固定为 `24.22.3`，使 core、browser、desktop、source-format、database-integration、quickjs-reproducible 和 downloaded-portable 使用同一个明确版本。运行时要求仍是 `package.json` 中的 `node >=24`；测试集合、分片、并发、平台矩阵和所有预算均保持不变。

[Node 官方 v24.22.3 release](https://github.com/nodejs/node/releases/tag/v24.22.3) 于 2026-11-11 发布，是已存在的 Node 24 安全版本，发布说明包含 HTTP/2、TLS 修复以及 SQLite 3.54.1 更新。选择该版本也有首轮真实 runner 使用记录。官方说明没有证明它修复本次 QuickJS 或 runner 调度问题。

这项修改消除 CI 的 Node 补丁版本漂移，不是两轮失败的性能修复证据。上述两轮还使用了不同的 macOS 镜像，不能作为仅改变 Node 的受控实验；`macos-latest` 等宿主镜像仍可能更新。第二轮计时器样本的兼容代码求值为 162ms 墙钟、约 7.914ms 线程 CPU，单凭该差异不能确定调度、宿主负载或 Node 版本是根因。已有失败和完整诊断应继续保留，最终整合须通过其自身的完整 CI。
