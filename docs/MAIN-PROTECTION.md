# main 分支保护

GitHub Actions 的 `required` 已经汇总所有验证组，但只有 GitHub 仓库规则能阻止不符合要求的合并或直接推送。仓库中的 [规则文件](../.github/rulesets/main-protection.json) 是可导入的配置，不会自动启用保护。2026-11-18 检查时，公开 API 未显示 `main` 有效保护规则。

仓库管理员可在 Settings → Rules → Rulesets 导入规则文件（[GitHub 官方步骤](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#importing-a-ruleset)），或按同样配置手动设置：

- 只保护 `refs/heads/main`，启用规则，不设置 bypass。
- 禁止删除和强制推送；所有变更须走 PR，解完 review threads。
- 必须通过 GitHub Actions 提供的唯一检查 `required`；合并前分支须同步最新 `main`。已核对[汇总检查](https://github.com/Hubujiu/local-api-workbench/actions/runs/44130790449/job/134215707659)的 GitHub Actions app ID 为 `15368`。
- 不设置必须由另一 GitHub 账号审批的数量门槛，以免单维护者无法合并自己提交的 PR；这不替代维护者对合入 `main` 的批准。如果以后有独立审批人，再提高该门槛。

保存后检查 `GET /repos/Hubujiu/local-api-workbench/rules/branches/main`，须返回删除、强推、PR、required 检查四类规则。再用下一正常 PR 的合并面板检查，不用真实推送或删除 `main` 作为测试。若发现规则冲突，先核对现有设置，不覆盖未审查的规则。
