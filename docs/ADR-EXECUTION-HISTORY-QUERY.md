# Execution-history queries

## Behavioral evidence and scope

Static inspection of the official Apipost Offline 2.0.0 MCP catalog identifies
API/flow, origin, status, and bounded recent-record filters. This is behavioral
reference only; no proprietary implementation is copied. Tool names and camelCase
arguments remain Local API Workbench contracts, not a claim of wire compatibility.

## Contract

- `localapi_list_execution_runs` combines persisted API history and flow runs,
  newest completion timestamp first, default 20 and maximum 50 records.
- Optional `scope`: `api` / `flow`; `source`: `manual` / `mcp` / `cli` / `unknown`;
  `status`: `passed` / `failed` / `cancelled`; `planId` applies only to flow runs.
  Filters combine with AND. Invalid enum values and non-integer/out-of-range
  limits fail instead of silently broadening the query.
- `manual` identifies the ordinary local HTTP execution route, not proof of a
  human operator. MCP and CLI entry points stamp their own origin. These values
  are descriptive metadata, never an authorization boundary.
- Historical records without trustworthy origin remain `unknown`. Missing or
  invalid historical timings are omitted, never invented as zero.
- New `durationMs` measures monotonic elapsed execution time, including scripts
  and steps but excluding persistence. It is not a sum of HTTP response timings.
- Summaries retain identifiers, names, status, completion time, available timing,
  total failed-step count and at most five failed-step identifiers/names/statuses.
  They never include requests, responses, variables, logs or assertion messages.
- `localapi_get_execution_result` can retrieve either persisted record kind.
  Duplicate IDs across collections fail explicitly rather than selecting the
  wrong artifact. Legacy `localapi_get_run` remains flow-only.
- Canonical `localapi_get_execution_result_chunk` supplies bounded, digest-pinned
  persisted-record readback; see [chunk contract and limits](ADR-MCP-EXECUTION-RESULT-CHUNKS.md).
- Existing project grants, read/write/execute capabilities and transport checks
  are unchanged. Storage retention bounds still apply; this is not a new archive
  or pagination system.

## Verification

Pure summary tests cover ordering, combined filters, output bounds, redaction,
legacy uncertainty and ambiguous IDs. Existing HTTP, CLI and official MCP SDK
transport tests exercise actual record creation, provenance, full API detail
retrieval, invalid limits and project isolation. Full regression and CI evidence
must be checked for each published revision, not inferred from this ADR.
