# Native HTTP-only flow and result projection

Work in progress in existing native MCP PR16. This fixes a representability gap,
not a new protocol adapter, tool schema, recursive delete or execution engine.
Canonical protocol/gRPC/Socket.IO tools remain available and unchanged.

## Problem and existing contract

The native flow view uses target_id/api_snapshot/pre_script/post_script from
step.request (or its nativeMCP HTTP provenance). Canonical non-HTTP steps store
payload in step.protocol/grpc/socketio instead. The old native execute alias
could enter those executors and then return a summary missing their identity
and payload. A successful canonical run does not make that native projection
faithful. Reject before execution, not after network activity or history save.

## One shared boundary

Native list/detail/update/execute validate every plan step, including disabled
and mixed steps. Steps must contain an HTTP request object and have absent/http
type. Explicit protocol payload/result markers, nested steps and repeat metadata
reject. Native name-only updates validate the previous plan before copying or
versioning it; new native plans remain HTTP references through the existing
builder. Confirmed opaque flow deletion does not project/execute steps and keeps
its existing behavior. No new restriction is applied to canonical consumers.

Native result/detail/history checks the complete snapshot when steps exist and
all explicit protocol discriminants in results or a single API record. Check
filtered history before pagination; never silently omit unsupported records.
Do not recursively treat response.protocol (HTTP version), body fields or auth
type as a step discriminator. All rejection errors are fixed, without source
names, credential fields or protocol payloads.

Existing sparse legacy histories may lack snapshot/request identity. They keep
their existing counts and original data when no incompatible evidence is present;
this is not proof of an HTTP identity and never fabricates missing target IDs.
Full explicit non-HTTP evidence cannot be laundered by removing only snapshot or
type. Ordinary HTTP evidence, HTTP transport failures and persistence receipts
remain supported. Root retains existing canonical repeat rejection/messages
before applying this independent guard; PR16 does not acquire a root dependency.

## Acceptance

Pure eligible/invalid/disabled/mixed/legacy/snapshot/result matrices, plus actual
official SDK HTTP and stdio workflows. Native rejected reads/updates/execution
must preserve source plans, versions, history and peer request counts. Canonical
reads and real protocol execution remain positive controls. Cover project and
read/write/execute grants, backup/restore/reopen, native HTTP success and existing
result receipts. Require exact feature/root CI and current portable evidence.
No budget changes, external account access, original runtime execution, new
license, frontend, merge or deployment is involved.
