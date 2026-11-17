# 恢复后 HTTP 后置断言失败的诊断补充

整合 PR #264 的[第四轮 CI 44121828186](https://github.com/Hubujiu/local-api-workbench/actions/runs/44121828186) 在 `74665c6c56d7683ef6c664f5842b9e1c8d032c07` 上完成，47 个作业中 45 成功、2 失败，零取消/跳过。唯一实际测试失败是 [macOS shard 10](https://github.com/Hubujiu/local-api-workbench/actions/runs/44121828186/job/134174963471)；另一个是正确汇总拒绝的 `required`。实际 checkout `92fdefeb90928b27c62789d4c154ede381263c2a` 与发布头同树 `5bb62d13cda68454fc801e2902e46abc5e800e8b`。

`http-extraction-entrypoints.test.mjs` 的 HTTP transport 用例在备份恢复、重启后的第三次 CLI 执行中，得到零条后置断言，而原断言要求恰好一条。此前五步状态、HTTP 500、三个 `fresh` 提取值、冻结快照和执行记录已通过核对；第三次线缆/磁盘后续断言尚未执行。日志没有该步骤的底层错误或脚本诊断，不能确定是超时，也不能声称恢复逻辑丢失了后置脚本。

生产执行顺序可以解释这个表象：普通提取先填入 `record.extracted`，后置脚本成功完成后才发布 `record.assertions`。后置阶段发生错误会保留 HTTP 响应和提取记录，并保存 `record.error` 与公开脚本诊断；普通计划仍可继续。HTTP 500 原本就使第四步为 `failed`，所以只看状态无法区分额外的脚本失败。独立受控错误实验验证了相同表象可以由真实 QuickJS 后置脚本拒绝形成，但没有复现本次 CI 的未知原因。

本补丁只用既有 `withExecutionResultDiagnostics(run.results[3], ...)` 包住原来的 `after.length === 1` 和 `after[0].passed === true` 两条同步断言。成功时不观察结果；失败时保留原 `AssertionError` 并附加有界公开错误类别、脚本阶段、预算和 worker 生命周期。没有输出正文、变量值或任意错误文本，没有重放请求、减少断言、放宽期限或修改产品逻辑。

原 HTTP/stdio 完整目标文件 **2/2 通过，零跳过**。从实际修改后的断言块注入缺失和失败断言，确认原错误对象、actual/expected/operator 均保留；正确结果仍正常返回，诊断大小受限且私有字段未泄漏。独立审查通过。原始输出见同目录审查 evidence 下的 `http-extraction-diagnostic-green.tap` 和 `http-extraction-diagnostic-proof.json`。

第三轮失败的 XML 比较器、嵌套 HTTP/gRPC 流程，以及新增的三十种 XML 防篡改场景，在第四轮三平台均实际通过。它们是该版本的验收观测，不能据此宣称已确定第三轮短初始化停顿或第四轮缺失断言的物理根因。此补丁修复的是明确的诊断缺口；整合仍以修订提交自身的完整 CI 为门槛，旧运行不取消、不覆盖，也不把诊断补充写成已完成的生产修复。
