# 2026-10-18 P0 parity iteration — in progress

The frozen audit in PARITY-AUDIT.md describes d383014, not this evolving tree. It must not be silently rewritten as though all gaps are closed.

Implemented in this iteration:
- Shared environment domain: global/environment precedence, explicit selected environment, shared service names with per-environment base addresses, validation and CRUD.
- MCP adds project creation with scoped authorization, environment/service/global lifecycle, single API execution, explicit plan CRUD and run lookup. Existing nine tool names remain backward compatible; 34 advertised tools comprise 30 current capabilities plus four legacy aliases.
- Runtime extraction can be read through MCP and shared with manual debugging; saved configuration changes invalidate old runtime values.
- HTTP/plan/CLI/load/cURL paths use environment/global values and service binding.
- Plan description, updated time and AI/manual origin marker; UI has explicit description editing and deletion. Field-by-field orange highlights and live AI execution remain unfinished.
- UI supports global editing, shared service environment addresses and request service binding.

Verification before publication: 71 local tests passed, no skips; full current-head CI and expanded browser interaction must still pass. Tests use local fixtures only. Full source audit, client-specific MCP configuration, visual fidelity, smart Mock, API lifecycle fields and other documented gaps remain open.

Design decisions:
- Globals are overridden by environment values, then temporary execution values.
- Deleting an environment requires at least one remaining environment; the selected environment and affected saved plans are reassigned to the first remaining environment.
- Deleting a service removes its address mappings, but preserves bound request definitions so execution fails explicitly until reconfigured.
- MCP-created projects are authorized only within the already write-enabled current service configuration.
- No main merge, deployment, user-computer access or delegated coding task.

Second pass:
- Plan versioning now tracks AI/manual origin independently for name, description, environment and each changed step. Manual edits clear only their changed origin, leaving unchanged AI values marked.
- HTTP MCP exposes bounded running/recent activity and step progress; UI shows running tasks without replacing unsaved content. Standalone stdio progress is not yet bridged to another desktop process.
- Browser run 39084101925 failed because the new navigation test used an ambiguous settings selector (both rail and environment shortcut). Selector is now scoped to the rail; no assertion removed.
- Current local suite: 73 passing tests. Exact new-head browser/desktop CI still required.

Third pass:
- Independent interface-case snapshots now have create/edit/delete/run UI and persisted request/assertion/function snapshots. This replaces the earlier plan-only shortcut.
- Added project custom functions, status-code dictionary, typed custom API properties and lifecycle statuses. Shared functions run inside QuickJS as utils.name(...args), with a total source-size limit; they do not acquire host filesystem/network APIs.
- Shared functions are copied into plans/cases so future project edits do not silently mutate saved tests.
- Settings gets a secondary navigation tied to real resource sections. Workbench body types use radio selectors; warm dark palette and reference viewport dimensions have passed run 39084413706 on e0d6bcf, prior to these resource/case changes.
- Latest local suite: 76 passing tests. Expanded browser case/resource checks must pass on this next exact head; not claimed complete.

Fourth pass:
- Smart Mock implements ordered enabled rules, AND conditions on method/query/headers/body paths, bounded delay and custom safe response headers. No regex evaluation or host script execution; default response examples remain fallback.
- Project Mock switch is editable in settings. Rule semantics are an explicit independent implementation because the public screenshot names the feature but does not expose all original matching rules.
- Added usable parameter-helper drawer (variable insertion, function names, request schema), and send/save dropdown actions.
- Local fixture verification now 78 tests; browser adds repeated helper open/close, cURL menu and real smart Mock response coverage. Exact-head CI remains required.

Fifth pass: Git-readable storage
- New saves use project-ID directories with separate apis, envs, settings, plans, cases and history files. Filenames derive safely from stable record IDs; this is not Apipost's proprietary format.
- Legacy single JSON projects remain readable. First save writes the split format and leaves the original single file untouched as a migration backup.
- A complete transaction journal allows roll-forward after process interruption. Readers and writers take the same project lock; no power-loss durability guarantee is claimed.
- Configuration fingerprints detect external Git/file edits even if a version counter was not updated, rejecting stale UI saves.
- history is excluded in newly generated .gitignore; a Git checkout lacking history can open with empty history. User-supplied .gitignore files are not overwritten.
- 81 local tests pass, including legacy preservation, interrupted-write recovery and external-file conflict detection.
- Previous 02d27bb browser/desktop/core/database all passed; strict formatting failed on a non-idempotent first formatting pass of a chained test expression. The second formatting pass was checked locally; gate remains unchanged.

Sixth pass:
- Plan page is split into plan/record tabs with a left plan list and right editor; step drag/drop reordering complements keyboard-accessible up buttons.
- Plan name/description edits participate in unsaved-change handling and project save, rather than disappearing on navigation. Manual saves recompute provenance only for changed fields; untouched plans keep their timestamp.
- Split-file migration candidate da390221 passed all seven jobs in run 39085352021. Current plan-layout edits require their own CI.

Seventh pass:
- Real HTTP/2 direct transport (cleartext prior knowledge and verified TLS/custom CA) is selectable beside the URL. It reuses the existing body/response size limits, decode and request deadline. HTTP/2 proxy and cURL export are explicitly rejected rather than silently downgraded.
- Transport API basis: https://nodejs.org/api/http2.html (clienthttp2session.request, endStream and AbortSignal). Local real HTTP/2 fixture and certificate tests added; 83 local tests pass.
- Plan-layout run 39085547166 passed all jobs except browser: the test still expected the old “＋ 新建计划” label. It now targets the stable new-plan control; functionality assertion remains.

Eighth pass:
- API parameter definitions retain schema/type, required flags and descriptions; response definitions retain status/content/schema/example metadata through OpenAPI import/export.
- Export keeps operation IDs and concrete server origins; exported response metadata is cloned rather than mutating the live project.
- Added response-definition editor, parameter-definition controls, response-example tab and single-interface offline HTML sharing. Export includes typed parameter and schema details with escaping/CSP.
- Running a plan first saves pending edits, so execution does not silently validate an older plan.
- Latest 3b3f512 passed all seven CI jobs in run 39085713221, including new direct HTTP/2 tests. Current local suite has 84 tests; latest documentation/share browser regression still requires CI.

Ninth pass:
- MCP authorization remains off by default; explicit opt-in can persist the project grants, local port and connection key. Rotation immediately revokes the old key. Archive revocations are persisted.
- If the remembered port is occupied, the workbench remains usable on a new port but MCP fails closed, requiring fresh authorization/configuration. Credential files receive Git ignore entries; this does not untrack files a user already tracked manually.
- Client configuration views cover Cursor, Codex TOML, Claude Code, VS Code, WorkBuddy and a generic Trae HTTP template. No actual Codex/other Agent task is started; per-client live integration is not claimed.
- Format references: https://developers.openai.com/learn/docs-mcp ; https://developers.openai.com/ja-JP/docs/config-file/config-reference ; https://code.visualstudio.com/docs/agents/reference/mcp-configuration ; https://cloud.tencent.com/document/product/1831/137039 . Trae remains explicitly labeled generic/unverified.
- UI project saves no longer resend potentially huge history/run bodies; server preserves authoritative history.
- 87 local tests pass. 9bbf29c passed all seven jobs in run 39085954384 before the persistence/config-view changes.

