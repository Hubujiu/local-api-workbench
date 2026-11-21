# Apipost standalone comparison: secondary screens

Reference: official Apipost Offline 2.0.1, Linux x64, running normally in an
isolated trial profile. Capture window: 1188 × 848, light theme at 100%.
Workbench: same 1188 × 848 viewport at DPR 1, disposable fixture project.
Comparison copies crop the lower footer (and any MCP configuration snippets).
The screenshots are evidence from the run, not repository assets.

| Matched route | Scoped adjustment and verification |
| --- | --- |
| Project basics | Compact settings navigation, project identity row, distinct storage section. Saving a project name and returning from MCP preserved the value. |
| MCP, service off | Numbered cards and spacing. Reveal/copy remained disabled, no token was exposed, and the service was not started. |
| New environment | Two-column dialog, variable table and existing advanced JSON. Verified editing typed values, cancel, and repeated save without duplicate creation. |
| Empty HTTP cases | Side navigation and two create cards. Both genuine create dialogs opened, and Escape dismissed each without saving. |
| Empty AI plans | Full-width empty surface, 264px list and split panel. Verified both plan and run-history tabs; the empty panel measured 1074 × 468. |

None of the five screens passed strict pixel equality. Product-specific
controls, brand, evidence/access semantics, and fixture states are intentionally
not falsified to match. Reference and Workbench environment dialogs opened from
different background routes; Workbench also pre-seeds its base URL. The
reference uses a data pool on the case page; the Workbench uses request
snapshots. Retain these differences when comparing.

No runtime authorization changes or third-party code or art are included.
Populated case and plan histories, database configuration, protocol screens,
and both installed Windows clients are outside this evidence.
