# Base64 expansion preflight

The source-template pipeline formerly encoded valid input with CryptoJS and only
then counted the JSON bytes of its output. A 50,000-byte ASCII input is below the
initial 64KiB JSON limit, but produces 66,668 Base64 characters (66,670 JSON bytes).
It must fail even if a later `length` stage would shrink it. Computing that known
invalid intermediate consumed avoidable activity time before the existing check.

The preflight is serialized into the same isolated script VM and runs before the
encoder's exception-translation block. It counts exact UTF-8 bytes, validates all
UTF-16 before rejecting size, and rejects if `4 * ceil(bytes / 3) + 2 > 65536`.
Standard Base64 characters require no JSON escaping; the extra two bytes are the
JSON quotes. ASCII uses a native regexp scan, while other text counts BMP and
surrogate pairs. No output buffer is allocated by the preflight.

Valid input still uses the original CryptoJS encoder. The original per-stage and
final-field checks remain; decoding is unchanged. All script activity, wall-clock,
memory, request, timer and job limits are unchanged. A size failure is not accepted
as a timeout, and a timeout is never accepted as proof of size validation.

Tests compare ASCII, two-/three-/four-byte Unicode and the exact 49,149/49,150-byte
input boundary against Node's independent UTF-8/Base64/JSON encoding. Malformed
surrogates, including an oversized prefix followed by an invalid surrogate, retain
the Unicode error. Real pipelines cover allowed encoding, intermediate rejection
before a shrinking stage, initial/final JSON quotas and unchanged decoding. A
negative mutant disabling the preflight quota demonstrably loses its boundary
rejection; existing real worker timeout tests remain separate.

The motivating macOS CI failure returned a worker error rather than the expected
size message. Its TAP artifact did not include activity metrics; the test duration
covered multiple workers. This change removes deterministic unnecessary work, not
a claim to have identified that runner's precise scheduling or timeout cause.

A separate non-timing test captures the real generator's worker call, evaluates
that generated source with counted UTF-8 parser/encoder wrappers, and verifies
zero allocations/encoder calls for oversized input. Removing only the preflight
call is a negative mutant: the unchanged later check still rejects, but both
allocation and encoding now occur. Valid input still reaches both original
CryptoJS functions. This semantic instrumentation is not a replacement for the
real-worker quota and encoding tests.
