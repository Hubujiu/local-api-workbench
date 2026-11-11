# Isolated real database TLS acceptance

This is a CI acceptance fixture, not a product networking or permission change.
The existing database-integration job and its ten-minute deadline remain intact.
Its original PostgreSQL, MySQL and Redis services are not reconfigured or stopped.

`scripts/ci/database-real-tls.sh setup` inspects those service containers for their
exact image IDs and creates six additional fixtures using `--pull=never`: one
trusted identity and one deliberately wrong SAN identity for each engine. No new
image, package install, license-selection flag, real database or external account
is involved. Host publications are exclusively `127.0.0.1` with assigned ports.
The existing images' entrypoints initialize fresh disposable data. Cleanup removes
only recorded fixture IDs and their anonymous volumes, not the original services.

OpenSSL creates a fresh one-day test CA, unrelated wrong CA, and signed server
certificates. CA signing keys are deleted before any container starts. Containers
receive only server keys/certificates, public CA and synthetic configuration in a
read-only mount; server keys are copied to a per-container tmpfs with owner-only
permissions. No system trust store is changed. Do not upload this directory or raw
container logs as artifacts. `image-ids.txt` records the exact reused identities
locally; test output uses bounded stage labels, never driver errors or PEM data.

PostgreSQL requires hostssl/SCRAM for TCP; local socket trust is exclusively for
isolated bootstrap. MySQL requires secure transport and its reader account requires
SSL. Redis disables the plaintext TCP port, disables the default account and uses
explicit ACL accounts. `tls-auth-clients no` means server-authenticated TLS plus
password authentication, not mutual TLS; certificate verification stays enabled in
the application. Privileged fixture accounts only seed data over container-local
sockets. Product requests use a separate read-only synthetic account.

The explicit integration entrypoint checks actual table/key reads, missing and wrong
CA rejection, wrong-host identity rejection, plaintext rejection, bad-password
rejection, and a healthy trusted read after every negative case. It also checks
PostgreSQL's current session SSL flag and MySQL's nonempty session TLS cipher.
Each engine is queried through the real owner HTTP database endpoint as well.
No skips, mock drivers, relaxed verification or production budget changes are used.
The orchestration contract test uses a recording Docker double and real OpenSSL;
its success is NOT evidence that the databases ran or accepted TLS.

Readiness has a shared 120-second setup limit and bounded socket probes; PostgreSQL
and MySQL PID 1 must be their final server, not the temporary initialization server.
Setup failure attempts cleanup, and an `always()` workflow step repeats cleanup.
Runner termination is still a CI platform boundary, not a guaranteed cleanup hook.

## Validation status before review

The development cloud host has no Docker/database servers. Only syntax, formatting,
YAML shape, mocked orchestration/cleanup, certificate issuance and existing local
regressions can be checked there. Real-service execution remains **unrun** until a
reviewed CI candidate executes. No CI was dispatched by preparing this change.
This first slice does not claim MCP/CLI, mTLS, SSH or cancellation acceptance against
these real TLS fixtures; existing separate tests are not relabeled as that evidence.

## Plaintext rejection oracle

A generic EOF/reset never proves PostgreSQL or MySQL transport policy. PostgreSQL
must return SQLSTATE 28000 identifying HBA refusal for an unencrypted connection;
MySQL must return ER_SECURE_TRANSPORT_REQUIRED / 3159. Setup independently checks
PostgreSQL SSL and reject HBA rules, MySQL require_secure_transport, and Redis live
CONFIG GET port/tls-port on both good and wrong-SAN fixtures before publishing a
bounded policy receipt. Redis's TLS-only listener may close plaintext without an
application response; that closure is accepted only together with its live disabled
plaintext port / enabled TLS port evidence and a successful authenticated TLS read.
Unit tests reject generic SQL resets/EOF, authentication errors, missing policy
evidence and unreachable/timeouts. Mock orchestration also injects a policy-check
failure and checks cleanup; it remains explicitly not real-service evidence.
