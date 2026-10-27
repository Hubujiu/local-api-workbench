# Follow-up review of initial green stage

The first three-platform CI (40441315553) passed against remote 5db7bb5 / tree 09ef9fa5, including 1028 existing tests and 15 experimental tests per OS. Those checks did not prove that worker success waited for cleanup.

Read-only review found worker.mjs posted success before finally session.dispose(). The measuring parent terminated on result and could miss a later cleanup error. This was a harness acceptance gap, not evidence of an observed guest memory leak. The original samples and failed prototype evidence are retained rather than silently relabeled.

The follow-up publishes success only after disposal, charges successful disposal to the same 250 ms budget, and checks parent total time after termination. Deterministic tests reject injected cleanup failure, late cleanup and already-expired budget while still disposing once. Both fresh test sessions are now acquired inside a protected try/finally. All 18 runtime/ownership/outcome checks pass locally; 70 new full-lifecycle samples also pass. The source/compiler/WASM/glue and fixed bytecode artifacts did not change.