Tenth pass:
- Unified project tree now includes HTTP definitions, documents and saved SSE/WebSocket/TCP connection definitions, with type and keyword filters. Clicking a saved protocol never automatically connects.
- Protocol definitions are persisted separately and use validated stable IDs. Session registry is capped at 50 retained sessions, in addition to the existing five active connections.
- Browser regression exposed a genuine modal bug: client-tab buttons inside a dialog form submitted/closed it. All content action buttons are now explicitly type=button; the repeated client-tab test is retained.
- 88 local tests pass. This tree and modal fix must pass exact-head browser/desktop CI.

Eleventh pass: parameter dictionary semantics
- Rechecked https://wiki.apipost.cn/docs/project_set/key_description/ as supplementary SaaS documentation because offline help says common usage is retained. It distinguishes reusable parameter descriptions/defaults/types/examples/enums from schema models; the two are now separate in this app.
- Parameter dictionary supports persistent entries, optional built-in common fields, explicit reuse in parameter rows, temporary captured descriptions, and KV/JSON/common MySQL CREATE TABLE preview import. Source duplicates select the more complete definition; existing key/type conflicts are unselected until the user chooses them.
- MySQL DDL is parsed as data only, never executed, and unsupported syntax/types fail explicitly. This does not claim a full SQL grammar or paid AI fill.
- 90 local tests pass. Browser adds dictionary import/reload/reuse. The prior tree run failed only because a document heading now also exists in the tree; the test locator is scoped to the heading, not weakened.

Twelfth pass:
- a5d5853483f143efa9e5376630dbb594ff745e0d passed all seven jobs in run 39086847229, including dictionary import/reload/reuse and packaged Windows startup.
- The JSON body helper now shows reusable dictionary parameters and inserts typed default/example values, refusing duplicate keys or non-object/invalid JSON without overwriting existing data.
- 91 local tests pass. A browser regression checks insertion preserves existing body fields; this new change still requires its own exact-head CI.
- Inspected the actual a5d5853 browser PNGs at 1328×876: parameter-helper Chinese text overlapped vertically, and the body-toolbar hint wrapped awkwardly. Helper text now has an explicit upright span and measured browser regression; toolbar items wrap as whole controls.

Thirteenth pass:
- Dictionary helper commit 090686c passed all seven jobs in run 39087172439.
- Expanded variable extraction to response headers (case-insensitive), Set-Cookie values, duration and whole text, retaining existing JSON-path behavior. Missing values fail with actual response evidence; reserved variable names are rejected. XML/XPath, regex and persisted environment/global destination scopes remain unsupported.
- Source scope: https://wiki.apipost.cn/docs/http_debug/set-valuable/ is supplementary online documentation, not proof of identical offline semantics.
- 93 local tests pass; browser adds extraction-source save/reload.
- Visual regression a07aa54 correctly failed: this Linux font's vertical glyph metrics still overlap with writing-mode. Replaced vertical shaping with four ordinary horizontal glyph rows rather than weakening the height check.

Fourteenth pass:
- Replaced the JSON-only step-edit modal with a snapshot form: name, method, URL, enabled Header/Query/Path/Cookie rows, body mode/content and step scripts.
- Editing retains IDs, parameter metadata, authentication, form-file data, assertions and other untouched advanced fields. The source API is not mutated. Advanced plan JSON remains available.
- 94 local tests pass; browser checks add/save/reopen and actual execution with a step header, and captures the editor screenshot.

Fifteenth pass:
- b75f80e passed all seven jobs in run 39087539435, including the new visual snapshot editor and persisted extraction-source UI.
- Re-opened the official light screenshot in the own cloud browser. Moved project controls into the center header group and the execution-plan entry to the header, removing its extra rail icon. Remaining protocol/database rail placement is still different.

Sixteenth pass:
- Added six bounded apt request mutation helpers (set/remove Query, Header, Body), based on https://v7-wiki.apipost.cn/docs/1000/ as a versioned supplemental SDK reference. Query mutations remove matching inline URL keys as well as editor rows; headers match case-insensitively and retain metadata.
- JSON/form body edits preserve other values. Whole-object replacement selects JSON; unsupported binary edits fail explicitly. These are synchronous VM-only operations with no host-network/process APIs, not a claim of full v7 or offline SDK compatibility.
- Actual HTTP fixture proves the pre-script changes URL query/header/body on the wire and leaves the saved plan unchanged. Replacing a file upload with a text helper fails explicitly. 96 local tests pass.

Seventeenth pass:
- Added an explicit original-compatible plan status policy: strict200 makes all non-200 responses fail even when status assertions expect them. The existing assertions/default-2xx policy remains the default for backward compatibility, so no old plan silently changes behavior.
- Plan UI exposes the selector; snapshots, provenance and modification times track policy edits. Core regression exercises 200/201/404 and legacy expected-error handling.

Desktop diagnostic checkpoint:
- 3bf2b17 passed all seven jobs in run 39087712430.
- 1c8b74f passed browser, core on all three OSes, database and audit, but packaged Windows showed a blank body and timed out before the send button. This is not yet attributed to code or runner; the existing test did not collect renderer/network/process diagnostics.
- Added failure diagnostics without increasing timeouts, adding retries or removing assertions. Latest-head desktop must pass before claiming it verified.
- Review found explicit null dictionary defaults were lost by nullish fallback. Shared dictionary value selection now preserves null (including first enum values) in display, parameter reuse and JSON insertion. Regression added.

- 657c2ce passed all seven jobs in run 39087912350, including packaged Windows. The earlier blank startup did not recur in this run; its root cause remains unproven, so diagnostics are retained.

Eighteenth pass:
- Matched the reference's six primary rail entries: recent, APIs, documents, dictionary, settings and Git (plus bottom trash). Protocol creation now lives in the project tree's New menu; database connections live under settings. Saved protocol items remain directly openable from the tree.
- Browser and packaged-desktop acceptance paths follow these real navigation changes; capabilities are not removed.

Nineteenth pass:
- Text regex extraction now executes inside the existing isolated QuickJS worker, with a 256 KiB response limit, 2000-character expression limit, VM interruption and a two-second outer worker deadline. No regex is evaluated on the HTTP server's main thread.
- UI exposes expression and capture group (0 is full match). Missing groups, invalid expressions and limits fail explicitly with response evidence retained. XML/XPath and persisted variable destination scopes remain open.
- Regression includes a catastrophic-backtracking expression to verify bounded termination; empty matches are distinct from missing matches.

Twentieth pass:
- Verified 6e2094e all seven CI jobs; inspected its downloaded light/dark reference PNGs after checking artifact SHA256.
- Body action buttons now occupy a separate bordered editor toolbar, matching the reference's two-row structure without an accidental lone wrapped button. The body editor uses flex height rather than overflowing a fixed subtraction.
- Replaced the clover placeholder with an original lightweight line rocket SVG; no proprietary illustration asset is copied.

