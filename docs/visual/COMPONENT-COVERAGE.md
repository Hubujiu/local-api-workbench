# Component screenshot coverage

`state-inventory.json` enumerates 46 actual navigation, HTTP lower-tab, response,
plan, settings and dialog states/groups from source d89cc05. It is a backlog, not
proof that every capability exists in Apipost, nor all possible data permutations.

Snapshot 2026-11-19: existing strict reports for HTTP light/dark, response-201
light/dark and the five page pairs are **blocked**. No true inspected same-state
pair is recorded here. Two screenshots do not constitute paired acceptance.
Database deep native captures are reference-only pending matching Workbench
fixtures. Later captures do not retroactively change this snapshot.

- `needs-captures`: missing side or existing diagnostic images have inconsistent
  fixture/viewport/selection/response/theme/provenance. Recapture and inspect both.
- `paired-same-state`: reserved for complete matching metadata and independent
  immutable PNG pins. Eligible to compare does **not** mean pixel-exact. Zero now.
- `non-overlap`: intentional product identity/security/capability. Preserve it;
  never mask those differences inside an allegedly shared component.

## Strict component wrapper

```
python scripts/compare-visual-components.py components.json NEW_OUTPUT
python -m unittest discover -s tests -p 'test_visual*comparison.py'
```

Requires Pillow, like the existing strict comparator. Exit 0 means exact **listed
components only**, 1 different, 2 blocked. Reuses `compare-visual-states.py` without
changing its tests/baseline. Outputs `component-report.json`, derived pairs and
`comparison/report.html` with difference/overlay images. Existing outputs are
refused; source PNGs/manifests are never overwritten.

Manifest: `{ "version":1, "components":[ { "id":"request-tabs",
"region":[313,183,1188,221], "reference":CAPTURE, "workbench":CAPTURE } ] }`.
Each CAPTURE uses the existing strict capture schema (product, version/commit,
actual capturedAt, inspected:true, file, full state), **plus independently pinned
`sha256`**. State includes page, theme, fixtureDigest, viewport, deviceScaleFactor,
locale, zoom, scroll, selection and responseState. The entire state must match;
it cannot be rewritten merely because a small component happens to look alike.
The synthetic test file provides runnable schema examples, not real acceptance.

`region` is a **single shared rectangle in original screenshot pixels**. Separate
component-aligned boxes, resizing, tolerance, masks and offsets are not supported.
Viewport/DPR must describe the original capture. For already privacy-cropped PNGs,
record `sourceViewportCrop:[0,0,1188,812]` identically on both sides while retaining
original viewport `[1188,848]`; actual PNG dimensions must match the declaration.
Do not replace original viewport with the crop size. Hidden `contentCrop` is
rejected in the input. Missing required components block the aggregate; enumerate
all required components before comparison. Exact subsets never establish whole
window, behavior, permission or accessibility acceptance.

Validation is synthetic PNG-only. No native GUI capture or new product/reference
visual parity was performed by this task. Existing baseline images were untouched.
