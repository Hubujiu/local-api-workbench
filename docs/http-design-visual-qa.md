# HTTP design-mode layout: native reference adaptation

final result: blocked

## Source and implementation

- Source viewed: `api-design-light.png` and `api-design-dark.png` under `/workspace/shared/apipost-visual/evidence`, 1188 × 812 content pixels, POST request, raw JSON object schema.
- Implementation: `public/app.js` HTTP `modePanel` design branch and exclusively `.http-design-page` CSS selectors.
- Implementation capture: pending coordinating agent's combined/native verification. No pixel-match or browser-interaction pass claimed by this commit.
- Prepared shared runner: `/workspace/shared/apipost-visual/capture-design.mjs`; set `WORKBENCH_DESIGN_ROOT` to the combined checkout. It creates disposable local data and does not send the sample HTTP request.

## Scope and known differences

- Reference has inline Header/Query/Path/Body/Auth tabs and a tree/table editor. Workbench's real design workflow is JSON Schema source editing with a visual-editor dialog. Its executable request parameter controls remain in debug mode. Do not fabricate inline controls or claim feature equivalence.
- Reorganized existing content to directory/description, request schema/inheritance, response definitions, then transport/other settings. Every prior editable control and its ID, import warnings, attribute fields, response actions and TLS warning remain.
- Schema source is now a full-width framed panel with a 40px heading/action row, 264px minimum editor and 22px text rows. Page inset is 16px, section gap 24px. Existing theme tokens are retained in both themes.
- Font and typography: existing UI font preserved; monospace JSON source deliberately differs from the native field table. Needs rendered checking.
- Spacing and density: native-inspired grouping rather than a fictitious table clone. Needs matched viewport comparison.
- Colors: existing theme tokens, no global changes. Needs rendered comparison.
- Assets: no new or copied assets. No fake brand or private graphics.
- Copy: names real source/schema/connection features, not unsupported raw-body UI.

## Verification

- Focused HTTP layout and schema editor/identifier/composition/tagged-union tests: 21 passed, 0 failed.
- `npm run check`, changed-file Prettier and `git diff --check`: passed.
- Capture script prepared for light/dark screenshots, two visual-editor cancellation/reopen cycles, save, debug/design return, source retention, console errors and horizontal overflow. These checks are NOT yet executed on this commit.
- Full-view/focused-region comparison: blocked pending implementation capture. No visual iterations asserted.

## Remaining gate

Run the shared capture in the combined checkout, inspect source and implementation side by side at 1188 × 812, then capture the real desktop build. Check both themes, text/code legibility, focus, schema save/cancel and advanced settings reachability. Address actionable visual regressions before publishing this slice as verified.

## Signed-off scope of the local capture

The combined candidate ran in Chromium at 1188 × 848, DPR 1. Captures in
both themes were inspected against the installed Linux reference, cropping
only the trial/footer area from the reference. The source schema was preserved
after two visual-editor cancel/reopen cycles, a save, and a transition to debug
and back. No HTTP request was sent; no page errors or horizontal overflow were
observed in the design panel.

This confirms rendering and the scoped interaction flow, not design parity.
The native reference's inline field tree and example tab do not match
Workbench's JSON Schema source editor and separate real visual editor.

## Inline structure follow-up

- Added a real property/items tree with type badges and inline description editing. Changes clone the complete Schema and edit only the selected description; `$ref`, compositions, required fields and unknown keywords remain intact. Boolean schemas stay read-only in this surface.
- JSON source remains available in an expandable editor. The existing full visual editor remains the route for type, field and composition changes; this table does not pretend to support Mock settings or request tabs.
- Adjusted the design panel inset to align its left edge with the request toolbar. Both themes use scoped styles only.
- Focused regression suite: 23 passed. Syntax check, changed-source formatting, and diff whitespace checks passed.
- Updated browser runner: `capture-design-refine.mjs` in the shared evidence workspace. It additionally exercises description save and removal, preserving the original schema. Capture in this executor is blocked by Chromium `socket() failed: Operation not permitted`, including the approved execution attempt. Coordinating agent capture requested; no browser pass claimed yet.

## Verified inline capture and exact-base transplant

- Coordinating execution of `capture-design-refine.mjs` completed with `DESIGN_CAPTURE_EXIT=0`. Inspected `workbench-api-design-refined-light.png` and `workbench-api-design-refined-dark.png`; console report has `errors: []`, viewport 1188 × 848, and no design-panel horizontal overflow. Description save/removal, two cancel/reopen cycles and design/debug/design data retention succeeded. No sample HTTP request was sent.
- This is a scoped functional/rendering pass, not pixel-parity acceptance. Compared to the official images, the Workbench navigation is wider (content starts at x363 rather than x330), the description remains a real populated textarea, executable parameter/body controls remain in debug mode, and inline mock/required controls and the example tab are not reproduced. The table now exposes actual object properties and items instead of a long JSON source block. Dark badges remain neutral/gold rather than the reference's per-type colors.
- Inspection found that inline depth styling was blocked by the application CSP. Replaced it with external depth classes without relaxing CSP; a final capture is requested for that correction.
- Transplanted onto exact PR #296 `092fee1f29227dd5ea1c137fe194781487badbc0`; its tree is not identical to the earlier `f0de1d8` base. Preserved the existing environment/case imports and combined-capture notes when resolving the two additive conflicts. Full pixel-parity gate remains blocked by the listed feature/layout differences, not by a claimed completed parity pass.
