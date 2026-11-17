# Load execution uses the real request pipeline

The prior load endpoint called raw HTTP directly and evaluated only declarative assertions. That silently skipped configured scripts and dynamic values; a new regression first demonstrated a failing post-script incorrectly counted as passed.

Each sample now runs the existing one-step execution pipeline, including pre/post scripts, dynamic parameters/body, extraction, authentication, shared functions, service bindings and assertions. The existing bounds remain 100 primary executions and concurrency10. Each script retains its separate HTTP and execution budgets; script child invocations are counted separately. Counts are logical calls, not TCP packets or authentication challenge round trips.

Variables are copied from the selected project's valid debug/environment state for each sample. Environment/global/script updates remain local to that sample and are not persisted to project files or reused by another sample, preventing concurrent load traffic from racing to overwrite configuration. The UI explains this difference from ordinary debug/plan execution.

A sample passes only with a2xxmain response and successful pipeline assertions, preserving the earlier load-status policy. Summaries include failed assertion names/phases, bounded child-call metadata, errors, primary response duration and whole-sample elapsed time. P50/P95 use the existing sorted-sample index convention over completed primary response timings; timingSamples=0 means there is no latency sample, not a zero-millisecond success.

Cancellation propagates through scripts, child HTTP and primary HTTP; started interrupted samples remain visible. Fixed acceptance retains the ten100-request contention batches and adds real callback-token/dynamic-body/assertion/isolation/cancel behavior plus browser checks. No public-service load testing is used.
