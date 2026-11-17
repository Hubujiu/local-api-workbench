# Selective document import retains metadata dependencies

Baseline: PR #157, `c462071dd822aedf059119151d36e1e9ba9df808`.
Regression: `tests/manual-import-document-metadata.test.mjs`.

The unchanged baseline passed preview and applied a selected native document,
but omitted the status registry owning its `statusId`. A fresh Store reopened
the imported document with no resolvable status name. This was reproduced for
modern JSON and directory inputs through both owner HTTP and the official MCP
SDK HTTP transport. All four workflows failed their persisted `Ready` lookup,
not an invented API or unsupported native shape. The complete final regression
was 0/7 on baseline (`red.output.txt`) and is 7/7 after the fix
(`green.output.txt`). Trailing whitespace is removed from captured output only.

The source graph now inventories document `statusId` and attribute keys as typed
references, using the same resolver and dependency closure as request metadata.
Their registry owner must be selected transitively; explicit exclusion rejects,
and conflicting existing registry definitions block without a commit token.
The current atomic globals bundle is deliberately unchanged: selecting one
status may bring its complete configuration bundle, which remains visible in
the preview. This does not add selective per-status merging or grant execution.

Plain document body text is inert. Literal identifiers, JSON-shaped text and
template syntax do not create metadata references or pull globals into a
document without actual metadata. Attribute tests cover canonical source-graph
ownership; no new proprietary document-attribute representation is enabled.
Already damaged imports are not guessed or repaired without their source.

Tests cover typed and dangling references, literal preservation, both native
input formats, both real HTTP entrypoints, read-only preview, signed apply,
existing and unselected document/API isolation, project isolation, Store reopen,
backup restore, exclusion/conflict atomicity and zero fixture requests during
import. Independent source/planner/new-suite review passed 51/51 with no blocking
findings. Syntax, whole-repository formatting and diff checks passed.

These local results do not substitute for this new commit's complete CI and
portable-artifact verification. No original application, proprietary service,
restricted export integration, merge or deployment was performed.
