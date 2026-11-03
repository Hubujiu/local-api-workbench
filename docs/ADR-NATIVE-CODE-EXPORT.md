# Bounded native status-code definition export

This independent feature adds `settings.statusCodes` to native project definition
export. It does not depend on the parameter-description export feature and does
not change the existing importer, dictionary editor, runtime or HTTP hint policy.

## Observed format and support boundary

The lawful Offline2 plaintext bundle `work-index.js`, SHA-256
`20bb6e21fd678ead16bd91807dc9623b8cd3e7019d44ac874a167c31a37f39fb`,
provides the following static chain. Locations are zero-based character offsets
in minified line 2, not byte offsets:

- Module 127694 reads and writes `code_list` near 3382161 and 3382327.
- The project exporter reads that list near 2717129 and assigns it to
  `global.codes` near 2717476.
- The module 526737 import mapper near 3497839 retains only `code_number` and
  `code_msg`, defaulting absent fields to empty strings. Its call near 2721099
  has no project-identity argument or fresh-ID generation.
- The generic project-settings helpers in module 38091 map the list to
  `settings/code_list.json`. The existing directory adapter already implements
  that exact mapping. `codes_list` is not the observed name.

The adapter therefore emits only `{code_number, code_msg}`. It does not generate
or copy `code_id` or `project_id`, infer links, or invent deletion/editor identity.
Native interchange preserves the ordered current definitions, including numeric
versus string code types, leading zeros, case and labels. Historical provenance
is validated before projection, remains unchanged in the source project, and is
preserved by full Workbench backup. It is not a native definition guarantee.

There is no verified native field for Workbench `httpHint`. Enabled hints reject
with an explicit error. Absent and explicit-false hints are equivalent disabled
behavior and emit no extra field. An integer business code such as 409 never
implicitly enables an HTTP hint.

## Validation and serialization

Export first validates the entire ordinary dense array, each complete row and
optional provenance object. Unknown fields, symbols, accessors, custom
prototypes, proxies and malformed provenance reject without invoking accessors
or proxy traps. The pre-existing `validateErrorCodes` supplies semantic rules;
it is not treated as a complete structural validator or weakened for export.

The existing limits remain: 2000 entries, code length 128, nonblank label length
2000, string or safe-integer codes, and uniqueness of `String(code)`. Thus 200
and `"200"` conflict, but `"0007"` keeps its spelling. Missing or blank labels
remain unsupported even though the original mapper can produce empty text.
Negative zero explicitly rejects because JSON would erase its numeric
distinction. No otherwise valid number is silently converted to text.

The dictionary has no new one-MiB aggregate cap: that existing limit belongs to
the separate bulk-text parser. Native output remains limited to four MiB, and
the directory format retains its 5000-file and four-MiB limits. Error messages
direct unrepresentable definitions to full backup rather than dropping them.

The helper reimports a real JSON-serialized/parsed representation using the
existing code importer. Both public exporters also verify ordered definitions
through their complete existing import boundary before returning. They never
return partial files or mutate source settings, history, grants or other projects.

## Evidence and remaining limits

Two pure public-exporter contracts initially failed at the old unsupported
`statusCodes` guard after successful import. They then passed with this adapter,
including two JSON-serialized generations for each format. Helper and public
entrypoint contracts cover strict schema, zero getter/proxy execution, negative
zero, type and order fidelity, unchanged inputs and the existing limits.

The four saved owner HTTP contracts cover two formats, two generations,
Store persistence, full backup/restore, owner reopen, fresh-process Store
readback, unauthorized export, project isolation and atomic invalid imports and
exports of unsupported stored options. Full backup remains available for those
options without pretending native output can represent them.
Those owner contracts have not been run locally because the locked
`node-oauth1@1.3.0` dependency is absent. Exact-head CI must establish their result;
pure tests are not owner/Store/restart acceptance.

Available genuine original exports contain empty code catalogues. Nonempty test
catalogues are independently authored synthetic inputs. No original application
was executed, no original implementation was copied, and nonempty original GUI
reimport/editor behavior or full native parity is not claimed.