Twenty-first pass:
- Body editor can expand into the workspace and collapse by button/Escape while preserving unsaved text. It does not create a second editor state or hide the close control.
- Browser regression measures expanded height and verifies content survives the round trip.

Twenty-second pass:
- XML/XPath extraction uses pinned @xmldom/xmldom 0.9.12 and xpath 0.0.35 from npm, selected after checking official release/security documentation; npm audit reports zero vulnerabilities at installation.
- XML parsing/XPath run in a 64 MiB worker with a two-second deadline, 1 MiB input, 2000-character expression and 256 KiB output limits. DTD/entity declarations and malformed XML are rejected; no user functions, document loaders or network bindings are supplied.
- Supports XPath 1.0 text/attributes/scalars and namespace mappings; multiple matched nodes use the first. Namespaces remain an advanced-JSON field. Tests cover actual plan transfer, invalid XML, entities and bounds.
- References: https://github.com/xmldom/xmldom/releases/tag/0.9.12 ; https://github.com/goto100/xpath .

Twenty-third pass:
- Added pm.variables as a genuine request-local scope, following https://wiki.apipost.cn/docs/http/temp-variables/ . It survives pre-to-post scripts, shadows shared values during current-request interpolation, and is discarded before the next request.
- set/get/has/unset/clear operate only on this local map; existing apt.setVar and environment runtime behavior are unchanged. Regression verifies local values neither leak into the next step nor overwrite shared plan variables.
- Full persisted environment/global script scopes remain a separate unresolved parity area; local scope is not mislabeled as them.

Load diagnostic checkpoint:
- 8cf82f7 Windows core failed the existing 100-request local Mock load acceptance: 100 results returned but 99 passed. Other OSes/browser/database passed; no root cause is inferred from the count alone.
- Failed HTTP load results now retain a bounded 1024-character response preview; the unchanged 100-success assertion prints failed result evidence. This adds actionable diagnostics rather than reducing counts or retrying away failures.

Windows contention follow-through:
- d02ec8d passed all seven jobs; the previous 99/100 failure did not recur, so its root cause is still unproven.
- To investigate rather than label it fixed, the local Mock load fixture now runs ten fixed contention batches. Each batch independently requires 100/100 successful actual requests; a failed batch is not retried or ignored.

Twenty-fourth pass:
- Added user-controlled stacked/side-by-side request/response layout and a compact mode that hides the project tree while retaining the rail. Preferences persist locally; toggling collects pending input instead of discarding edits.
- These are explicit independent semantics for the reference's layout/compact controls; the original's undocumented details are not claimed identical.
- Browser acceptance checks side-by-side geometry, hidden/restored sidebar and unchanged request text, with a dedicated screenshot.

Confirmed Windows lock handoff defect:
- The fixed ten-batch probe reproduced a 400 response whose body identifies EPERM on mkdir of the project .json.lock directory (run 39089285510). This locates the failure in lock acquisition, not request assertions.
- Same-process lock contenders now queue before filesystem acquisition. Cross-process ownership/nonce checks remain. Only Windows EPERM from mkdir receives a bounded same-operation retry; other permission errors propagate and no permissions/owners are overridden.
- Windows deletion can remain pending until handles close (https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectorya). That mechanism is consistent with the observed handoff error; exact underlying OS handle ownership was not captured.
- Added regressions for queue recovery after failure, idempotent release, and restricted retry classification. Ten 100-request batches remain mandatory.

- Lock fix 2943f19684059fa78ba4eb7feaa975a3f2d87035 passed all seven jobs in run 39089481325, including Windows with ten separate 100/100 load batches. An additional independent-process counter regression passes locally and is included in the next CI.

Twenty-fifth pass: persistent variable scopes
- Defined the scope contract before implementation in ADR-VARIABLE-SCOPES.md; new tests first failed for the missing module/APIs and absent commit callbacks, then passed after implementation.
- Added independent project-global, selected-environment, workflow/debug runtime and request-local maps. Scoped getters read their own layer; resolution is local > runtime > environment > globals. Legacy apt.setVar remains runtime-only.
- pm.environment / apt.environment / apt.variables and pm.globals / apt.globals now persist through a shared field-level compare-and-save hook in UI execution, MCP and CLI. Pre-script writes commit before HTTP; post extraction/script writes commit as one stage. Script throws discard that call's partial changes.
- Concurrent same-variable edits reject without overwrite. Unrelated edits survive. Persistence failures mark the step failed and retain request/response evidence while reverting uncommitted persistent layers.
- Extraction destination selector exposes runtime/local/environment/global. UI adopts only a revision-checked, field-checked write receipt, preserving unsaved request fields and rejecting ambiguous concurrent drafts instead of silently overwriting them.
- Real local HTTP/MCP, CLI persistence and browser save-after-script acceptance are included. Full original SDK compatibility is still not claimed.

Twenty-sixth pass:
- New plans created through UI/MCP now default to original-compatible strict200. Existing saved plans retain their explicit/legacy policy; interface debugging remains assertion-aware. Regression distinguishes new creation from old-plan updates.
- Settings secondary navigation now switches dedicated panes instead of scrolling one long page. Top MCP/environment shortcuts select their intended pane; selected navigation is marked.
- Added per-environment runtime-value read/edit UI. Edits remain process-local; persistent and runtime fingerprints reject stale editors. Clearing restores persisted baseline values. Server and browser regressions cover read/edit/reopen without changing stored environment values.

Twenty-seventh pass:
- Schema sample generation now honors common string/array bounds, numeric inclusive/exclusive ranges and multiples, constants, enum cloning and local JSON references. External references are never fetched; cycles fail explicitly instead of silently producing null.
- Node/depth/array/string/output budgets prevent nested generation from expanding without bounds. Complex unsupported constraints such as pattern/allOf require an explicit example; this is an illustrative generator, not a general schema solver or validator.
- Tests began with failures for ignored lengths and unresolved references; fixed regressions and a real UI generation check were added.
- Constraint references: https://json-schema.org/understanding-json-schema/reference/numeric ; https://json-schema.org/understanding-json-schema/reference/string .

Twenty-eighth pass:
- Added flat-directory shared-service bindings for relative request paths. Explicit service IDs win; full URLs and leading {{baseUrl}} addresses remain direct to avoid silently changing a configured host.
- Plan steps and interface cases freeze the effective service ID at creation; changing a folder later does not rebind prior snapshots. Legacy snapshots do not acquire new implicit bindings.
- Folder rename transfers its binding, deletion removes it, and conflicting rename targets are rejected. Missing/deleted service references stay explicit and fail execution rather than falling back silently.
- Pure and real HTTP regressions prove direct requests follow changed folder binding while old plan/case snapshots still use the original service. Browser checks binding save/reload.
- Flat-directory and safe direct-URL boundaries are documented in ADR-FOLDER-SERVICES.md; recursive hierarchy is not claimed.

