# Secondary-surface geometry checkpoint

Base: `3699e1905e3c2dd3df667412b79c6a7a72da29f3` (#294).
Implementation: `d72cfde6977da2810c8725e3aeebd40b57c8df31`.

Source: actual Apipost standalone 2.0.1 Linux native screenshots, light theme.
Implementation: actual Chromium browser screenshots, **not native Electron**,
1188 × 848 CSS pixels, DPR 1. Both source and implementation images were opened
and inspected for all five states. Source PNGs are 1188 × 812 due to removal of
the native window's device-identifying footer. Comparisons explicitly crop only
the implementation's bottom 36 pixels. No resizing, masks or replaced data.

## Verified changes

- HTTP cases no longer display the debug URL/send row. The same draft URL and
  send button return on switching back to debug. The redundant nested horizontal
  inset is removed. Menu starts x329/y138 (native x330/y138); the two existing
  creation cards now start x672 and x850, y411, 160 × 160, matching the reference.
  They still open the real case/group dialogs. No mock data pools/reports added.
- Settings first navigation button starts x62/y64 rather than y103. Its label,
  active styling and all destinations remain. The redundant visual group title
  remains in the accessibility tree. Extra Local API destinations deliberately
  mean later rows do not share the native navigation's exact positions.
- Empty execution-plan panel is x82/y181/w1074/h468 rather than y183. Plan tabs
  remain operable and the runs view is separately captured.
- Environment and MCP workflows were recaptured and regression-tested, not
  rewritten merely to conceal their different data or security semantics.

## Tests and evidence

Real browser script completed with an empty page-error list. It verified case
and group dialogs open/cancel, return-to-debug draft preservation, settings
navigation bounds, disabled MCP reveal/copy controls, and environment save,
repeat-save, cancel, advanced JSON and narrow-screen behavior. Existing CI smoke
now asserts the cases/debug URL visibility and preservation transition. Seven
case/settings unit tests, syntax and `npm run check` passed. Full CI not run here.

Evidence bundle names: `secondary-v2/cases.png`, `settings.png`, `mcp-off.png`,
`plans-empty-light.png`, `plans-runs-light.png`, `environment-new-light.png`,
`environment-edit-light.png`, `environment-narrow.png`, `results.json` and
`plans-bounds.json`. Exact PNG hashes and full-view diagnostics are in
`SECONDARY-PIXEL-DIAGNOSTICS.json`.

## Quantification and limits

| Surface | Changed pixels % | Mean RGB absolute error / 255 |
| --- | ---: | ---: |
| Empty cases | 52.214 | 3.658 |
| Empty plans | 62.838 | 2.480 |
| Basic settings | 33.910 | 4.142 |
| MCP disabled | 84.686 | 8.446 |
| New environment | 69.707 | 14.305 |

These are whole-view diagnostic differences, **not acceptance scores**. The
cases/plans empty and MCP disabled semantic states match, but branding, project
sample content, additional capabilities, authorization summary and navigation
contents differ. Settings lacks the source project-description row; no empty
fake row was inserted. The new-environment modal's underlying page and default
variable/service data differ, so its strict same-state comparison is blocked.
The environment screenshot retains real keyboard focus, not a hidden outline.

Final result: **blocked for whole-product pixel equivalence**. The enumerated
geometry and interaction improvements are verified; other differences remain
explicit and no native Workbench validation is claimed.
