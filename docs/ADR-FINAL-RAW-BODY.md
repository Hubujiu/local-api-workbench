# Bounded final raw request-body helper

## Compatibility scope

Static inspection of the original request adapter shows that
`getFinalRequestRawBody` is a pre-request helper: it replaces variables in the
phase's prepared body, applies supported mock expressions, writes the body back,
and returns it. It is not merely a read-only preview. The local implementation
adds `pm.getFinalRequestRawBody()` and its `apt` alias for raw and JSON text only.
It uses the existing bounded variable/builtin replacement implementation, not a
new expression evaluator. Forms, binary bodies and declarative `{{@value:...}}`
body providers remain explicitly unsupported by this helper. This is not a claim
of the original's entire Mock expression catalog or form conversion behavior.

Within one VM, calls resolve the captured phase input again, allowing a changed
variable to produce a changed returned body. The existing whole-body setter
writes the text and retains valid JSON mode or its documented text fallback.
The helper is absent in response phases. Ordinary scripts that do not call it
keep their previous request interpolation behavior.

## Finalized text must remain literal

A helper result may itself contain literal template-like text, such as a variable
whose value is `{{literal}}+&`. Running ordinary interpolation on that result a
second time changes the bytes, can regenerate values, or fails on an undefined
variable. This is especially wrong when the pre-request script signs the returned
body.

The worker therefore returns a small execution-only finalization record separate
from the request definition. It is accepted only when its exact body text and
body type still match the current request. Later body edits invalidate it. Shared
script stages carry this record within the existing aggregate output budget;
when a preceding fresh VM has already finalized the text, the next VM treats it
as literal rather than recursively resolving its template-like contents. This
explicit stage behavior is not a claim that all shared-script scope semantics
match the original runtime.

The core passes the record out of band to the existing dynamic resolver. Matching
finalized text is copied unchanged; URL, header, cookie and form providers still
use their existing resolver and shared budgets. Nothing is persisted as a
request-definition flag, and normal request normalization does not promote an
arbitrary client-supplied `finalBody` request property into this execution state.
The record is an internal consistency marker, not a cryptographic attestation.

## Limits and evidence

The helper reuses the existing 64 KiB input/output replacement and body-setter
bounds. Record validation rejects non-plain objects, accessors, extra fields,
invalid modes and excessive UTF-8 text without invoking getters. Existing VM,
activity, total deadline, random/Faker and shared-stage limits remain unchanged;
the record is included in the aggregate output-size check.

Real HTTP tests compare the returned text, a signature produced inside the VM,
and the body received by the fixture. They include template-like literal values
crossing fresh shared-script VMs, invalidation on later edits, absent post-response
API, unsupported bodies and malformed records. Browser and packaged desktop
fixtures send the body and verify its independently computed HMAC at the fixture
boundary. These checks are feature-specific, not full SDK compatibility evidence.