Cross-process diagnostic checkpoint:
- Sample-generation run 39091120791 passed browser/desktop/database/audit but Ubuntu core hit the existing two-second cross-process lock acquisition limit in the independent-process counter test; matrix siblings were cancelled by fail-fast. It is not a green run.
- Added per-child elapsed/progress/owner-PID diagnostics and waits for both child outcomes before test cleanup. The 40-update assertion and acquisition deadline remain unchanged pending evidence; no root cause is inferred yet.

Twenty-ninth pass — corrected Smart Mock semantics:
- Official supplementary docs distinguish field-name/type generation from request-condition response selection. The prior implementation covered the latter; it must not be counted as the former.
- Added separate project field rules with bounded wildcard matching, seeded data expressions, optional builtins and a dedicated settings pane. Existing conditional response controls are relabeled accordingly.
- Field rules apply to Body schema samples and automatic JSON response-schema Mock when no explicit response example exists. Manual examples retain priority. No arbitrary script eval or remote data/image service is used.
- Fixed tests cover glob syntax, deterministic values, type rejection, explicit examples, real Mock/sample API equivalence and UI-generated Chinese-name fields. Scope and limits are in ADR-FIELD-MOCK.md.
- Review also found the extraction help mentioned advanced JSON without a button in that pane. Added the missing entry and made the packaged XML smoke configure a real namespace mapping through it before extracting the response.

Thirtieth pass — error-code dictionary semantics:
- https://wiki.apipost.cn/docs/project_set/errorcodes/ defines the dictionary as shared API documentation error codes, not only HTTP 100–599 labels. The previous numeric HTTP-only restriction was incomplete.
- Added string/business codes (including 0, negative integers and preserved leading-zero identifiers), single-entry CRUD, code:description bulk editing and documentation rendering/export. HTTP metric hints are now an explicit opt-in rather than confusing business codes with transport status.
- Shared dictionary changes immediately affect the in-app documentation and subsequent HTML/Markdown exports; already exported static files require re-export. No paid/cloud AI extraction is added.
- Tests cover canonical duplicate detection, multiline descriptions, HTML/Markdown escaping, UI bulk save, live docs and exported document contents.

Thirty-first pass — documented attribute types and sharing:
- https://wiki.apipost.cn/docs/project_set/api_attributes/ specifies text, number, single/multi-select, date, URL and email, and opt-in attribute inclusion when sharing. Added these types while preserving legacy boolean fields.
- Definitions have single-entry CRUD plus advanced JSON; option values and existing values are validated before incompatible schema edits. API and Markdown-document editors share typed controls; documents can also carry lifecycle status as described in https://wiki.apipost.cn/docs/project_set/api_status/ .
- HTML/Markdown exports omit custom attributes by default. The share/export dialog explicitly selects fields; tests verify selected email/priority appear and unselected internal notes/URLs do not.
- Existing attribute values survive definition removal as hidden/orphan metadata, rather than being silently deleted. They are not exported without a matching selected definition.

## Thirty-second pass: function validation editor

Official references: https://wiki.apipost.cn/docs/project_set/function/ and https://wiki.apipost.cn/docs/value/dynamicvalue/ distinguish parameter transforms from ordinary script libraries.
Added a dedicated create/edit/test/delete panel with immutable names, typed JSON preview, current-code/input test gate before save, and rollback on rejected persistence. New transform functions receive text; legacy args-based functions retain their original semantics. Execution uses the existing bounded QuickJS VM, rejects non-JSON and oversized results, and never gives the function host/network/filesystem access.
This pass does not yet claim dynamic parameter insertion or full Faker/Mock.js support. A preview only proves the tested input, not every possible input. API/import remains schema-validated; the interactive test gate is an editor workflow, not a universal proof certificate.
Tests cover typed output, legacy functions, invalid outputs, blocked host access and unbounded loops; UI verifies a real preview before persistence and locked names on edit.

## Thirty-third pass: dynamic parameter values

Implemented fixed/variable dynamic values for Query/Header/Path/Cookie/Form fields with ordered snapshotted transforms, current-value preview, and resolution after pre-request scripts. Returned literal braces are not interpolated a second time; unknown references fail before HTTP. Per-request count/transform/time budgets bound work. cURL resolves the current values without executing pre-request scripts, consistent with its existing behavior.
Raw-body dynamic insertion and Faker/Mock-based dynamic sources are still unfinished; see ADR-DYNAMIC-VALUES.md.
The previous function-editor commit passed browser/desktop/database/format and Linux/Mac core but Windows reported one failed regex chaining result. Existing log lacked the step error, so the assertion now includes the actual status/error/extraction evidence. No timeout or passing criteria was relaxed and the root cause is not yet established.

## Thirty-fourth pass: safe offline Markdown rendering

Pinned markdown-it15.0.3 and esbuild0.28.2 from the official npm registry. The browser renderer is bundled locally with its transitive licenses; runtime needs no CDN. Supports standard headings/emphasis/lists/tables/fenced code and an editor preview, plus the same renderer in standalone HTML export.
Following markdown-it's safety guidance, raw HTML stays disabled. Only explicit HTTP(S), mailto and fragment links are allowed; images are rendered as text so opening a document does not silently fetch remote trackers. Source previews are bounded to256KiB and nesting30. This is a documented safety limit, not full rich-HTML compatibility.
Core fixtures compare the production browser bundle to the source renderer and reject active URLs/HTML/remote images. Browser acceptance edits Markdown, checks the preview and saved table, and captures a screenshot.
Also tightened dynamic-value JSON validation and aggregate-work limits. The earlier75da820 commit passed all7CI jobs; the isolated Windows regex failure from1f40c0d did not recur, with diagnostic assertions retained and no timeout relaxation.

## Thirty-fifth pass: raw Body dynamic insertion

Added named Body dynamic tokens with separate definitions preserved in snapshots. The helper inserts at the current selection, allows editing/removal, and chooses typed JSON escaping or literal text output. Resolution happens after pre-request variables, without re-interpolating generated braces. Missing definitions fail explicitly. Total field/transform/time bounds also cover Body occurrences.
The Markdown browser failure in d2c5d8f was a strict locator matching both saved content and the retained hidden modal preview; scoped the assertion to the main document, preserving the table requirement. Source-format (including reproducible bundled output) passed.

## Thirty-sixth pass: seeded Mock dynamic source

Dynamic values now accept the existing bounded Mock expression set and typed outputs, feeding the same ordered transforms. Optional32-bit seeds make replay deterministic; omitted seeds generate a new sample on each evaluation. The UI explains that preview does not freeze random output. Does not claim the fullFaker/Mock.js catalog.
Fixed tests verify seed repeatability, typed transformation, invalid seed and unsupported function rejection; the browser configures a Mock integer, previews14 and checks14 on the actual outgoing URL.

## Thirty-seventh pass: native desktop CI matrix

