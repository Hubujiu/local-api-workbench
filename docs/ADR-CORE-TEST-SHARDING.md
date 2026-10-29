# Core CI file sharding

## Reason and scope

The combined core suite has outgrown a comfortable margin within one ten-minute
job. In run [40426535386](https://github.com/Hubujiu/local-api-workbench/actions/runs/40426535386),
the Windows job began at 00:27:42 UTC, tests began at 00:28:13, cancellation was
logged at 00:37:43, and the job ended at 00:37:48. Nine jobs succeeded; Ubuntu and
macOS core each completed 1743 tests. Windows showed no observed failing test and
no final test totals. This strongly supports exhaustion of the existing overall
job limit, **not direct confirmation of the cancellation cause**: its cancellation
annotation was not readable. No retry, historical-result replacement, or
application timeout relaxation is part of this change.

The initial version used two independent shards on **each** of Linux, Windows and macOS.
The controlled isolation revision below supersedes that allocation; the initial
evidence is retained as history, not reclassified as a new-version pass.
Every job retains `timeout-minutes: 10`, Node 24 and
`--test-concurrency=2`; matrix fail-fast remains disabled. All other jobs, audits,
permissions, checks and application resource limits remain unchanged. Tests inside
each file retain their original Node concurrency behavior. No test-name filter,
skip, retry or timeout-as-pass policy is added. `npm test` is unchanged and still
runs the entire original `tests/*.test.mjs` scope locally.

## Exact coverage rather than unchecked patterns

`node scripts/run-core-tests.mjs --shard=1/2 --label=ubuntu-latest`:

1. Enumerates the actual top-level, non-dot `tests/*.test.mjs` matches; no manually
   maintained file list. An empty set, non-regular file or glob-like filename is
   an error, never a silently ignored pattern.
2. Sorts filenames in JavaScript code-unit order, not locale order. The recorded
   relative paths always use `/`, and the hashed file list always uses LF, so
   operating-system separators and checkout CRLF conversion do not change it.
3. Assigns sorted position `p` to shard `p % total + 1`. Strict positive-integer
   index/total validation and `total <= fileCount` ensure every shard is nonempty.
   Each position has exactly one remainder: the shards are disjoint and their
   union is the complete baseline. Adding a test can rebalance later positions,
   but cannot silently omit it.
4. Writes `test-results/core-<OS>-shard-<INDEX>-of-<TOTAL>.json`, containing the
   entire file set, all shard memberships, the selected set and a SHA-256 of the
   LF-delimited full file list. The digest identifies **paths**, not source bytes;
   the actual checkout Git tree remains the source identity.
5. Passes only those checked paths explicitly to Node, without a shell, and writes
   both live spec output and an OS/shard-specific TAP file. Node child failure,
   spawn error, signal termination or wrapper interruption stays nonzero.

The workflow uploads each job's manifest and TAP under a unique OS/shard artifact
name with `if: always()`. A hard runner cancellation can prevent final upload or
TAP completion; an incomplete log is not proof of success. The native Node
[`--test-shard`](https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-shard)
option was considered. A small explicit-file launcher was chosen so that the
manifest is exactly the command's file list, with fail-closed discovery rather
than a second reconstruction of Node's internal selection and glob behavior.

For an allocation-only audit, add `--list`. This prints the selected paths and
writes the manifest **without executing tests**. CI never uses this mode; a list
is not a test pass.

## Capacity decision and evidence boundaries

Two shards halve the file count while retaining two concurrent files per worker;
there are six core jobs instead of three. This is a conservative first division,
not a claim that equal file counts imply equal duration. A full Windows suite did
not complete in the old run, so its exact total duration is unknown. The actual
combined tree's two Windows jobs must both complete under the unchanged ten-minute
limit before claiming the capacity problem is resolved. If a shard remains too
slow, use its per-file evidence to choose more deterministic file shards; do not
increase budgets, delete tests or rerun unchanged code until green.

Validation distinguishes these source sets:

- Branch base: remote `develop` freshly verified as
  `88f70bb515c48b93536b28b7fe3ec780f2e150f3`, tree
  `107767d4d92f69fc0b5a048d41371267fea5a568`: 224 original core files. The new
  sharder regression file makes **225**, assigned **113 / 112**. Full file-list
  SHA-256: `793f4be18b53fe70796bd59eeed71e74864e94f8336901a89fcd001a669a5d9a`.
- Isolated immutable archive of combined local `818bb82b2f2cc847f11a63f1165f7f7aa8db434d`,
  tree `1b9712a5cc77f7ea0028dcee0dbc0f5f118e0e9f` (same tree as remote
  `b5ffd1c56bf37138a02a51b6cdce74daab40ea70`): 334 original files; with the same
  new regression file, **335**, assigned **168 / 167**. Full file-list SHA-256:
  `02eeee8404e9d5bcfc3b40cf9c587b50eed4eb04021c614ba73fec4c661d8009`.
  The allocation-only audit has zero missing/duplicate files and no empty shard;
  it does **not** claim to have rerun or passed the combined application suite.

The committed regression batch independently compares the union against Node's
`fs.globSync` baseline for one, two and three shards, checks duplicate/empty and
invalid-input paths, LF/CRLF and Unicode ordering, and actually executes all five
files of a two-shard fixture. Each file has coordinated concurrent subtests,
exclusive-create completion markers and its shard's TAP totals, proving neither
file omission nor disabled internal concurrency. Deliberate assertion failure,
child nonzero exit, child signal, missing executable and wrapper cancellation all
remain failures. These fixtures do not substitute for application or three-OS CI.

### Local verification (2026-10-27, Linux / Node 24.22.1)

- The final nine sharding contract checks passed, with zero failed, cancelled or
  skipped tests. The same nine checks also passed in the isolated combined copy.
- One normal `develop`-based shard (`--shard=1/2 --label=local-linux`) ran once:
  **544/544 tests passed**, zero failed/cancelled/skipped, **73.532 seconds**.
  This is one real shard, **not a local full-suite run** and not Windows capacity
  evidence. Its TAP and full allocation manifest were produced by the CI launcher.
- `npm run check`, full `npm run format:check`, and `git diff --check` passed.
  A parsed-YAML comparison against the exact branch base confirmed all non-core
  jobs unchanged, all three OS and both shards present, read-only permissions,
  the ten-minute ceiling, disabled fail-fast and existing core setup/check steps.
- No remote CI result is asserted in this local checkpoint; actual checkout-tree
  verification and the larger combined Windows run remain required.

Any future CI result proves only its actual checkout tree. A green independent
`develop`-based PR is not evidence that the much larger combined tree, unrelated
heap changes, or the whole product has passed.

## Controlled per-job resource isolation revision (2026-10-27)

The current workflow uses **four disjoint exhaustive shards per OS** and
**one test-file process per job**. Its 12 core jobs (19 jobs overall) use the
same standard runners, Node 24 selection and ten-minute caps. Ordinary
`npm test` still uses two file processes. No test, application budget, retry,
failure policy, runtime version pin, non-core job or security check is changed.
The manifest is version 2 and explicitly records `fileConcurrency: 1`; that
same value constructs the Node command. The existing modulo partition is
unchanged, now used with `--shard=INDEX/4` in CI.

This is a controlled isolation experiment, **not a proven root-cause fix**.
Initial two-shard PR CI [40433509485](https://github.com/Hubujiu/local-api-workbench/actions/runs/40433509485)
and combined runs [40433701023](https://github.com/Hubujiu/local-api-workbench/actions/runs/40433701023)
and [40434862187](https://github.com/Hubujiu/local-api-workbench/actions/runs/40434862187)
were green. Later combined runs
[40436500912](https://github.com/Hubujiu/local-api-workbench/actions/runs/40436500912)
and [40438420588](https://github.com/Hubujiu/local-api-workbench/actions/runs/40438420588)
remain red: one macOS core shard failed in each. The latter script-sequence
failure recorded 264 ms compatibility wall time against 9,525 microseconds CPU.
Scheduling/contention is plausible, not uniquely established. Its failing and
passing macOS shards also used different image and Node patch versions.

Every core launcher prints only an explicit diagnostic allowlist: Node version,
platform, architecture, `os.availableParallelism()`, CPU array length, total
memory and optional ImageOS/ImageVersion. No environment dump is emitted.
These are observations, not CPU reservations or a replacement for source-tree
and actual artifact verification.

Node's default file process isolation and `--test-concurrency` affect concurrent
test-file processes, not concurrent operations inside a file. Existing in-file
Promise.all project A/C requests, file-lock competing processes and lifecycle
fixture batches remain untouched. The lifecycle fixture's five rounds of three
four-concurrent-worker batches still exercise 60 worker executions, not 60
simultaneously. The real sharder fixture now runs all five files across four
shards, uses an exclusive shared marker to reject file overlap, and retains
coordinated simultaneous nested subtests: serializing those subtests would hang
and fail. All assertion, spawn, signal and cancellation error paths remain tested.
An independent original-glob comparison covers totals one through four; no hidden
selection filter or list-only CI execution is allowed by the contract.

Four jobs with one file each retain four outer file processes per OS across
four VMs instead of two. This can reduce unrelated suites competing on one VM,
but cannot remove within-test concurrency, host scheduling or other causes.
It doubles core setup/install/artifact overhead and may roughly double core VM
minutes, increase queueing and use more concurrency quota. Equal file counts do
not promise equal runtime; reduced I/O overlap can also hurt. No larger/paid
runner is introduced. Fresh exact-head CI must establish the actual behavior;
historical green runs and this change alone do not prove product delivery.

Local revision verification: all ten contract tests pass, including actual file
execution, nested concurrency and failure propagation. Independent branch scope
is still 225 files, now allocated 57 / 56 / 56 / 56 with the same full-list hash.
No full local suite is repeated solely to seek a green timing outcome.

## Bounded live progress observations (2026-10-28)

The core launcher adds a third reporter, `core-progress-reporter.mjs`, alongside
unchanged spec and TAP outputs. Its `.progress.jsonl` artifact is included in the
same `if: always()` upload. No test selection, concurrency, application resource
limit, job timeout, failure policy, runtime pin or security check changes.

The reporter uses Node 24.21's immediate `test:dequeue`, `test:complete` and
`test:summary` events, not the declaration-ordered buffered `test:start` events:
https://nodejs.org/download/release/v24.21.0/docs/api/test.html#class-testsstream
It projects only event type, repository-relative file, test name, line, nesting,
reporter monotonic elapsed milliseconds, status and Node-reported duration.
Absent fields remain absent. Test names are source-owned labels, not a place to
put credentials. Names/files are capped at 256 characters and control characters
are removed; absolute file names outside the checkout are omitted. It never
copies errors, stacks, stdout/stderr, request/response bodies or environment.
Own scalar data properties are copied without invoking getters/toJSON hooks.

Output is capped at 12,000 lines and 4 MiB, including one truncation marker. After
the cap, the reporter still drains events without further output; it does not
stop tests or synthesize success. No per-test state map or heartbeat is retained.
I/O has a finite additional cost: this is observation, not a performance fix.
Elapsed time is when the parent reporter receives an event, not a CPU sample or
proof of the exact instant execution started. IPC and stream scheduling may add
latency. A completed test without a final file summary can help distinguish
reported test work from waiting for process completion, but cannot identify open
handles, prove scheduler contention, or diagnose an absent/cancelled event.
Partial files and truncation must never be interpreted as successful acceptance.

Local validation uses only pure synthetic reporter/sharder fixtures: allowlisted
field projection, missing/malformed fields, getter avoidance, both output caps
with continued draining, real passing/failing child fixtures preserving spec/TAP
and exit codes, and a small fixture which reports completion while its process
still owns an interval. The latter is terminated and verifies nonzero/signalled
termination and retained JSONL prefix. Existing exhaustive allocation, nested
concurrency and failure/cancellation contracts remain in the same batch.
No application, VM, XML, native database or pressure workload is run for this
change. Local Node 24.22.1 fixture results do not establish Node 24.21, Windows or
macOS runtime acceptance; those still require exact-head CI after review.

## Frozen duration-weighted allocation (supersedes round-robin only)

The current matrix remains exactly **four shards per OS**, file concurrency **1**,
Node 24, and the existing ten-minute job budget. Production budgets, all tests,
internal test concurrency, process isolation, outcome/exit handling and `npm test`
are unchanged. This revision replaces only membership selection. The historical
round-robin descriptions and failed/cancelled evidence above remain historical.

`scripts/core-test-weights.json` is a checked-in, digest-pinned input, never fetched
or automatically retuned in CI. `.gitattributes` forces LF for this exact JSON
path, preserving its raw-byte digest even with Windows `core.autocrlf=true`.
Its 463 path weights use ONLY prior runs
[40769853798](https://github.com/Hubujiu/local-api-workbench/actions/runs/40769853798)
(head `eb855b915a873755397f71f5a1abeccc04c8c912`) and
[40772663326](https://github.com/Hubujiu/local-api-workbench/actions/runs/40772663326)
(head `e5cd1fb8bc997dc0b0b27ca0a1e1d28fad2772c8`). All 24 raw progress JSONL
filenames and byte SHA-256 values are recorded in `sources`. Reconstruct each
weight by reading these exact bytes, selecting `test:complete` records whose
`name` (backslashes normalized to `/`) equals `file`, converting `durationMs` to
integer microseconds with `ceil(durationMs * 1000)`, and taking the maximum over
both runs and all OS. **Do not filter by status**: failed whole-file observations
are retained; nested test durations are not added. Incomplete files provide no
finished duration, not a zero or a pass. This is elapsed file-process time,
including startup/exit, not CPU time. File `test:summary` alone undercounts that
cost. No observations from the later TRACE run are used in the frozen weights.

Allocation discovers the same actual glob, sorts by descending frozen weight
(tie: code-unit path), and assigns each path once to the least loaded shard
(tie: lowest shard index). Assigned files execute in lexical path order. New or
unknown paths use the fixed largest historical weight, **54,879,087 microseconds**
(54.879087 seconds; upward rounding), rather than zero. Absent historical paths
are never selected. A changed file can retain a stale path estimate: weights
are scheduling hints, not a source checksum, execution authorization or capacity
guarantee. The actual checkout tree and exhaustive discovered path union remain
the coverage identity. No manually maintained weight entry can remove a test.

Version-3 manifests retain full paths, complete shard membership and path-union
hash, and add policy, pinned weights digest, provenance, effective per-file
weights, unknown/fallback paths, all shard estimates and selected estimate.
The parser reads at most 256 KiB plus one rejection byte, pins the exact JSON
hash, validates closed metadata/provenance schemas, path/weight limits, duplicate
source records and the fallback maximum, and fails closed before launching Node.
Source changes require deliberate reviewed updates to both JSON and digest.

### Prospective estimate, not a capacity guarantee

A read-only simulation froze the two runs above before evaluating later run
40776245608 (465 files). Its two new TRACE files received the historical-maximum
fallback. Estimated slowest file-process totals became Linux **315.5 s**, macOS
**356.2 s**, Windows **442.1 s**, versus original round-robin **418.6 / 432.7 /
580.6 s**. Windows lacked six completed files; those were explicitly imputed
from earlier observations, never recorded as passed. Windows setup consumed
about 32 s before tests. The manifest itself uses only the conservative frozen
training envelope, not these later evaluation timings: for those 465 paths it
reports about **644.3 s per shard**, including the maximum fallback for both
unknown TRACE paths. It must not be relabeled as a measured 442 s result.
These are counterfactual sums with host/order variance,
not timings of an actual rebalanced run and not a root-cause repair.

The conservative per-file maximum across all OS/history can combine incompatible
slow-host observations: the later 465-file envelope totals 2515.9 s, giving a
four-shard lower bound of **629 s**, already above 600 s before setup. Even
per-OS historical maxima leave macOS about 586.5 s plus setup. Thus the unchanged
four-shard budget cannot be guaranteed against that envelope. This allocation
only removes observed imbalance; it does not justify skipping tests, hiding
failures, increasing limits, adding retries or replacing retained failed runs.

Pure local fixtures cover exhaustive glob equality, add/remove/unknown/stale
paths, deterministic ties, malformed bounded weights, actual tiny child tests
with distinct weighted paths, process isolation, nested concurrent tests, and
unchanged failure/signal/cancellation exit semantics. No local application, VM,
XML or database workloads are part of this validation. Exact-head CI is pending
parent review/publication; simulations and pure fixtures are not full acceptance.

## 2026-10-29 frozen timing refresh (PR #35)

Root run 40936245088 at `5fc547d9e4389d1a43a724168a77a5917581a4f8`
ended cancelled, not passed: Windows shard 1 completed 117/123 files before
SQLite started at 564.738 seconds; the job stopped at its existing ten-minute
deadline. This does not establish a SQLite hang. The other Windows shards took
331.835, 441.696 and 489.739 seconds. The old table had only 463 weights and
charged 30 new files the conservative 54.879-second fallback.

Refresh only the frozen input table and its digest/provenance pins. Inputs are
24 complete progress JSONL artifacts from **fully green** runs
[40918700552](https://github.com/Hubujiu/local-api-workbench/actions/runs/40918700552)
(`bb0b7de270ea879a87003a27332254f2ba7c6ed5`) and
[40926521644](https://github.com/Hubujiu/local-api-workbench/actions/runs/40926521644)
(`8fe917ead122ad3ab44e5d4b76900bae4157ad76`): four shards × three OSes each.
The table records each input filename, exact head and raw-byte SHA-256.
For each stream, accept each unique whole-file `test:complete` event only when
normalized `name` equals `file`, and require passed status. Each input run must
have exactly three OS observations per file. Convert milliseconds to integer
microseconds with ceiling, then take the maximum across all observations.
This yields 492 weights. The 493-file root selection adds only
`tests/openapi-form-encoding-pure.test.mjs`; unknown files still use the largest
known weight (34,845,034 microseconds), never zero or a guessed average.

Frozen replay, summing historical whole-file durations after reassignment:

| Observation | Old min–max seconds | Refreshed min–max seconds |
| --- | --- | --- |
| 40934761053 Linux | 233.468–385.920 | 303.829–344.536 |
| 40934761053 macOS | 383.064–467.087 | 390.819–439.050 |
| 40934761053 Windows | 437.673–512.214 | 472.664–494.997 |
| 40936245088 Linux | 266.337–347.043 | 302.780–343.118 |
| 40936245088 macOS | 275.847–448.574 | 331.614–388.574 |

These are held-out complete-file timing observations, **not green-run claims**:
40934761053 failed an unrelated macOS test and 40936245088 was cancelled.
Current Windows has only 487/493 completed durations. Imputing its six missing
files from 40934761053 gives old 331.835–590.639 versus refreshed
422.760–483.596 seconds, but this is explicitly incomplete/imputed, not measured
current completion. No cancelled duration supplies a table weight.

The LPT algorithm, four shards, file concurrency one, ten-minute deadline,
application budgets, security checks and test selection remain unchanged.
Regression reconstructs the frozen 493-file selection from the 492 weighted
filenames plus the explicit unknown and checks exactly-once coverage,
deterministic assignment, estimates, provenance and maximum fallback.
Pure scheduler fixtures do not run application/VM/XML/database workloads.
Historical replay is not a guarantee: exact new feature/root CI must pass before
calling the deadline issue resolved. Prior failed/cancelled evidence is retained.
