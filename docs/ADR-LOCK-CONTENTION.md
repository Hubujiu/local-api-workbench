# Bounded progress-aware file-lock contention

Evidence: Ubuntu CI run 39349786796, job 118391000814 failed the unchanged independent-process 40-increment test. The waiting process timed out at 2096 ms on its first acquisition while the same writer had reached counter 19 and completed 20 writes at 2230 ms. This is evidence of a short fixed acquisition window under repeated live lock turnover, not evidence of corrupt data or a dead owner. Prior tests/production used 100 fixed 20 ms retries even when the nonce changed repeatedly.

Decision: retain a 2-second no-progress limit for unchanged, incomplete or unrecognized owners and transient Windows mkdir failures. Renew that idle deadline only when a valid live owner has a different nonce, indicating lock turnover. Add an independent hard 10-second acquisition deadline so sustained turnover cannot wait forever. Do not break a live lock, weaken mutual exclusion, reduce the 40-update assertion, change script budgets or retry away the failure. Owner verification, dead-owner recovery and same-process queue remain.

Fixed regression: a live owner nonce that changes every 100 ms for 2.4 seconds must not be treated as stalled, while an unchanged live owner must still fail after the original idle window and must never be deleted. Existing independent-process counter test remains unchanged and full CI runs on all three OSes.

The regression also keeps changing the live nonce until acquisition fails and checks the independent 10-second hard cap. Tests do not reduce the original 40 counter writes. Deadline accounting uses monotonic performance.now rather than wall-clock time.

Follow-up CI exposed a test-only observation race: on Windows, the hard-limit assertion parsed owner.json while the fixture updater was truncating/replacing its contents. The fixture updater is now stopped and awaited after the unchanged deadline assertions and before the final owner identity read. This does not change product lock code, required counter writes, wait windows or ownership protection checks.