Replaced Windows-only assembly with a shared platform-aware packaging script and manifest layout. Added actual macOS/Linux packaged startup tests alongside Windows, using the existing HTTP/script/XML/SQLite acceptance flow. Linux uses Xvfb with sandboxing unchanged; macOS uses only an ad-hoc CI signature, not notarized distribution. tar.gz preserves non-Windows execute permissions/symlinks.
Previous4270822 passed all7jobs with141coretests. New matrix expands the expected job count to9; local142tests pass, but native Mac/Linux results are still pending.

## Native matrix first result

9b9f60c / Actions39095503517 successfully launched and exercised all three native desktop packages (Windows/macOS/Linux); browser/database/format and Linux/Mac core passed. Windows core failed only the new layout unit assertion because it compared a Windows-normalized path to a literal forward-slash suffix. Replaced that expected suffix with path.join, preserving the expected components. Full9-job green still requires a new exact-commit run.

## Thirty-eighth pass: OAuth1 signing

Added explicit OAuth1 authentication UI and HMAC-SHA1/HMAC-SHA256 signing of the final wire parameters. Preserves duplicated form/query fields, supports optional realm/callback/verifier/version, and automatically generates nonce/timestamp. Postman import retains credentials. Unsupported grant/signature variants and cURL export are documented instead of silently downgraded.
Independent RFC5849 section1.2 signature and parameter-normalization fixtures, a real local HTTP fixture and browser authorization-header evidence cover the implementation. Other advanced auth types from the historical official documentation remain unfinished.

## Thirty-ninth pass: explicit-credential AWS Signature V4

Added the official Smithy signer with pinned dependency, final-payload hashing, duplicate query handling, S3 path rules and optional session tokens. No credential-provider discovery or AWS network login. Added Postman import and explicit cURL rejection.
Extracted authentication rendering/model into dedicated modules, retained existing OAuth2 controls, masked secret inputs, and made unknown auth types fail closed.
Published Smithy vectors and local HTTP/browser tests cover signing. OAuth1 predecessor3fad1b7 passed all9CI jobs (146coretests); this AWS batch must be independently verified.

## Fortieth pass: Hawk and EdgeGrid authentication

Added Mozilla Hawk request MAC/payload signing and an independently tested EdgeGrid canonical HMAC implementation. Both expose explicit credentials/options, retain supported Postman fields, and reject unsupported cURL generation. No .edgerc/profile discovery, account login or automatic remote requests occur during setup.
Hawk uses published Mozilla GET/POST vectors and an actual local verifier; EdgeGrid uses Akamai's published Python JSON signature, byte truncation/header ordering checks and real outgoing evidence. Browser acceptance exercises all four newly added signing types.
AWS predecessor716d1f3 passed all9jobs (152coretests). Current local suite159passes, with dependency audit0 vulnerabilities; full CI still required for this batch.

## Forty-first pass: cross-process stdio execution visibility

Added safe runtime activity records and a heartbeat bridge so the existing UI progress view sees a separately running stdio MCP process, even with HTTP MCP disabled. Exposes the data-root configuration needed to share evidence, without implicitly granting project/write/execute permission.
Tests use the actual local stdio server, a gated two-step HTTP fixture and browser-visible running/finished status while preserving a dirty editor. No Codex or external AI agent is invoked.
Hawk/EdgeGrid predecessor2bb52ac passed all9jobs (159coretests); new local suite161tests passes before browser verification.

## Forty-second pass: visual advanced step editing

Execution-step snapshots now expose the shared authentication editor (without triggering OAuth grants), structured assertion rows and extraction source/scope/path/group controls. Existing XML namespace maps and other metadata survive row edits. Form-file/TLS/dynamic-definition advanced details remain preserved rather than silently rewritten.
Moved modal bindings into the step-editor module. Saving a candidate no longer mutates the live plan before the server accepts it, and a preceding project save no longer replaces an independently edited plan candidate. Browser validation injects a rejected plan save, cancels, reopens and confirms the prior token remains; accepted edits persist and the plan actually runs.
Corrected the script UI wording from CPU time to the actual250ms wall-clock execution budget plus2second worker deadline. No safety limit was changed.
stdio predecessor482c156 passed all9CI jobs with161coretests; this batch has162localtests and requires fresh CI.

## Forty-third pass: isolated CryptoJS and Chai compatibility

Read the official open-source runtime package as a capability reference; did not run its VM or pull in its host-access stack. Added pinned pure-JS CryptoJS/Chai bundles inside QuickJS with retained licenses, reproducible build checks and full dependency auditing.
A bounded random-byte primitive supports CryptoJS salt/IV creation without exposing Node modules. Chai assertion APIs replace the minimal equality-only implementation. The former require-undefined assertion now verifies the actual capability boundary: only the two allowed libraries load, while seven host module names are rejected.
User-code250ms/16MiB and total2second worker limits remain; trusted-library initialization has its own bounded1second phase. CryptoJS maintenance status and compatibility limits are documented.
Advanced-step predecessor2fce1c5 passed all9jobs with162coretests. This library batch requires fresh local/full CI evidence.

## Forty-fourth pass: public Apipost JSON importer

Added a bounded adapter for the official public converter's JSON tree, independently tested against actual swagger2apipost0.1.89 output generated from our synthetic Swagger fixture. Preserves API parameters, folders (including empty folders), basic credentials, bodies and examples/schemas. Imported file paths require reselection; unsupported dependency/script/inheritance cases fail before project mutation.
Scheme-less URLs receive a visible persisted HTTPS-assumption note; no import executes requests. This is explicitly limited compatibility, not a claim that the current Offline2.0 native directory can be loaded unchanged.
CryptoJS/Chai predecessor03d642b passed all9jobs with164coretests. This importer batch needs separate CI.

## Forty-fifth pass: observable legacy script objects

Added bounded Postman header/raw-body helpers, request-local variable reads with scope fallback, legacy response/raw/json/header/cookie access and apt.assert plus environment/global aliases. All run inside QuickJS; real HTTP tests confirm header/body changes and assertion outcomes, and browser validation confirms a legacy response extraction persists through the same guarded environment writes.
Async test callbacks now explicitly fail as unsupported instead of being incorrectly counted as passed. Script assertions are capped at1000. No async host/network access or persistent cookie jar is implied.
Limited-import predecessora86fb985 passed all9jobs with168coretests; current local script additions require fresh CI.

## Forty-sixth pass: observable failure evidence

- Reviewed the official execution-plan guide again: failed steps must preserve requests, assertions, script logs and extracted variables, and subsequent steps still execute.
- Found pre-script assertion results were discarded before throwing a generic failure. Preserve them with phase labels, including successful preconditions alongside response/post-script assertions. A failed precondition still prevents sending; later plan steps still execute.
- Execution records now default-open failed steps and group assertions, request/unsent configuration, response, script/operation logs, extracted variables and full JSON evidence. Untrusted strings remain HTML escaped.
- Added deterministic runner/render tests and a browser regression that deliberately fails a precondition, inspects visible failure/log evidence, then restores the prior script. Local175tests pass before the added browser scenario; browser validation requires this commit's CI.
- Previous script-compatibility commit ad4587cab116987afe4df52f18d4e3ea6ae2efe8 passed all9jobs in Actions39100470579, with173core tests.

