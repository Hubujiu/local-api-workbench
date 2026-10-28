# Bounded persisted execution-result readback

## Problem and scope

A saved execution record can be larger than a transport's full-response frame,
including JSON escaping of the MCP text wrapper. The old full-result tool cannot
solve that by returning the same oversized record again. This adds only the
canonical read-only `localapi_get_execution_result_chunk`; there is deliberately
no native alias, new execution, receipt format, cache, file, or retention policy.
`localapi_get_run`, `localapi_get_execution_result`, and native wrappers retain
their existing semantics. No transport/frame or execution security limit changes.

## Contract

Required arguments are `projectId`, `runId`, and `offsetBytes`. IDs are nonempty
strings of at most 4096 UTF-8 bytes. Offsets are nonnegative safe integers.
`maxBytes` defaults to 65536, accepts integers from 1 through 262144, and is never
silently clamped. `expectedSha256` is a lowercase 64-character hexadecimal digest;
it is optional at offset zero and required at every positive offset.

The returned object has exactly these fields:

- `version: 1`, `projectId`, `runId`, `encoding: "base64"`,
  `mediaType: "application/json"`;
- `sha256`: SHA-256 of the complete serialized record bytes;
- `offsetBytes`, `chunkBytes`, `totalBytes`, `nextOffsetBytes`, `eof`, `data`.

The bytes are exactly UTF-8 `JSON.stringify(record)` for the persisted record
selected from API `history` or flow `runs`, not the API execution receipt, native
wrapper, whole project, or whitespace-preserving bytes from the history file.
The existing `findExecutionResult` rejects duplicate IDs within or across those
collections. Base64 permits a chunk boundary inside a multibyte character without
corruption; concatenate decoded bytes before decoding JSON/UTF-8.

Start at zero, retain the digest, then request each returned `nextOffsetBytes`
with that digest until `eof`. `nextOffsetBytes` is always offset plus chunk length,
including EOF. Offset equal to total returns an empty EOF chunk; offset beyond
total fails. Each call repeats project authorization, Store reload, archive check,
lookup, full serialization and hash comparison. Any record edit, disappearance,
retention eviction, ambiguity or digest mismatch fails rather than stitching two
versions. There is no pin/lease or guarantee that a long read survives retention.
Identical content restored from backup can be resumed under the new project's
separately authorized ID because the digest covers record bytes, not project ID.

Malformed parameters, offsets, hashes, missing/ambiguous records and known access
failures use fixed short errors. Unknown Store/filesystem/JSON failures map to a
fixed chunk-only error and do not disclose paths, parameter values or fragments
of the record. These new error mappings do not change other tools.

## Additional serialization limits, not streaming storage

Before allocating the serialized JSON text, a plain-data traversal checks a
32 MiB serialized UTF-8 ceiling, 200,000 visited JSON values and depth 64 (root
at depth zero). It counts keys, punctuation, control-character escaping, quotes,
backslashes, paired and lone UTF-16 surrogates accurately. The byte ceiling is
inclusive. A small control-character string can exceed it after JSON escaping.
Any size/traversal-limit failure directs the owner to the existing local project
backup/export path; this does not promise that arbitrary-size exports are safe.

The helper rejects proxies before reflection, unsupported prototypes, accessors,
cycles, functions/toJSON callbacks, symbols, nonfinite values and other non-JSON
data on direct calls. It creates an inert null-prototype snapshot before
`JSON.stringify`, preventing inherited toJSON hooks. The chunk argument validator
runs before the generic MCP `Object.entries` path, never invokes argument getters
or proxy traps, and never echoes unknown keys. This guarantee covers that helper
and the new argument validation, not arbitrary malicious Store implementations
injected into `createMCP`; real Store records are parsed JSON data. Shared lookup
and legacy tools are not broadly rewritten for injected JavaScript objects.

Store still loads the whole project and history before this guard. Property
reflection and the bounded snapshot require additional memory; every chunk again
serializes and hashes the whole selected record. This is not a streaming Store,
a whole-process memory bound, an arbitrary-size archive, or a new global record
limit. The tool does not save/append records or replay requests; existing Store
read locks and interrupted-transaction recovery remain unchanged.

The maximum base64 payload is 349,528 ASCII bytes. Tests serialize the complete
JSON-RPC/text/double-JSON envelope, including maximally escaped allowed IDs, below
420,000 bytes with a normal small request ID, well under an 8 MiB frame. Request-ID
and transport bounds remain the transport's responsibility.

## Evidence and exclusions

`execution-result-chunk.test.mjs` covers exact serialized bytes and digest,
one-byte Unicode boundaries, EOF, strict parameters, getter/proxy/toJSON traps,
cycles/non-JSON rejection, escaped-byte/value/depth preflight before stringify,
fixed storage errors, and maximum legal chunk/frame overhead.

`mcp-result-chunk-sdk.test.mjs` uses the actual official SDK HTTP and stdio clients.
An actual loopback HTTP server creates API and flow records without scripts;
expected bytes are read independently from persisted history files. It covers
reconstruction, unchanged legacy/native output, read-only grants and settled disk
contents, no network replay, project isolation, wrong offsets/digest, per-call
revocation/archive/change/duplicate rejection, actual Store retention eviction,
errors followed by usable sessions, corrupted/deleted storage, process restart,
and owner backup/export/restore with explicit authorization of the restored ID.

These are targeted local evidence, not full CI or arbitrary third-party client
compatibility. The root integration separately owns the combined bounded-stdio
oversized-writer/result/repeat chain; these PR-local tests do not claim that chain
or change its budgets. No frontend, original client, VM/XML/OOM pressure,
database, deployment or main/develop merge is involved.
