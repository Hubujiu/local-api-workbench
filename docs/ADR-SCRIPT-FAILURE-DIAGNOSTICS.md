# Preserve bounded script failure diagnostics through manual debug

A script failure already identified its execution stage inside the worker or
parent deadline handler. Plan results retained only stage/scope, discarded the
numeric counters and last-known worker stage, and the manual execute response
dropped even stage/scope. A desktop failure consequently surfaced only a generic
script timeout, making startup, active computation and async waiting difficult
to distinguish from the public debug result.

The result/history now retain a small allowlisted diagnostic object. Manual
execute responses expose the same fields: known stage, bounded scope name,
activity budget, Faker/timer/request counters, and parent elapsed/last-stage
information when supplied by the timeout handler. Unknown stages, arbitrary
properties, nonfinite values and counters outside their supported bounds are
omitted. Source text, worker inputs, stack paths and arbitrary error properties
are not added to this diagnostic object.

The original failure message and failed outcome remain unchanged. No time,
memory, output, network or activity quota changes; no automatic rerun, successful
fallback or swallowed exception is introduced. This improves diagnosis and does
not assert that a platform-specific timeout has been fixed.

A failing HTTP regression first demonstrated the missing script stage. The final
regression checks actual manual execution failure and persisted history, together
with strict filtering of diagnostic fields. Existing worker/plan stage coverage
continues to verify semantic errors are not replaced by diagnostic labels.

Sequence failures additionally retain up to 34 successful-stage timing records. Each record contains only its numeric stage index, incoming activity budget, charged activity time, total stage elapsed time, existing bounded resource counters and whitelisted phase metrics. Stage names, code, variables, requests, outputs and arbitrary properties are not copied into these records. Sanitization is applied again when producing public failure evidence.

This allows a later-stage timeout to be distinguished from budget already consumed by an earlier stage. Phase metrics may overlap (for example provider loading inside user execution), so they must not be summed as independent CPU measurements. The record is observation only: the aggregate 250 ms activity limit, 2 s wall deadline, all quotas, unchanged acceptance assertions and fixed diagnostic probe count remain in force. A subsequent passing run is not proof that an intermittent timeout root cause has been fixed.
