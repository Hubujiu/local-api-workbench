> 本文记录初始严格 JSON 子集。后续 JSON5 与空正文兼容沿用同一阶段/资源/回滚边界，最新规则见 [提取 ADR](ADR-NATIVE-RESPONSE-EXTRACTION.md) 和精确提交检查点；旧语法拒绝说明不代表当前状态。

# Pre-only configured request snapshots (WIP)

Adds native `requestHeader` and `requestBody` pickVars only in the before phase.
Response sources remain after-only; disabled declarations remain inert. This is
an explicitly bounded snapshot of the initial Workbench configured request model,
not full original event/global/model or post-transport parity. Existing public
request.headers/request_bodys APIs are not changed. SDK changes later in the phase
change the outgoing request, not this snapshot. A fresh phase takes a fresh view.

## Evidence and supported subset

Original lawful static sender SHA256
`5dabd6d0b85214084895a7044f9b045bb005cb010ecec156e98cf883a914ceff`:
LF-normalized character (not byte) offsets 33593780 / 33595915 read request.headers
with trimmed lower-case expression; 33593934 / 33596555 read request.request_bodys,
try JSON5, then use trimmed JSONPath (empty means root). Destination names are NOT
trimmed for these sources. Workbench preserves raw definitions and existing
bounded single-value JSON paths but deliberately does not implement original
JSON5, arbitrary paths, header ambiguity, swallowed errors or post projections.
No original executable or proprietary code is used.

Header is enabled configured rows only: unique case-folded valid HTTP token names,
primitive string values, at most 256 rows and 64KiB data. No implicit auth, cookie,
system or generated transport headers. Missing/duplicate/reserved/invalid fields
fail closed. Body accepts nonempty raw/json strict JSON object/array roots or
unique enabled text-only urlencoded/form-data rows. Files, binary, GraphQL,
none/empty body and duplicate form fields are unsupported, not approximated.
Literal templates remain literal configured strings: no replacement, evaluation
or provider execution is performed by snapshot creation.

## Trust, resource and failure boundaries

Host own-descriptor preflight rejects getters before Worker structured cloning
could invoke them. Only requested source fields are copied; the request envelope
itself must not have accessors. Copied fields have bounded depth/nodes and an
aggregate 64KiB UTF-8 string budget. Unsupported source modes/parsing errors are
stored privately at bootstrap and raised when that source task executes, rather
than aborting unrelated source tasks. Unsafe input structure is rejected earlier.

The private VM factory is installed only if request sources are enabled. JSON
quote/escape-aware nesting inspection checks 64 levels BEFORE JSON.parse; it is
only a resource preflight, not a custom parser. Native JSON.parse is the syntax
authority. Parsed data is then checked for finite JSON values, valid Unicode,
10000 nodes/64 depth, and reserved-key rejection. Original getter/prototype tricks
and replacement public methods cannot manufacture snapshot authority.

Existing per-task row preparation and trusted completion remain. All source/row
validation precedes assignment. Native tasks share existing 250ms active/2s wall/
16MiB limits. Source snapshots are not public or shared between phases/projects.
A before-phase failure commits no scopes. A successful pre-phase commit remains
committed even if the subsequent network operation fails; an active before pick
now makes network/status/post-processing failures stop the plan, preserving the
existing strict policy for active response picks. No HTTP/disk effect rollback is
claimed. After-phase scope changes still wait for successful strict processing.

Tests cover both HTTP/1.1 and HTTP/2 import → before snapshot → SDK mutation →
unchanged snapshot/new wire → following request → frozen plan → backup/restore/
restart, project isolation, missing/invalid/later-row failure, and no-network/
failed-status strict stop. Commit-specific tests and CI, not this ADR, establish
verification. No XML specialist or engine audit is implied.
