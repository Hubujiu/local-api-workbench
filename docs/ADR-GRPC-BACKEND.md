# gRPC backend execution and persisted evidence

## Implementation reuse and scope

Use the maintained Apache-2.0 `@grpc/grpc-js@1.14.6` and `@grpc/proto-loader@0.8.1`, with BSD-3-Clause `protobufjs@7.6.6`, rather than reimplement HTTP/2 framing, Protobuf encoding, TLS or streaming. Original-application static inspection identified schema discovery, reflection and request/stream entrypoints; that is feature evidence, not proof of runtime equivalence. The older public Apipost wrapper remains a reference, not an unreviewed dependency replacement.

This backend milestone supports inline Proto service/method discovery and all four RPC styles: unary, server stream, client stream and bidirectional stream. It does not yet implement server reflection, external/multi-file proto imports, native Apipost gRPC project migration, interactive long-lived streaming, a frontend, or MCP/plan gRPC steps. Unsupported imports fail before any filesystem or network read. These remain explicit delivery gaps.

## API and persistence

- POST `/api/projects/:id/grpc-schema`: inspect an inline `proto` without connecting.
- GET/POST/DELETE `/api/projects/:id/grpc-definitions`: list, upsert a complete definition, or remove one by ID. Definitions contain ID, name, explicit grpc/grpcs target, inline proto, optional service/method and timeout only; metadata and TLS credentials cannot be saved there.
- POST `/api/projects/:id/grpc-run`: select a saved `definitionId`, optional service/method/timeout, messages, metadata and request-scoped TLS material. A run ID may be supplied for the existing cancel API. Concurrent reuse is refused. There is no connection merely from importing or saving a definition.
- GET `/api/projects/:id/grpc-runs`: return the last 50 protocol records for this project. Existing local-token and Origin checks protect these APIs.

Each record has its own identity, definition snapshot/hash, request JSON, actual status/messages, duration and success/failed/cancelled classification. Transport metadata, trailers and TLS material are omitted from persisted records; response payloads or server error text can still contain application data. Files remain under the existing private local project storage. Configuration saves preserve concurrent protocol activity; project fingerprinting excludes history. Backup restoration preserves definitions and records, and deleting a definition does not erase prior evidence.

If recording fails after the RPC, return the actual result with `recordSaved:false`, no record ID and a persistence error. Never replay the network operation to repair storage. A deadline, connection loss or cancellation does not prove that the remote service rolled back a mutation. No application retry loop is added; the client retry policy is disabled.

## Limits and validation

Targets are explicit `grpc://host:port` or `grpcs://host:port`, without URL credentials, paths, queries or alternate resolver schemes. TLS verification stays enabled; custom CA and paired client certificate/key are request-scoped. There is no insecure-verification flag or hostname override. Environment HTTP proxies are not implicitly used.

Proto text is at most 64 KiB, with bounded structure, at most 1000 methods and an eight-schema cache. Inputs use declared fields, strict scalar types, required-field presence, finite numbers, exact decimal strings for large 64-bit integers and canonical base64 for bytes. Unknown/prototype-sensitive fields and malformed Unicode fail before connection. The official loader preserves field case and returns 64-bit integers, enums and bytes without lossy JSON numeric conversion.

The HTTP coordinator admits at most five active gRPC calls; cancellation, failure and successful completion release the slot. Each call has a 50–30000 ms deadline, at most 100 input/output messages and 1 MiB request/response payload budgets. Unary and server-streaming calls take exactly one request message. Metadata has bounded entries/bytes; output limits cancel the stream and return RESOURCE_EXHAUSTED with truthful partial evidence. Every terminal path closes the client and removes its cancellation listener/timer. HTTP records are JSON-level evidence, not packet captures.

## Acceptance

Real local gRPC fixtures independently use the official loader/server. Tests exercise all four call styles, metadata, 64-bit precision, binary fields, remote error codes, deadlines, explicit cancellation, response overflow, strict TLS/mTLS, invalid schemas/values, project isolation, persisted definition/run reload, backup restoration, concurrent activity preservation, definition deletion and storage-failure non-replay. No user service, user credentials or original application process is involved. Existing browser and desktop checks remain regression gates, not new frontend work.

References: [grpc-js](https://github.com/grpc/grpc-node/tree/master/packages/grpc-js), [proto-loader](https://github.com/grpc/grpc-node/tree/master/packages/proto-loader), [protobuf.js](https://github.com/protobufjs/protobuf.js).