## Forty-seventh pass: reference screenshot spacing

- Downloaded official light screenshot and the exact ad4587 browser artifact (SHA25644ce12666578eb58a9681e7d1df390371bdd573a37bce4518c81f2e48b7f26e0), and visually compared both at1328px width.
- The request block sat about20px too low, the response separator about40px too low, and code lines were too tall. Reduced excess mode/URL spacing, gave the URL line40px height, tightened the raw-format selector and aligned code/gutter line height to18px. Kept real functionality and independent original branding.
- Added browser geometry assertions around the actual reference URL/separator positions, alongside screenshots. These are alignment checks, not a pixel-identical claim.

### Failure diagnostics before the spacing iteration

Actions39100628839 on e03d08c had two failures: the added browser test attempted to fill a textarea inside the collapsed “本步骤脚本” section, so the test now explicitly opens that section before editing and restoration. Windows core reported a CLI plan failure but the assertion only printed generic stderr; include the actual machine-readable stdout evidence in failure diagnostics. The Windows CLI cause is not yet proven; no deadline or expected exit code was relaxed. Other platforms passed the new runner evidence tests.

## Forty-eighth pass: screenshot-caught function-preview clipping

Visual inspection of ad4587's actual function screenshot showed that the earlier compact textarea rule was overridden by the generic dialog textarea selector. Its higher specificity forced both textareas to170px and clipped the test result below the fold. Scope the compact rules under #dialog-content, and add a real browser bounding-box assertion for the preview result at the existing1000×760viewport. Do not count a mere DOM visibility assertion as proof the result is on-screen.

## Forty-ninth pass: CI recovery and precise evidence selectors

- With explicit user approval, closed/reopened the samePR #1 once at08:59UTC; latest3eabe40 received Actions39113570716. No branch replacement, main merge or deployment.
- Eight jobs passed, including Windows CLI/core and all three native packages. The earlier Windows CLI failure did not recur; root cause remains unproven and stdout diagnostics stay enabled.
- Browser reached the intended failed-precondition record and rendered the error, assertion and logs correctly. Its text-based pre locator matched the earlier hidden request-configuration JSON because that JSON also contains the log text in the script source. Give evidence sections explicit labels and scope the regression to the opened log section; preserve the same visible-log assertion.
- New reference spacing assertions passed before this failure. Function-preview clipping fix was not reached, so its verification remains pending.

## Fiftieth pass: visual step multipart and transport overrides

- Wrote the metadata/persistence/validation regression first; it failed because the prior editor ignored form replacements. Implemented visual text/file form rows, enabled flags, add/remove and explicit browser file selection up to6MiB. File contents remain in the independent plan snapshot, not the source interface.
- File reads block saving while pending, surface size/read errors, and ignore superseded reads after switching type or choosing a newer file. No arbitrary filesystem reads or imported file path resolution.
- Added per-step timeout, HTTP version, proxy and CA/client certificate/private-key/passphrase controls. TLS verification remains enabled; secrets are explicitly described as stored in the local snapshot. Existing unknown metadata remains preserved.
- Browser regression selects fixed binary bytes, saves/reopens the snapshot, and verifies actual multipart bytes/name/text plus bearer auth at a local HTTP fixture. Transport field persistence is checked; existing transport tests cover real TLS behavior.
- eb2935b9 passed175tests and all9CI jobs in Actions39113795792. Actual function-preview and failed-step screenshots inspected; previous clipping and evidence display fixes are confirmed. New form/transport controls require their own CI.

## Fifty-first pass: sidebar reference composition

- The compared official screenshot places type filtering inside the search row and has one compact creation entry. Move the existing type selector into that row; keep new-folder under the creation menu and move project import/export into the section toolbar, preserving their original handlers.
- Remove extra native control borders on lifecycle/project/environment selectors and restore the white method segment and normal UI-font URL field. No decorative control replaces a real function.
- Added browser checks for search/filter alignment and opening/cancelling the relocated new-folder action without creating data. Updated screenshots remain the verification gate, not CSS alone.

### Relocated creation regression

Actions39114560592 passed the new sidebar alignment/cancel checks but a later pre-existing folder-persistence scenario still clicked the now-collapsed folder button directly. Update all three folder-entry scenarios to open the creation menu when necessary, while preserving their persistence and concurrent-save assertions. No force-click or visibility bypass is used.

## Fifty-second pass: bounded callback HTTP script bridge

- Fixed acceptance first demonstrated missing pm.sendRequest. Added only the callback API through a parent-owned HTTP broker; no Node/file/module APIs are exposed and pure function/dynamic/regex workers remain network-disabled.
- Original two-second worker deadline, 16MiB memory and cumulative250ms active script execution budget remain. At most10calls/four outstanding; child request64KiB, response256KiB, per-request1500ms maximum. No unsupported Promise API silently succeeds.
- Await callbacks before applying variable scope changes. Exceptions fail the script, completed/interrupted child evidence is preserved, cancellation aborts child HTTP, and callback infinite loops remain interrupted.
- UI and packaged-desktop scenarios execute a real local callback request, inspect child evidence and persist the returned token. Unit coverage verifies pre-token request feeding the main Authorization header, capability denial, failure/cancellation and limits.
- Source: official Postman callback examples; this does not claim full Postman/Apipost SDK or unrestricted async compatibility. TLS checks stay enabled and request definitions cannot read arbitrary files or inherit ambient credentials.

## Fifty-third pass: real folder disclosure and current-interface location

- Folder carets now use native keyboard-accessible details/summary disclosure rather than a decorative caret that only opened settings. Directory settings remain an explicit control; collapse state is scoped per project in the current UI session.
- Added “定位当前接口”: clears keyword/type filters, expands its folder, scrolls/focuses the active request and preserves unsaved editor contents. Search reveals matching content in collapsed folders.
- Browser acceptance collapses the active folder, hides it behind conflicting filters, invokes location and verifies visibility/filter reset/unsaved-name retention before restoring the reference state.
- The callback HTTP bridge in2a615882 passed181tests and all9jobs in Actions39115212829, including browser and real packaged execution on all three platforms.

## Fifty-fourth pass: post-capture disclosure and label corrections

- Inspected947b7a8b's actual reference and script-HTTP screenshots (artifact12132039072; SHA256987e4f8d512e34ce75f7cf28dc1c8283ffdab5ba39d13d77eabe0787a4cab68a). All9jobs passed in Actions39115573594.
- The folder disclosure worked, but the old .folder flex rule suppressed the browser's native marker. Restore list-item rendering for summaries instead of drawing a fake arrow.
- The unsaved-name preservation test restored the input but tab/tree labels still showed the interim name until a later render. Update those labels immediately using escaped tree rendering/textContent without replacing the focused editor, and assert both label values before the reference capture.

## Fifty-fifth pass: reference text hierarchy

