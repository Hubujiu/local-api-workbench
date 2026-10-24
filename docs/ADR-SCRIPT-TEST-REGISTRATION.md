# Explicit skipped script assertions and registration index

Static reference: the official Offline2 2.0.0 send.asar/index.js embedded runtime,
decoded character offset 28735174 and its adjacent pmapi test implementation.
The package provenance is recorded in ORIGINAL-OFFLINE2-RESEARCH.md. Static
inspection only; no original application code was executed for this feature.
The reference exposes test.skip and test.index. No implementation is copied.

pm.test.skip(name[, callback]) records an explicit skipped assertion and never
invokes the callback. It returns pm for chaining. apt.test references the same
function and therefore offers the same methods in both supported dialects.
The record retains the vendor-style passed:true with skipped:true; this means
non-failing, not actually tested. UI counts separate skipped from passed, and
plan evidence uses a neutral “跳过” label, not a success tick. A contradictory
passed:false record remains visibly failed even if it carries skipped:true.

pm.test.index() returns the number of assertions registered in the current
isolated script invocation, including skipped and pending async assertions, not
the number completed. Each shared script invocation has its own index; this
bounded isolation contract does not claim one shared Postman VM across scopes.
All registered assertions, including skips, consume the existing shared phase
limit of 1000; skipping cannot bypass the activity/output/deadline budgets.
Existing real failures and HTTP error outcomes remain failures. Skipping is not
an assertion of a successful HTTP status or an instruction to skip a request.

Tests cover ignored callbacks, async registration order, invocation reset,
shared budget exhaustion, failure preservation and neutral evidence rendering.
Browser verification uses an actual form request and its returned skip record;
packaged desktop checks exercise the same APIs in the installed VM runtime on
all supported CI operating systems. Exact-head CI is required for those claims.
