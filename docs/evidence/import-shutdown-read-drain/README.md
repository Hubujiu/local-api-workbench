# Automatic-import shutdown drains guarded reads

Baseline: PR #158, `83fe11dd0a1b0a1ee30654beb53535480323e5ec`.
Regression: `tests/active-project-import-shutdown.test.mjs`.

The baseline's `close()` waited for a running import but not for project reads
started by activation, reactivation or an interval poll. A pending `Store.get`
still owns its SQLite-backed file guard until its asynchronous release finishes.
Closing the manager could therefore return while that resource remained open.

The regression gates the real `Store.readUnlocked` after its actual read while
the real `Store.get` still holds its guard. No fabricated Store response or
replacement lock is used. On unchanged baseline all seven tests failed because
close resolved before the guarded read settled. With the fix all seven pass.
The captured RED/GREEN output only has trailing whitespace removed.

The manager now tracks all six guarded read sites through one private helper.
Closing synchronously prevents new reads, cancels the session using the existing
ownership rules, waits for running work, then drains outstanding reads. Both
concurrent close callers wait. Successful and rejected reads are removed with
an awaited try/finally, without creating an unobserved rejection chain.
Read failures retain their existing caller behavior; shutdown can still finish.
No drain is added to deactivate or reset, avoiding a self-wait during polling.

Coverage includes successful and failing reads during poll, activate and
reactivate, an actual interval callback, concurrent shutdown, no post-close read
or HTTP request, no late activation, and unchanged persisted project data.
Fixture teardown releases test gates and waits for real read promises even on
the failing baseline. It does not retry removal or hide cleanup errors.

Three existing ownership scenarios formerly awaited close before releasing their
held read. Their first affected-suite run reached the existing 15-second timeout
under the corrected drain contract. They now start close, release or reject the
gate, then await both operations. Existing assertions and timeouts are unchanged.

Final affected suite: 190/190 passed with no skips, failures or cancellations:

```
node --test --test-concurrency=2 tests/active-project-import*.test.mjs \
  tests/auto-import-session-ownership.test.mjs tests/manual-import*.test.mjs \
  tests/native-append-legacy-plans.test.mjs
```

Independent review found no remaining correctness blockers. Its shutdown and
ownership rerun passed 59/59; separate scheduler/cancellation checks passed 7/7.

The first PR #158 CI attempt remains a failure: Windows core shard 2 reported
EBUSY deleting a temporary guard in the hook of the existing real-fetch test.
That report motivated this investigation. The deterministic lifecycle gap is
confirmed independently; it is not proven to be the unique cause of that EBUSY.
The previous run is not rerun or relabeled by this separate fix.

No original Apipost execution, proprietary format expansion, restricted export
integration, merge or deployment is included. This new commit requires its own
complete CI and artifact verification.