- Inspected the post-fix946f5d95 screenshot archive12132740651 (SHA25618e5d6b76438af205a5f620afeb03ebd987bc34e7bac3b813f4cb6777500175e), including the same-width side-by-side reference. Native folder markers and restored request labels are now visible; all9jobs passed in Actions39115885319.
- Reference parameter/response tabs and tree item names have stronger text hierarchy than the previous muted13pxlabels. Align those controls to14px, use a warmer higher-contrast inactive tab color, and reduce tree-row vertical padding to retain compact density. Code remains13px/18px. Exact font rendering across operating systems is not claimed.

## Fifty-sixth pass: visual request-schema structure editor

- Added fixed tests before implementation for nested object/array nodes, required membership, typed0/false/null examples, untouched constraints, duplicate names, reference-safe rename/delete, invalid paths and XSS-safe bounded rendering.
- Design mode now opens an independent draft tree editor for common object/array fields. Add/edit/remove fields, descriptions, required flags and JSON examples without writing schema JSON manually. Existing minimum/maximum, definitions and unmodeled constraints remain intact.
- Local references to a renamed/deleted property block the operation instead of silently dangling. Boolean/ref/union/conditional edge cases retain the JSON advanced route; this is not a complete JSON Schema authoring/validation engine. Tree limits:500nodes/16levels.
- Cancel discards visual changes; outer save applies pending field input atomically or leaves the dialog open with an error. Browser coverage checks cancellation, invalid example refusal, false example persistence, retained numeric constraints, and generated request-body values.

## Fifty-seventh pass: visual response definitions

- Reuse the bounded schema editor for response status/description/content type and structure. Existing media examples, response headers, other content types and unrelated statuses are preserved; duplicate status additions and malformed status/media values are rejected.
- New media types are added explicitly without deleting old ones. Raw JSON remains available for response deletion, complex references and unsupported constraints.
- Tests cover atomic metadata preservation first, then browser creation of a201JSON response with typed boolean example, retention of the original200text/header definition, disk persistence and OpenAPI export of the actual saved result.

Response retry review additionally keeps pending schema edits transactional when outer status/media validation fails: reading the draft no longer clears its pending editor. The browser rejects a duplicate200response, changes the pending false example to true, retries as201and checks the saved/exported true value. URI-encoded local references and deletion of anchored schema subtrees also take the safe advanced-edit route.

## Fifty-eighth pass: truthful load execution

- Found that the load route bypassed pre/post scripts and dynamic values. A new fixed test first proved a post-script failure was wrongly counted as2passes. Route samples through the existing request pipeline instead.
- Keep100primary executions/concurrency10, count script child calls separately, and preserve cancellation. Per-sample variable scopes are isolated and do not persist to disk or leak across concurrent samples; UI and confirmation text describe script side effects.
- Summaries retain failed assertion names/phases, bounded child evidence, HTTP duration and full-sample elapsed. No-response runs show no latency sample instead of implying a0msrequest.
- Tests exercise parallel token callbacks, dynamic JSON body, post-script failure, isolated variable counters, unchanged saved project variables and cancellation after the first observed request. The existing ten100-request probe remains unchanged. Browser checks execute2authorized local mock samples and confirm script counts and unchanged config revision.

## Fifty-ninth pass: screenshot-observed control state

- 0e9430e78 passed186tests and all9CI jobs in Actions39117781360. Inspected its actual schema/response/load screenshots (artifact12132549613, SHA2566bede6d555de61c41a51b6e5e729daa199b5ac027eb256b419d76a22d7c2c1f9).
- The load run correctly completed2samples/concurrency2, but rerendered inputs incorrectly reset to10/1. Keep per-request UI options, validate them before starting, and clear stale results at the next run. Browser assertions now check both retained inputs.
- Response-schema field actions sat just below the dialog's visible content edge. Allow the schema dialog content to use the available viewport while retaining header/footer space, and assert that the pending field action is above the footer at1000×760.

## Sixtieth pass: HTTP/2 proxy and cURL export

- Tests first demonstrated that HTTP/2 proxies and protocol-preserving cURL export were missing. Added shared CONNECT setup for h2c/TLS through HTTP/HTTPS proxies, while keeping origin/client certificates separate from the new proxy CA setting.
- Four transport combinations, independent CA trust, target hostname mismatch, mutual TLS, timeout and cancellation pass real local fixtures. Proxy credentials do not reach origin headers.
- Export chooses strict protocol flags, disables curl URL globbing and fixes ambient proxy behavior explicitly. Import round-trips supported flags and rejects multi-URL commands instead of silently dropping requests.
- The fixed Linux cURL integration executes generated commands against local direct/tunneled HTTP/2 servers and verifies exact path/body/auth behavior. Local curl8.14.1passed; CI's browser job also runs this script. HTTPS strict HTTP/2 requires curl8.10+per the official man page.
- Browser acceptance selects HTTP/2 and a proxy in a fresh project, executes an actual tunneled request and checks generated cURL flags. API and step editors expose a separate HTTPS proxy CA.

## Pass 61 — default cURL configuration isolation

- b131877c / Actions39119424829 passed all9jobs and195core tests; real curl and browser HTTP/2 CONNECT passed. UI archive12133252896 SHA2565efcd639d8ac43515a935f65bc174e2e0c3e95f0bd723742f19388c55374bd36 verified and HTTP/2 response screenshot inspected.
- Added a synthetic curlrc header fixture first: actual exported command sent the unrelated header, failing the assertion. Generated commands now put --disable first; same fixture passes without reading user configuration. First-position import validation added. This change awaits its own CI, not the previous checkpoint.

## Pass 62 — narrow response navigation

- The verified1000px HTTP/2 screenshot exposed a squeezed status label beside overflowing response tabs. Reserve metrics width and prevent tab labels shrinking; tabs scroll within their own width.
- Browser regression checks nonoverlapping bounds, full metrics width, status hit-testing and scrolling to the last tab then back to the response. This change awaits exact-head CI and screenshot inspection.

## Pass 63 — tuple samples and test process diagnostics

- JSON Schema ordered tuples now cover modern prefixItems/items and legacy items/additionalItems, false-slot truncation, bounded tails and min/max bounds. Duplicate unique tuples and mixed/unevaluated constraints fail explicitly. Two regression cases failed before implementation and pass afterward. General constraint solving remains out of scope. Primary reference: https://json-schema.org/understanding-json-schema/reference/array
- baafd44 Actions39119924894 passed8jobs, but Windows core reported script-compatibility.test.mjs as a file-level failure after four passing cases, with no cause or exit code in spec output. A targeted Windows retry was requested; structured TAP artifact added for future file-process failure diagnostics without changing test selection or assertions. No root-cause fix is claimed.
- At10:41UTC the same baafd44 run reported success after the retry; latest job listing is9/9success. This establishes a passing retry, not an explained or fixed first-attempt process failure.197local core tests pass for the pending tuple/UI/diagnostic changes.

## Pass 64 — legacy OAuth1 RSA signing

