# Bounded data-driven load tests

Decision: extend the existing isolated load runner with optional UTF-8 CSV input, without increasing request/concurrency caps. First row is unique variable names; every remaining row has the same number of string values. RFC-style comma, quoted fields, doubled quotes and multiline quoted values are accepted, along with UTF-8 BOM and LF/CRLF. Empty input means no dataset. Malformed input fails before any request is sent. Limits: 64 KiB UTF-8 input, 100 rows, 50 columns, 200-character variable names; prototype-related names rejected. No guessing delimiter or encoding, no formula execution.

Rows cycle deterministically by zero-based iteration index regardless of completion order. Values override only that iteration's runtime variables, not saved environment/global values, and are usable through interpolation/apt.getVar. Existing scope isolation, scripts, Cookie copies, timeouts, cancellation and per-script network caps remain. Results identify the one-based data row but do not repeat its contents. Dataset remains only in this page session, never project persistence or history. This is not full original load-testing parity.

Sources: https://wiki.apipost.cn/docs/FAQ/stresstestdata/ and https://wiki.apipost.cn/docs/FAQ/loadtesting/ (official general-product documentation, not proof of Offline2 exact behavior).

Fixed acceptance: quoted/BOM/multiline parsing, malformed/prototype/size/row/column rejection; real HTTP row order and per-iteration independence with concurrent execution; invalid input sends no requests; actual browser input/validation and results. Validate before implementation, then full existing suite and exact-head CI. UI must retain dataset edits across rerender and navigation without silently clearing them.
