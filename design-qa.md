# Visual verification checkpoint — 2026-10-18

final result: blocked

## Evidence and state

- Source: https://offline.apipost.net/images/apipost-desktop-light.png, downloaded and viewed as /tmp/official-apipost-light.png. Source1328×875pixels.
- Implementation: ad4587cab116987afe4df52f18d4e3ea6ae2efe8, Actions39100470579, artifact12125919386, SHA25644ce12666578eb58a9681e7d1df390371bdd573a37bce4518c81f2e48b7f26e0.
- Browser screenshot: /tmp/ui-ad4587/local-api-reference-light.png, CSSviewport1328×876, deviceScaleFactor1. The1pxheight difference is recorded rather than attributed to product drift. Both views show light-theme JSON request editing with no response; project data/URLs and original branding differ intentionally.
- Additional inspected states: /tmp/ui-ad4587/local-api-step-editor.png and local-api-function-validation.png. These verify advanced step editing and a function preview, not source-identical official modal layouts.
- Full-view images were opened together in one tool response. A pixel-normalized side-by-side composite and focused post-fix comparisons are still pending; this is not a complete fidelity pass.

## Findings and iteration history

- P2: Request editor block and response separator were lower than the source by roughly20px/40px. Reduced mode/URL margins, normalized URL height, shortened request panel and raw selector, aligned code/gutter18pxlineheight in673acb3. Added geometry assertions. Post-fix browser evidence is pending.
- P2: Function test result was clipped below the fold at1000×760. Generic modal textarea minimum170pxoverrode the compact controls. Raised compact-selector specificity in3eabe40, with bounding-box verification for on-screen result/input height. Post-fix browser evidence is pending.
- P2: Native select borders, secondary sidebar actions, text density and original sidebar/header spacing still differ. Further comparisons must retain the real controls and not replace functionality with a screenshot.
- P2: Failure evidence previously consisted of undifferentiated JSON and dropped pre-script assertion details. e03d08c preserves phase-labelled assertions and groups evidence/default-opens failed steps. Local175tests pass. Browser regression first failed because its script editor section was collapsed; corrected in673acb3, pending revalidation.

## Required surfaces

- Typography: both use compact sans-serif UI and monospace request content. Lineheight drift addressed, pending screenshot validation. Font rendering and text-density matching are not declared complete.
- Layout:50pxrail/297pxtree and centered project controls verified; vertical-rhythm fixes pending.
- Colors: warm cream/gold and warm dark palette verified visually, not a pixel-level color certification.
- Images/icons: original Local API branding and line-art empty state intentionally distinguish this product. The official brand/illustration is not copied; exact asset parity is not claimed.
- Content: source sample data is reproduced with a local mock URL; extra assertion/extraction capabilities and omitted licensing UI are explicit differences.

## Interaction and console evidence

ad4587's Chromium suite passed primary request/save/reload, modes, repeated modal dismissal, unsaved draft retention, advanced plan editing/save-conflict cancellation, protocol fixtures, function testing, and script persistence. CI records console/page errors and uploads video/trace. Later edits require their own full run; old green does not certify them.

## Next gate

Wait for the latest exact-head CI and inspect its screenshots. At05:37UTC GitHub connector returned no workflow records for673acb3or3eabe40, despite verified PR head advancement. No cause established. Local Chromium execution is blocked by the existing sandbox; its security restrictions have not been bypassed. No merge/deployment/complete-fidelity claim.

## Post-fix inspection — 09:04UTC

- 3eabe40 screenshot archive12130943185 hash e48b516a16c13d2a5f89612c1cb056b1d904e66e11979989de5964d34f9fafc1 extracted and compared side-by-side with the official reference in /tmp/api-reference-comparison.png. URL/editor/response geometry corrected; P2 vertical-rhythm issue resolved.
- eb2935b9 full CI39113795792 passed9/9. UI archive12130919825 hash b15b9f599d7bfe08f63a6520c97562b2b123476b90ea9793a109d1ef473524cc inspected. Function result6is now fully visible above the dialog footer; failed precondition shows explicit assertion and script log. These earlier P2issues are resolved.
- Current remaining fidelity findings are the native selects, sidebar secondary actions and type density. Overall final result remains blocked for full visual equivalence; this does not contradict functional CI success.

## Post-fix inspection — 09:37 UTC

- Latest verified commit946f5d95ed36cd52568fc57c7ce5b7bf708d21a8, Actions39115885319, all9jobs success and181core tests. Actual UI artifact12132740651, SHA25618e5d6b76438af205a5f620afeb03ebd987bc34e7bac3b813f4cb6777500175e.
- Comparison /tmp/api-comparison-946.png pairs the official1328×875reference with the browser1328×876capture without scaling. Search/type selector now share a row; extra sidebar actions are consolidated; native folder markers and immediate tab/tree renaming are visible. These earlierP2issues are resolved.
- The remaining typography hierarchy adjustment is pending its own capture. Original branding, demo content and license omission remain explicit scope differences. Full exact-equivalence result remains blocked; no hidden behavior or pixel-perfect claim is made.

## Post-fix inspection — 10:34 UTC

- b131877c / Actions39119424829 passed all9jobs. UI artifact12133252896 SHA2565efcd639d8ac43515a935f65bc174e2e0c3e95f0bd723742f19388c55374bd36 verified; HTTP/2 proxy screenshot visibly shows the actual h2 POST response and sent JSON.
- Previous4cee3 capture independently confirmed response-schema actions above the modal footer and load inputs2/2 matching results. These control issues are resolved. Exact visual-equivalence status remains blocked; no whole-product completion claim.

