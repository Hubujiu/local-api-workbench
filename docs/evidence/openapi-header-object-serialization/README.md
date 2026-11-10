# Header object serialization evidence

Original implementation base: PR #161 `71e2bb69d912d2b8a5e0952b3e80c273ab9275be`.
Current stacked base: PR #163 `b3267a9b644f377ab6a3e1046828bb1099cb4bf3`,
including PR #162 `9662c161d7e05b3ad5f62829e3db945683749a6b`.
Local isolated branch: `feat/openapi-header-object-serialization`.

- Initial five new pure tests failed on the unchanged base because supported
  Header object serialization was refused. `initial-red.output.txt` preserves it.
- Initial implementation passed those same five tests.
- Expanded related suite passed 140/140, with zero failures, skips or cancelled
  tests. This includes new pure, real wire and native-boundary tests plus existing
  Query arrays, scalar values, Path serialization, dynamic values, MCP input,
  global parameters and script Header regressions. `regression.output.txt`
  preserves the final output.
- The five new workflow tests actually ran locally: owner/CLI/official MCP SDK
  HTTP+stdio, Store/frozen/backup/restart, dynamic/script changes, atomic failed
  imports, HTTP/1.1 and HTTP/2, and the real curl executable. No workflow is
  counted as passed based only on syntax checking.
- Independent review found no blocking issue and separately ran 5 new codec
  tests and 28 existing Header/script/query-array tests. Later limit, accessor,
  empty-wire, native frozen boundary and duplicate OpenAPI cases are covered by
  the final related suite.
- An intermediate regression run had two test-fixture failures because the new
  native-export fixture omitted its project ID. The fixture was corrected and
  both tests then passed; no production runtime fix was needed for those failures.
- `npm run check`, full `npm run format:check`, and `git diff --check` pass.
- Full local `npm test` completed with exit code 0: 5723 tests, 5722 passed,
  zero failed/cancelled, one skipped, in 1227388 ms (about 20m27s). The only skip
  is the existing Go code-example wire test because this host has no Go
  toolchain. All new Header object tests executed and passed.
- The source code remained unchanged for that full run and matches commit
  `2eb346a2c9248021a10f9a5e834361e178f30170`. The exact summary, skipped-test line
  and full-output SHA256 are in `full-suite-summary.output.txt`.
- The full local run above belongs to the original PR161-based implementation,
  not the new PR162 combination. The latter is separately checked below.

## PR162 combination verification

The rebase had no text conflicts, but a new combined regression reproduced a
semantic conflict: PR162 converts const plus enum into enum plus allOf, which
the Header codec previously rejected on reimport. The new admission exception
only permits closed enum-only allOf entries beneath an explicit supported type.
Root and property constraints survive export/reimport without widening the
serialized value shapes. General allOf/compositions remain unsupported.

- New combination RED: 10/11 pure cases pass, one fails on Header reimport.
- Corrected combined suite: 181/181 pass, zero fail/skip/cancel. It includes the
  new root/property/dictionary/negative cases, generated-conjunction capacity,
  accessor/sparse-array admission, real owner export/reimport/restart/wire,
  both PR162 owner/MCP workflows, and previous Header/Query/Path regressions.
- Syntax, whole-repository formatting and whitespace checks pass.
- Remote cross-platform CI, browser smoke and package verification are pending
  for this exact combination. No full-product delivery claim is made.

## PR163 combination verification

The Header changes were rebased onto PR163 with no text conflicts or overlapping
files. Independent review confirmed that the Redis/SSH/database changes and the
PR162 schema exporter remain intact, as do all Header combination regressions.

- Expanded combined suite: 345/345 pass, zero fail/skip/cancel, in 57.3 seconds.
  It runs all OpenAPI unit/workflow tests, dynamic values, MCP request input,
  global parameters, script Header readers/entries, all Redis unit/workflow
  tests, database SSH, and MCP stdio database grants. This includes actual
  loopback SSH/RESP/TLS, cancellation and uncertainty cases, not only syntax.
  Output is preserved in `pr163-combined-green.output.txt`.
- `npm run check`, whole-repository `npm run format:check` and
  `git diff --check` pass on this base.
- Remote cross-platform CI for the final published head is pending. The full
  local run remains the original PR161-based run described above.

See [the design and remaining Cookie/allowReserved plan](../../ADR-OPENAPI-HEADER-OBJECTS.md).
Only the new headerSerialization presence guard modifies native export code.
No blocked ADR/export integration changes or cancelled multipart changes were
included or reconstructed. No merge or deployment was performed.
