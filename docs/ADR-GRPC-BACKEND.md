# gRPC backend execution and persisted evidence

## Implementation reuse and scope

Use the maintained Apache-2.0 `@grpc/grpc-js@1.14.6` and `@grpc/proto-loader@0.8.1`, with BSD-3-Clause `protobufjs@7.6.6`, rather than reimplement HTTP/2 framing, Protobuf encoding, TLS or streaming. Original-application static inspection identified schema discovery, reflection and request/stream entrypoints; that is feature evidence, not proof of runtime equivalence. The older public Apipost wrapper remains a reference, not an unreviewed dependency replacement.

This backend milestone supports inline Proto, explicit in-memory file bundles and Protobuf JSON schemas, plus all four RPC styles: unary, server stream, client stream and bidirectional stream. Reflection supports v1 and v1alpha discovery. It does not yet implement native Apipost gRPC project migration, interactive long-lived streaming, a frontend, or gRPC-plan scripts and request-scoped credential injection. Arbitrary filesystem/network proto imports are not permitted. These remain explicit delivery gaps.

## API and persistence

- POST `/api/projects/:id/grpc-schema`: inspect `proto` with optional `files` and `protoName`, or a Protobuf JSON `schema`, without connecting.
- GET/POST/DELETE `/api/projects/:id/grpc-definitions`: list, upsert a complete definition, or remove one by ID. Definitions contain ID, name, explicit grpc/grpcs target, one schema source, optional service/method and timeout only; metadata and TLS credentials cannot be saved there.
- POST `/api/projects/:id/grpc-run`: select a saved `definitionId`, optional service/method/timeout, messages, metadata and request-scoped TLS material. A run ID may be supplied for the existing cancel API. Concurrent reuse is refused. There is no connection merely from importing or saving a definition.
- POST `/api/projects/:id/grpc-reflection`: list services or retrieve a selected service schema from an explicit target, with request-scoped metadata/TLS and optional cancel run ID. Discovery does not automatically save a definition.
- GET `/api/projects/:id/grpc-runs`: return the last 50 protocol records for this project. Existing local-token and Origin checks protect these APIs.

Each record has its own identity, definition snapshot/hash, request JSON, actual status/messages, duration and success/failed/cancelled classification. Transport metadata, trailers and TLS material are omitted from persisted records; response payloads or server error text can still contain application data. Files remain under the existing private local project storage. Configuration saves preserve concurrent protocol activity; project fingerprinting excludes history. Backup restoration preserves definitions and records, and deleting a definition does not erase prior evidence.

If recording fails after the RPC, return the actual result with `recordSaved:false`, no record ID and a persistence error. Never replay the network operation to repair storage. A deadline, connection loss or cancellation does not prove that the remote service rolled back a mutation. No application retry loop is added; the client retry policy is disabled.

## Limits and validation

Targets are explicit `grpc://host:port` or `grpcs://host:port`, without URL credentials, paths, queries or alternate resolver schemes. TLS verification stays enabled; custom CA and paired client certificate/key are request-scoped. There is no insecure-verification flag or hostname override. Environment HTTP proxies are not implicitly used.

Each Proto text is at most 64 KiB, with up to 32 explicitly supplied files and 256 KiB total source bytes. Virtual names are canonical relative `.proto` paths; imports resolve only within the provided bundle or trusted bundled Google types. No library filesystem/network fallback is used. Relative imports cannot escape the virtual root; cycles terminate and unused files stay explicit. JSON schemas are separately bounded to 256 KiB and cannot be mixed with textual sources. Compiled structure has at most 1000 methods and an eight-schema cache. Inputs use only own declared fields (not inherited Object members), strict scalar types, required-field presence, finite numbers, exact decimal strings for large 64-bit integers and canonical base64 for bytes. Unknown/prototype-sensitive fields and malformed Unicode fail before connection. The official loader preserves field case and returns 64-bit integers, enums and bytes without lossy JSON numeric conversion.

The HTTP coordinator admits at most five active gRPC calls; cancellation, failure and successful completion release the slot. Each call has a 50–30000 ms deadline, at most 100 input/output messages and 1 MiB request/response payload budgets. Unary and server-streaming calls take exactly one request message. Metadata has bounded entries/bytes; output limits cancel the stream and return RESOURCE_EXHAUSTED with truthful partial evidence. Every terminal path closes the client and removes its cancellation listener/timer. HTTP records are JSON-level evidence, not packet captures.

