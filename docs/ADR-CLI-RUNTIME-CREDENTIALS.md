# Per-run CLI protocol credentials

The existing plan runner accepts --credentials-stdin. A UTF-8 JSON document on a pipe or redirected stdin may contain grpcCredentials, socketioCredentials and protocolCredentials, keyed by the frozen plan step IDs. The existing runPlan whole-map validation remains authoritative and occurs before request execution. No target URL overrides or persisted credential fields are added.

Input is limited to 1 MiB and 30 seconds; malformed UTF-8/JSON, unknown top-level keys, invalid map shapes, interactive terminals and cancellation fail closed. Parse errors do not echo the document. SIGINT cancels an in-progress read. Without the flag, stdin is not consumed and old CLI behavior remains unchanged. Credentials are not taken from command-line arguments or new environment variables and are not stored in plan snapshots or run configuration. This is not a credential vault, and a remote server can still echo sensitive material in its ordinary response payload, which is execution evidence. The input file or producer remains the caller's responsibility.

Verification uses an actual CLI subprocess with one plan contacting three loopback services: gRPC metadata authorization, Socket.IO auth and a WebSocket Authorization header. It checks success, saved results, absence of the fixture credential in the project/result, and a subsequent uncredentialed run's rejection. Invalid input produces no extra saved run. Unit checks cover split UTF-8, invalid documents, size, timeout, abort and terminal refusal. All service values are disposable fixture data, not user credentials.

This is an independent CLI access path, not evidence of original Apipost CLI parity or native project migration.

Database grants require the separate explicit --database-stdin option described in ADR-CLI-DATABASE-GRANTS.md. It uses the same bounded input envelope and may coexist with protocol maps; --credentials-stdin alone never grants database access.