## Post-fix inspection — 10:45 UTC

- c222710 Actions39120343402 passed9/9; archive12133464973 SHA256030a3bd5a9ec283a54c32705d936b4831a1b06f8d3de7c8b4d74eef104710fef verified. The1000px HTTP/2 response capture now shows the complete200status, duration and size, with independent horizontal tab scrolling. Geometry/hit-test and last-tab navigation checks passed. Narrow metrics clipping is resolved; full fidelity remains blocked.

## Post-fix inspection — 15:10 UTC

- f287e7287ddb2e510f243809b80a61838c9bd6b5 / Actions39138963665 passed all nine jobs. UI archive12139859472 SHA256bd80a041532e5442f222c3fe8f84b38b3d8ff5361b396c39fc8fc803ab79e44c downloaded and verified.
- Raw Body dynamic editor capture inspected: input stays compact, non-Mock fields are hidden, footer actions remain visible. The conflict toast comes from an intentionally rejected save in the regression flow. The full browser suite now passes after success-record scoping; screenshot inspection alone was not used as a substitute.
- Original branding and advanced original layouts remain documented differences; exact equivalence is not declared.

## Native standalone checkpoint — 2026-11-19

final result: blocked (whole-product pixel equivalence); HTTP geometry slice verified.

- Source is the actual official Apipost standalone 2.0.1 Linux x64 window, light theme, POST 创建用户, raw JSON, unsent. Window is 1188 × 848, with only the bottom 36 px device-identifying strip cropped from the evidence PNG. Reference SHA256: `2094a36ddfe5cc0487b66985c9f288eb27209be8610ead97054771ba71716216`.
- Implementation is `522faff8985a6966ec87e4fff3f270953102e4e7`, real Chromium at 1188 × 848, DPR 1, same visible request body/name/URL, no network request sent. Light capture SHA256: `4d979ceb412b6e0fc2122762ad97fc06e590faf2a6a017179a3b63ed5610d068`. Both reference and latest implementation images were opened and inspected, then the typography/action-spacing slice was recaptured after refinement.
- Passing measurements in both themes: rail 50, tree 263, tabs 38; URL y138/h40; request tabs y178/h43; editor frame y273; response y495; response tabs h44 plus border. Browser console has no page errors and draft fields are unchanged after theme switching. These checks are part of the existing browser smoke, not an optional screenshot-only check.
- Resolved P2: project pane and stacked HTTP vertical rhythm differed from the actual native window. Resolved P2: editor text used excessive 13/18 px font/line height and 12 px inset; desktop stacked editor now uses the observed 12/16 px rhythm and 62 px gutter. Generation action stays left and formatting/expand controls stay right. Request send/save dropdowns are grouped without removing controls.
- Capture correction: filling the body had left the textarea scrolled to its last line, clipping the opening brace. Both overlay and textarea scroll positions are now reset before capture; this is capture-state normalization, not a pixel rewrite.
- Remaining P2: URL width differs because Local API retains its dedicated cURL control, plus additional protocol, assertion, extraction, visualization and script capabilities. Original branding/icons are intentionally retained. Source has five sample requests while the isolated implementation fixture has one; status choices and project-tree content are not identical. A whole-image changed-pixel score includes these content differences and must not be reported as a pure style score or pass threshold.
- Dark implementation capture is a regression check only. No native dark screenshot was provided to this slice, so dark-source fidelity is unverified. Other screens and post-send HTTP states remain outside this verified slice. No whole-product parity or release completion is claimed.

## Nonempty HTTP response checkpoint — 2026-11-19

- Actual official 2.0.1 light reference: POST to a synthetic loopback `/users`, status 201, JSON `{ "id": 101, "username": "visual-fixture", "status": "created" }`. Source is 1188 × 812 after the same explicit bottom crop; SHA256 `a1ed6da9c2217701ba53e0903aae1a4161e57c077211d8dd4a025a56a41e4efc`.
- Real Chromium capture at implementation `d460d30649510b151bf375218277cc303f4e02e4` verifies the actual loopback response, raw/formatted toggle round trip, response separator y495, gutter width62 and body start y597 (reference y596). Screenshot and reference were both opened and inspected. Console page-error list is empty.
- Added a minimal functional display toolbar (美化/原生), read-only JSON/Text label and numbered response body. Both display modes leave the stored network response unchanged. Error, decoding and binary-download evidence remain outside and ahead of the formatted view. No fake encoding/preview controls or source timing/byte values were introduced.
- Follow-up `dad22ca` removes the 1px response-header excess and uses 32px toolbar controls. It also preserves CRLF through textContent on raw toggle instead of HTML parsing. Unit tests cover hostile HTML, raw evidence preservation and CRLF. Existing browser smoke now compares raw view text to the actual `/execute` response body, then verifies formatted JSON equality. Full CI remains pending. The final `dad22ca` real-Chromium recapture was run and opened: response top y496/h44, toolbar y540/h56, body and 62px gutter y596, matching the reference body start. The real status remains 201 and the JSON matches the fixture; page errors are empty. Final PNG SHA256: `80d2fe73002bce8ec0e312826cc57cc6e27a37f9e837f5c7e6486bbcead2fb2c`.
- Observed Local API metrics (6.4ms / 70B) deliberately differ from source metrics (15ms / 282B). Those are actual measurements, not style errors to conceal. Additional product tabs and missing source-only controls still prevent full pixel equivalence. Whole-product visual result remains blocked.
