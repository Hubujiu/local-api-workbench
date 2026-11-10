# Native append with retained legacy plans

Baseline: PR #156, `7bf3e20d6c4bed00d30621c9f99cad89ed0778ab`.
Regression: `tests/native-append-legacy-plans.test.mjs`.

Running the complete regression file on unchanged baseline production code
produced three failures and one pass (`red.output.txt`). Both JSON and directory
owner previews succeeded, but applying their signed tokens returned HTTP 400
when the target retained unknown legacy plan types. An independently isolated
sparse valid plan also failed apply: the second replay snapshot allocated
different missing identities. No original application or proprietary service
was executed; fixtures are synthetic and all network effects are loopback.

The Store now proves that replayed raw plans exactly equal the complete raw
candidate collection under its project lock, then reuses the candidate's single
validated normalization for whole-project replay comparison. The existing
opaque-plan matching, multiplicity checks, data budgets and strict execution
admission are unchanged. This does not authorize incoming unknown plans or
changes to old opaque definitions. Ordinary valid sparse plans receive the same
default/ID materialization as an ordinary Store save, once, rather than two
independent allocations. Already normalized plans and inert history stay intact.

The same regression passes 4/4 (`green.output.txt`): both owner formats,
side-effect-free preview/apply, newer activity preservation, Store reopen,
unknown-plan execution denial, unrelated valid execution and durable evidence,
edited/new/duplicated opaque definition rejection, stale-token rejection, and
stable materialized identities across later saves/reopens/execution.

Independent review found no blocking issues and independently ran the four new
tests plus plan-step-types, lifecycle and identities suites: 21/21 passed.
Syntax, whole-repository format and diff checks passed. These focused results
are not a substitute for the new commit's complete CI and portable-artifact
verification. The original PR156 CI is a separate baseline result.
