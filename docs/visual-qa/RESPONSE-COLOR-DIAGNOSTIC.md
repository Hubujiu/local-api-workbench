# HTTP response color diagnostic

Exact baseline: PR #295 `1e609f49939d8786687f4b6c950ffecdcac0c21e`.
CSS revision: `a1e89e9a8eeed45d8650306e2bbf53ec9539226c`.
Native reference: Apipost standalone 2.0.1, light and dark, same synthetic
local POST /users fixture. Both captures verify 201 and response fields
id=101, username=visual-fixture, status=created; raw/pretty and theme
switching preserve the response, and both page-error lists are empty.

Viewport 1188x848, DPR1; native bottom36 already excluded, Workbench cropped
to top812. No resize, registration, masks or tolerance.

Raw RGB mean absolute error, 0–255:

| Region [left,top,right,bottom] | Light before → after | Dark before → after |
| --- | --- | --- |
| Code [330,596,1135,800] | 1.1021 → 1.1211 | 1.9850 → 0.9589 |
| Text [391,596,700,680] | 5.9818 → 6.2657 | 6.6515 → 5.4913 |
| Safe frame [0,0,1188,812] | 7.1367 → 7.1317 | 9.0042 → 8.7744 |

Dark improves partly because its large uniform background now matches the
sampled native #1d1913. Light error increases slightly despite sampled
key/string/number colors. This is not dual-theme strict visual acceptance.
Text placement still differs by approximately two horizontal pixels;
antialiasing differs too. Full frames contain different trees, statuses,
navigation, functionality and actual time/byte measurements. These are
not pure styling error rates or performance comparisons.

CSS only: no raw response or renderer behavior changed, no unsupported
controls added. Response y495 and code y596 remain unchanged. Existing
response tests pass 3/3; CSS formatting passes. Complete source image SHA256
and capture metadata accompany the independently generated comparison report.

## Follow-up: retain dark-only changes

The light overrides from a1e89e9 are removed because their measured error
regressed. The complete baseline stylesheet is preserved byte-for-byte as
a prefix; only `.dark .http-response-*` selectors are appended. Thus no new
rule targets light rendering. Dark declarations are unchanged from the
verified capture above. The new revision still requires capture replay;
prior measurements above belong to a1e89e9, not this follow-up revision.
Native differences remain nonzero and strict acceptance remains unmet.
