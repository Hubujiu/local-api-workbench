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
