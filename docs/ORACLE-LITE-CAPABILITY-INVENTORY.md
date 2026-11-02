# Oracle Free Lite capability inventory (WIP, not acceptance)

This is a separate, bounded evidence collector for the **already approved exact
Lite image**, not an Oracle runtime test. The previous fixed-path preflight did
not inventory Java, PKI JARs, `mkstore`, or wallet metadata. Its failure alone
cannot establish that the Full image is required.

The only image reference in the collector is:

```text
container-registry.oracle.com/database/free:23.26.3.0-lite-amd64@sha256:770ca58ab319d8cfde610b0db25c06899ce0af9591c4addfa10d2cb8f0318e65
```

## Publication and execution boundary

- Save/review code first on **`wip/oracle-lite-inventory-code`**. That branch does
  not trigger the inventory.
- The new workflow has only an ordinary `push` trigger for the exact branch
  **`wip/oracle-lite-capability-probe`**, plus an identical job guard. It has no
  PR, dispatch, schedule, service container, or reusable-workflow trigger.
- Only the parent task publishes the first probe branch after independent review.
  No local Docker/image pull/container/Oracle/Java/build/runtime test is part of
  preparing this change. Pure parser/validator fixtures may run only after an
  independent closure audit; syntax/format checks do not execute the collector.
- The runner is standard GitHub-hosted `ubuntu-24.04`. Both guards require
  `Hubujiu/local-api-workbench` (repository ID `1423306754`); Python additionally
  requires GitHub-hosted Linux and the exact push ref. No remote Docker context,
  new license acceptance, login, mirror, image fallback, or package install exists.

## Read-only containment

The host collector is Python standard library only. It uses a fresh, empty Docker
config, a minimal host environment, and the explicit local
`unix:///var/run/docker.sock`. It rejects configured daemon registry mirrors.
Selected Docker info supplies a disk preflight: at least 20 GiB before pulling;
after pulling, at least image-size + 2 GiB before a possible image-volume copy.
Images larger than 16 GiB are rejected. No other image is pulled or built.

One uniquely named/labeled container uses UID:GID `65534:65534`, `--read-only`,
network `none`, IPC `none`, working directory `/`, no restart policy, no ports, all capabilities dropped,
`no-new-privileges`, 256 MiB memory+swap ceiling, one CPU, 32 PIDs, no core dumps,
64 open files, no healthcheck, and no Docker log storage. No host directories,
repository code, sockets, credentials, or secrets are mounted into it.

Docker image-declared volumes require special care: `--read-only` alone would
not make them read-only. Only at most four canonical `/opt/oracle/...` volume
non-overlapping destinations are accepted (no ancestor/descendant volume copies). Each receives a **source-less new anonymous read-only
volume view** with explicit `volume-driver=local` and no driver options,
populated by Docker from the image, not from any existing named
volume or host source. Before creation, the collector snapshots existing volume
names. Selected actual container inspection must prove the requested mounts are
source-less, every actual mount is an expected read-only volume, and every actual
volume name is newly created. No file bytes from volume population are exported.

Before starting, actual inspected image identity, entrypoint/command, UID,
network, capabilities, security options, resource limits, healthcheck, and mount
set must match. No raw `Config.Env` values or host mount `Source` is emitted or
dumped. A filtered inspect template reports only selected initialization-hook
key names and cleared booleans, never their values.
At container creation, `BASH_ENV`, `ENV`, `LD_PRELOAD`, `LD_AUDIT`,
`LD_LIBRARY_PATH`, and related loader/locale hook variables are explicitly set
empty. Each must be verified cleared before start, including before the initial
`/usr/bin/env` dynamic loader runs. The image entrypoint is overridden by
`/usr/bin/env -i`, which clears all remaining image environment and launches only the
image's `/bin/bash --noprofile --norc` with the literal reviewed shell script.
That script executes only `/usr/bin/find` and `/usr/bin/sha256sum` plus shell
builtins. It never invokes Java, `orapki`, `mkstore`, configuration scripts,
Oracle entrypoints, listeners, SQL, or a database. The inherited image healthcheck
is explicitly disabled and verified as `Test: ["NONE"]`, preventing an Oracle
healthcheck from launching database programs during inspection. This does not
disable or weaken healthchecks in the separate real TCPS acceptance fixture.

Cleanup is in `finally`: only this unique labeled container and its proven-new
anonymous volumes may be removed. If volume ownership cannot be proved, remove
only the owned container and report cleanup unconfirmed. A final bounded volume
listing confirms owned anonymous volumes disappeared. No pruning, removal of old
CI evidence, or deletion/replacement of prior artifacts occurs.

## Evidence and bounds

Fixed prefixes are `/opt/oracle`, `/usr/lib/jvm`, `/usr/lib64/jvm`, `/usr/java`,
`/usr/share/java`, `/etc/oracle`, `/etc/pki`, `/usr/bin/java`, and `/bin/java`.
Candidate basename patterns include `orapki`, `mkstore`, `configTcps`, `java`,
`oraclepki*.jar`, `osdt*.jar`, `ojpse*`, and related JPS/JCE/JSafe JARs.

- Metadata: path, type, mode, size, category, and hash status.
- Only regular non-wallet tool candidates may receive SHA-256 hashes.
- Wallet/keystore/credential/password/secret/private paths and PKCS/key/certificate
  extensions are **metadata-only**, never hashed, read, or dumped. This precedence
  is enforced independently in shell collection and Python parsing.
- No JAR extraction, Java execution, archive upload, class contents, file contents,
  private keys, passwords, environment dumps, or raw Docker stderr is published.
- Maximum depth 16; 100,000 visited entries; 512 candidates; 4,096 path bytes;
  32 MiB per hashed file; 128 files / 128 MiB total hashing; 2 MiB combined command
  output; 3 MiB JSON artifact. The attach deadline is 120 seconds; all main Docker
  commands share 660 seconds, with a separate 70-second cleanup command budget.
  Forced client termination may add a bounded wait of at most five seconds.

Only `inventory.json` and a short sanitized status log are uploaded, under
`contents: read`, with a unique run/attempt artifact name. Pull/auth/access errors
fail closed without an alternate registry, login, or larger-image fallback.

`inspectionComplete` requires a complete valid protocol, successful traversal of
all present prefixes, no scan/hash/depth/count/time/output limits, verified
restrictions, and confirmed cleanup. An absent prefix is recorded only after
checking accessible parents. Unreadable, symlink-root/ancestor, failed, or truncated scans
are **unknown**, not missing capabilities. Intermediate symlink parents are not
traversed; a normal `/bin` alias therefore produces an explicit unknown scope. Even a complete scan is limited to the
documented paths/patterns, and file presence does not prove that a tool can run.

Every report explicitly has **`runtimeAcceptance: false`** and
**`databaseStarted: false`**. A green inventory job is not TCPS acceptance. The
existing Oracle candidate workflow, public-provider disabled state, and strict
native TCPS gates remain unchanged: actual `SYS_CONTEXT` protocol `tcps`, listener
TCPS 2484, bad-CA/wrong-SAN rejection, and recovery must still pass separately.
There is no TLS-proxy substitution and no assertion that Full is mandatory.
