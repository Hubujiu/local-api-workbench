# gRPC unary workbench

This vertical slice exposes the existing gRPC backend to a person using the workbench. It is not full streaming GUI support and does not replace SSE/WebSocket/TCP. Saved gRPC definitions become discoverable, with explicit target, schema source, service/method, editable generated JSON, save, send, cancel and typed results.

## Network and data boundary

- Parsing explicitly supplied Proto text/files and generating a request example are local schema operations. Imports resolve only within the explicit virtual file bundle and trusted bundled Google types, never arbitrary disk paths or remote URLs.
- Reflection is a separate explicit network action against the displayed target. Listing services is not retrieval of their schemas; retrieving a chosen service schema is another explicit action. Neither runs a business method. No startup/reload/selection automatically reflects or sends.
- Unary calls require an explicitly saved definition and a unary method. Stream methods remain visible as unsupported here and cannot be sent through this UI. Generated examples are editable JSON, not a claim of a complete schema-aware field form.
- Runtime metadata and TLS CA/client certificate/key are temporary to the current panel, never fields of a saved definition, backup or ordinary project save. TLS verification cannot be disabled. Leaving the panel clears those runtime inputs.
- Request and response messages, definition snapshots and remote error text may contain application secrets and **are persisted in gRPC execution history** by the backend. Only transport metadata/trailers and TLS material are omitted from stored records. The UI must not imply that all request/response data is ephemeral or redacted.

## Results, ownership and cancellation

Actual gRPC status and message evidence remain distinct from the execution-record save receipt. A successful RPC with recordSaved:false is not relabelled a transport failure. No request is automatically replayed to repair a missing response or persistence failure.

Cancellation is a request, not proof of remote rollback. In the existing backend, cancel arriving before a run ID is registered can miss the task even though the cancel endpoint returns 200. Only the original run's terminal status establishes its observed local cancellation; a remote mutation may already have occurred. Lost responses and stale views remain explicitly uncertain, with no automatic resend.

Definition persistence uses the existing project save/CAS/reconciliation path rather than introducing an independent unversioned writer. Ordinary unsaved project drafts are not automatically saved as a side effect. UI project/view/input generations protect newer draft values from late parsing, reflection, example, save and RPC responses.

## Acceptance

Use disposable loopback gRPC and reflection fixtures only. Cover saved/reloaded Proto definitions, service/method selection, generated request editing, actual unary response/error/cancellation, temporary credential isolation, clear persistence receipt, no automatic calls and stale-view behavior. Browser and desktop acceptance must execute on the exact candidate CI; callback or backend tests alone do not prove the GUI journey ran. Do not log fixture credential/URL/payload values on assertion failure. No merge or deployment is implied.