## Acceptance

Real local gRPC fixtures independently use the official loader/server. Tests exercise all four call styles, metadata, 64-bit precision, binary fields, remote error codes, deadlines, explicit cancellation, response overflow, strict TLS/mTLS, invalid schemas/values, project isolation, persisted definition/run reload, backup restoration, concurrent activity preservation, definition deletion and storage-failure non-replay. No user service, user credentials or original application process is involved. Existing browser and desktop checks remain regression gates, not new frontend work.

References: [grpc-js](https://github.com/grpc/grpc-node/tree/master/packages/grpc-js), [proto-loader](https://github.com/grpc/grpc-node/tree/master/packages/proto-loader), [protobuf.js](https://github.com/protobufjs/protobuf.js).

## Reflection discovery boundary

Reuse the Apache-2.0 v1/v1alpha IDLs distributed by @grpc/reflection 1.0.4, preserving the vendor license. The official reflection server package is a test-only dependency; runtime transport and descriptor conversion use the existing grpc-js/protobuf.js libraries. Only an explicit RPC UNIMPLEMENTED result permits a v1-to-v1alpha protocol negotiation. Permission denial, authentication errors and embedded reflection errors are not bypassed. List-only completion does not imply all server schemas were retrieved.

One overall deadline and the shared five-call coordinator cover discovery. Limit exchanges to 32, descriptors to 32 files and 256 KiB received bytes; reject conflicting files, traversal/absolute names, unsupported syntax and unsafe declarations. Missing dependencies are queried only by validated proto names at the same authorized server, never fetched from a URL or disk. No business RPC is invoked during discovery. Return the last call status and a failure stage separately from client-side descriptor/limit failures. An error_response with a zero or invalid status must not become a successful result.

Acceptance includes real service reflection, explicit v1alpha negotiation, denial without fallback, malformed/oversized descriptor rejection, overall timeout, pre-cancellation, saving/executing/restoring the reflected schema, and a real multi-file service using a trusted Timestamp definition. The old single-file backend and shared concurrency/authorization regressions remain required.

## Frozen plan execution and MCP

A plan can contain a discriminated `type: "grpc"` step alongside HTTP steps. Its `grpc` field contains a frozen complete `definition` and bounded `messages`; saving through the HTTP/MCP plan API also accepts a project-local `definitionId`, resolved immediately into that snapshot. Later deletion or changes to the source definition do not change saved execution. The target and schema are not interpolated; only message values use existing scoped variables. Unknown fields, scripts and saved TLS/metadata credentials are rejected instead of silently dropped.

HTTP plan execution, authorized MCP flow execution and the explicit CLI runner supply the gRPC executor. A bare `runPlan` caller without that capability gets a failed step before any connection. MCP adds read-only definition summary/detail tools; existing project allowlists and write-plus-execute gates remain in force. HTTP executions and HTTP-hosted MCP share the existing five-call gRPC coordinator; standalone MCP also bounds its own dispatcher's calls to five. HTTP plan run IDs cannot overwrite an active controller. Cancellation propagates to the transport and frees the slot.

Records retain native `grpcResult.status.code` and messages, not fabricated HTTP 200 responses. Expected gRPC status defaults to 0, independently of the HTTP strict-200 policy. Explicit status expectations, JSON message assertions and message extraction into runtime/environment/global variables use existing evaluators. Failed assertions do not export values; failed extraction marks the step failed while preserving actual transport evidence. No raw metadata/trailers or TLS material is persisted by these steps. Application messages and extracted variables remain part of local execution evidence.

The ordinary plan history stores the complete snapshot and per-step evidence. HTTP/MCP/CLI report `recordSaved:false` and the storage error if persistence fails after execution, without replaying network effects; CLI also exits nonzero. A successful RPC is not mislabeled as a transport failure solely because storage failed.

Acceptance exercises real gRPC → extraction → real HTTP, MCP save/execute/reload/backup and project isolation, concurrent variable isolation, remote refusal and expected native status, cancellation and run-ID collision, a real CLI child process, malformed input rejection and injected storage failure with exactly one observed remote invocation. Per-step gRPC scripts and authenticated-plan credential injection remain explicit unsupported capabilities, not implicit fallbacks to HTTP.