- c222710 Actions39120343402 passed all9jobs and197core tests on first attempt. Narrow response status screenshot verified from artifact12133464973 SHA256030a3bd5a9ec283a54c32705d936b4831a1b06f8d3de7c8b4d74eef104710fef; status200 is no longer squeezed. Modern tuple generation also passed the real UI flow.
- RSA-SHA1 added according to RFC5849 with explicit inline RSA PEM, encrypted-key password, bounded input and generic errors. Golden vector computed with independent OpenSSL CLI; preimplementation tests failed and implementation passes them. No external credential provisioning or automatic OAuth1 grants. Pending own CI.

## Pass 65 — encoded local Schema references

- e6b0176 Actions39120629637 passed all9jobs and201core tests, including real browser RSA execution and three native packages. RSA uses a public synthetic test key only.
- Sample generation now decodes a local URI fragment once before JSON Pointer token decoding, rejects malformed percent/tilde escapes and non-schema targets, and detects encoded reference cycles. A regression failed before the fix; unit and real Mock/sample-route integration now pass. Primary reference: https://www.rfc-editor.org/rfc/rfc6901#section-6. This pending change has202local core tests and requires its own CI.

## Pass 66 — step dynamic parameter UI

- e93d816 Actions39120873680 completed successfully; encoded-reference fix has202core tests.
- Step Header/Query/Path/Cookie/text-form rows now configure typed fixed JSON, variable and bounded Mock values plus ordered transforms, with explicit disable/removal, metadata preservation and file/dynamic rejection. The first model tests failed before wiring and pass after it. Raw Body dynamic token editing remains advancedJSON; no preview/network side effects are introduced.
- Browser regression adds invalid-JSON correction, reopen persistence and real multipart header resolution after the step pre-script. Pending exact-head CI and screenshot inspection.

## Pass 67 — step Raw Body dynamic UI

- 86ae996 Actions39121144508 completed successfully with205core tests. UI artifact12133977587 SHA2569d21ebddfa50a776719f1953a21997ff9a7012b760ce49ba93a1e4a7fa9881cc verified and dynamic parameter screenshot inspected.
- Added Raw Body definition/source/format editing, cursor insertion and explicit remove-token behavior. Disabled referenced definitions reject save; draft cancellation preserves the stored definition.206local core tests pass; actual JSON body/cancel regression and screenshot await exact-head CI.
- Screenshot inspection also found the generic modal minimum height overriding the intended compact dynamic textarea. Added an ID-specific80px control rule and hide Mock-only fields for fixed/variable sources; browser checks control height and conditional visibility.

## Pass 68 — local pending browser selector correction

- bd40db8 Actions39121422604 browser stopped after the second successful plan run because the generic success-text locator matched two history records. This is a strict-selector failure, not proof of a full passing browser suite.
- Artifact12133439612 SHA2566a0248a6e95d59199077d993db941053c12d26ccb790d7f786813f36ecd76488 verified. Trace response resource0ee0a36702ce853be67906d19bc2f42ff01e0c7c.json confirms the latest run passed, and actual request body preserved the embedded quote and numeric zero. Screenshot confirms compact controls and hidden irrelevant Mock fields.
- Local test now targets the open record with this response's unique createdAt, rather than either historical success label. No product or assertion relaxation. Syntax/format checks pass; not yet pushed or CI verified. Remote validation is paused while available CI capacity is confirmed.

## Pass 69 — resumed public-repository CI and UTF-8 value bounds

- User changed repository visibility to public; connector verified it. Commit f287e7287ddb2e510f243809b80a61838c9bd6b5 passed all nine jobs in Actions39138963665, including the complete browser suite and206core tests. This closes Pass68's locator regression without weakening assertions.
- UI archive12139859472 SHA256bd80a041532e5442f222c3fe8f84b38b3d8ff5361b396c39fc8fc803ab79e44c verified. Actual Raw Body dynamic editor screenshot inspected: compact input, relevant fields, visible footer. The conflict toast is from the intentional negative-save scenario.
- Follow-on audit found runtime dynamic-value limits counted UTF-16 characters while the editor and error message specify64KiB. Added exact65536-byte Chinese text boundary and oversized Chinese/emoji fixed/variable cases; the regression failed before correction. Runtime now measures serialized UTF-8 bytes, preserving the same limit. This change awaits its own exact-head CI.

## Pass 70 — Cookie parameter precedence

- Pass69 UTF-8 correction aa28ee4c6e4cedee8469604943650fe875808c6e passed all nine CI jobs (Actions39139381051),207core tests.
- Official Cookie documentation (https://wiki.apipost.cn/docs/http/cookies/) describes explicit Cookie parameters overriding the header when configured, with the header used otherwise. Current implementation incorrectly blanked an explicit Cookie header when the parameter list contained only disabled entries; blank UI placeholder keys were also serialized.
- A new real loopback HTTP regression first reproduced the missing header. Runtime and cURL export now filter enabled, named parameters before deciding to override. The same fixture verifies exported/imported request behavior and does not change source objects. This is explicit request-parameter precedence only; automatic persistent Cookie management remains unimplemented.

## 2026-10-19: callback compatibility and visual constraints

- 96aada8: bounded setTimeout/clearTimeout, callback assertion completion and
  timer/HTTP interleaving; 216 core tests, CI39196303965 first-attempt9/9.
- 89eb0fb: Apipost-style $.ajax callback subset through the same HTTP broker;
  JSON/form/query, success/error/complete and explicit unsupported-option errors.
  220 core tests, CI39196662569 first-attempt9/9. Promise/await still unsupported.
- Current next change: visual Schema minimum/maximum/multipleOf, string lengths,
  array/property bounds, format/pattern and typed enum. Original advanced
  keywords are preserved; unchanged controls do not rewrite existing constraints.
  Invalid ranges/enum inputs keep the modal and source unchanged for correction.
  Metadata editing does not execute regexes or pretend to solve all Schema
  constraints. Full local suite221passes; browser verification pending exact CI.

Visual constraints2e82d54 passed9/9CI (run39196870875,221core tests).
The actual PNG showed the expanded form scrolling too far and obscuring the tree;
follow-up uses a bounded190px inner two-column constraint viewport and verifies
that the enum input remains above the footer.

Object sample generation now honors minProperties/maxProperties, prioritizes
required fields, fills additional properties using their schema, and rejects
conflicts. Bounds are0..1000; this remains illustrative generation, not a general
constraint solver. Reference: https://json-schema.org/understanding-json-schema/reference/object#size .
Full local suite223passes; new exact-commit CI and screenshot inspection pending.

Cookie manageree5303a passed8/9CI (run39198338208); all three core suites and
desktop packages passed. Browser creation/edit/reopen succeeded, but the new
stale-revision test mutated a separate background MCP project's jar instead of
the visible project. The fix selects the current project/environment and waits
for the reopened dialog before injecting the conflict; no assertion is removed.
The PNG also showed the privacy notice partly scrolled away after save, so the
redraw resets its scroll and the Cookie text area is compact. New visibility
assertion keeps that notice in view. Local231tests pass; exact new CI pending.
