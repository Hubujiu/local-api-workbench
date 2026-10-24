# Explicit-pool original string Mock rules

Static inspection of the official offline 2.0.0 embedded mockjs5-pro extension shows that its string generator uses lodash sampleSize on an explicit pool. This differs from the Local API native string generator: source positions are sampled without replacement, requested lengths greater than the pool length are clipped, and repeated characters already in the pool remain repeated positions.

Modern JSON and the supported original-directory JSON subset can import string-typed rules with @string("pool",length) or @string("pool",min,max). Arguments must be JSON literals. Pools contain 1–64 ASCII letters, digits, spaces, underscores, dots or hyphens; lengths are integers from 0 to 64 with min no greater than max. This deliberately excludes nested @ expressions, executable arguments, implicit pools, single-quoted/non-JSON arguments, Unicode pools and unverified overloads. No vendor code or expression executes during import.

Matching uses the same bounded original exact/wildcard mode and strict field types as the numeric import subset. Source identities survive storage and editor changes. Schema examples/defaults/enums retain existing priority; generated text must satisfy existing output validation, including length constraints, or fail explicitly. Numeric minimum/maximum bypass does not apply to string rules. Existing Local API string generators keep their original behavior. Seeded sampling is illustrative and does not claim the vendor's random sequence or distribution.

Independent tests cover permutations, repeated positions, clipped/zero/ranged lengths, strict type matching, atomic refusal, actual sample/Mock HTTP and browser edit/reload/source preservation. This is not full Mock.js/Faker support or original GUI parity.
