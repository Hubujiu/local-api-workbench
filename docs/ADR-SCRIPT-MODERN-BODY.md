# Bounded modern body shortcut methods

Primary static reference: official Offline2 2.0.0 send.asar/index.js, embedded
pmapi setup at decoded character offset 28735174. The original setRequestBody
supports whole raw/form replacement, form merge, and JSON path field changes;
removeRequestBody removes JSON paths or form fields. Inspection is static only.

pm.setRequestBody / removeRequestBody now offer a bounded implementation.
Apipost8 apt uses these methods; legacy apt retains its literal-key/object-only
behaviour. The compatibility-mode warning explicitly includes these request
shortcut differences. This remains an opt-in subset, not the complete SDK.

- Whole raw input accepts a string or serializable JSON object/array. Objects
  become JSON. A string in existing JSON mode retains that mode only if valid;
  otherwise it becomes raw text. No Content-Type-based form inference is made.
- JSON field paths use the bundled lodash parser with at most 32 segments and
  1024 path characters; numeric segments are limited to 999. Prototype-related
  names are rejected, and non-index array properties are rejected rather than
  silently disappearing during serialization. An existing literal dotted key
  takes precedence. Array slot removal preserves indices and serializes holes
  as null. Unsupported modes and invalid JSON fail explicitly.
- JSON changes are staged on parsed copies and committed only after UTF-8 and
  output validation. Body input/output is at most 64KiB for these shortcuts.
  One field with null is rejected because the vendor overload interprets it as
  whole-body input; use whole JSON object replacement to express JSON null.
- Form whole replacement accepts a text-valued object, clears by default, and
  accepts an explicit false third argument with undefined second argument for
  merging. Two-argument field changes stringify the non-null value. Same-name
  text rows are replaced and enabled, and unrelated rows retain their order.
- Form changes reuse the existing 1000-row/64KiB-value/256KiB-total validator and
  validate the whole candidate before commit. Merging cannot overwrite selected
  files with text. Unrelated file references retain their bytes; explicit whole
  replacement or field removal can remove a selection. No file paths or new
  file contents are accepted. Invalid maps cannot partly change earlier rows.

All operations keep the existing VM, phase time, output and network budgets.
They do not execute a request or alter saved definitions. Complex vendor
coercions, nontext form-map values, arbitrary prototype paths, and unsupported
modes are rejected, not treated as successful no-ops. This is not an unrestricted
lodash setter or a host/file bridge.

Regression covers both dialects, nested arrays/objects, literal keys, null
ambiguity, UTF-8 bounds, file preservation/removal, atomic map failures and raw
language transitions. Browser and packaged-runtime cases require exact-head CI;
local tests alone do not prove those integrations or original migration parity.
