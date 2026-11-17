# Isolated response visualization

## Source and scope

Apipost's [current visualization guide](https://wiki.apipost.cn/docs/usescript/visual/) documents a response visualization tab, a Handlebars template plus data, and `apt.visualizer.set`. It distinguishes the older `apt.Visualizing` API. This online guide is a compatibility reference, not proof of every Offline2 behavior. The guide's response.json callable example conflicts with its dedicated response API; this implementation retains the already documented apt property / pm method distinction.

## Implementation contract

Post-response scripts support `apt.visualizer.set(template, data)` and the `pm.visualizer` alias, plus `.clear()`. The last set/clear across shared post-script stages wins. A later stage that does not set visualization preserves the earlier result. It is returned in the request/plan evidence and the response tab. No visualization is produced for a failed post-script stage. Ordinary history/evidence may therefore contain rendered response data; inspect before sharing.

Pinned Handlebars4.7.10 executes only inside the existing QuickJS VM. The host never compiles or evaluates a user template. Only string templates are accepted, never supplied AST objects. Template≤64KiB, serialized data≤256KiB, rendered output≤256KiB; all UTF-8. Existing VM memory/activity/wall limits and the 1MiB aggregate output limit remain. Each call creates an isolated Handlebars environment with prototype access disabled; no custom host helpers, partial registration or filesystem are exposed.

Version selection reviewed the upstream [AST type-confusion advisory](https://github.com/handlebars-lang/handlebars.js/security/advisories/GHSA-8r5x-fm3f-whwj); 4.7.10 is the patched version. This is not a claim that dependency audit alone makes arbitrary templates safe: compilation is additionally isolated and bounded.

## Browser boundary

The UI parses rendered HTML in an inert template, then constructs fresh presentation-only HTML nodes. It drops scripts, images, links, frames, forms, SVG/MathML, meta/base and user styles; only text/table/list/heading presentation nodes and a few non-active attributes survive. It rejects more than10000 copied nodes or depth32. Output is placed in an iframe with empty sandbox (no scripts, same-origin access, forms, downloads, popups or top navigation).

The frame has deny-by-default CSP. The only resource exception is this app's fixed local visualizer.css; user-supplied CSS/URLs cannot select arbitrary resources. Parent CSP is not weakened. Rendering uses built-in table/list styling, not arbitrary CSS or JavaScript charts. Old Visualizing, getData callbacks and active web pages are not implemented; this is a bounded static subset, not full vendor visualization parity.

## Verification

`tests/script-visualizer.test.mjs` verifies actual QuickJS Handlebars rendering/escaping, shared-stage persistence and clear, object/AST rejection, pre-request rejection, UTF-8 bounds and forbidden prototype traversal.

`tests/ui-smoke.mjs` exercises actual HTTP→post-script→response-tab flow; checks table data, escaped markup, absence of scripts/images/frames/styles/meta, empty sandbox, denied parent-document access and no adversarial fixture requests. It checks the fixed stylesheet and captures local-api-response-visualizer.png. Current commit CI determines whether this verification has completed; code existence is not a green result.

## 原版大小写别名

官方 Offline2 2.0.0 send.asar/index.js 的静态兼容层（解码字符 33593000 附近）将 pm.Visualizing 绑定为 pm.visualizer.set，现代 apt 引用同一 pm。现在两个兼容模式均提供 pm.Visualizing / apt.Visualizing，直接引用同一个受限渲染函数，不引入第二套渲染器，不改变后置限制、模板/数据配额或隔离 iframe。旧 visualizer.set/clear 保留。回归覆盖函数身份、覆盖前一次结果、字面标记转义、前置和超限拒绝；浏览器和三平台成品包实际使用该别名验证，结果以对应提交 CI 为准。
