# Script response byte measurement

## Decision

Expose the executor's existing recorded response body byte count through
`pm.response.responseSize` and `apt.response.responseSize`. Script HTTP callback
responses expose the same property. Their retained subrequest evidence also
includes the existing numeric `size` measurement.

This is the received body byte count, not JavaScript string length, header size,
or a new serialization of the displayed body. A measured empty body remains
zero. If an older or synthetic response has no measurement, the property stays
undefined rather than inventing a value. This does not change HTTP decoding,
response limits, transport behavior, or stored main-request evidence.

## Evidence and boundary

Inert inspection of the official Apipost offline 2.0.0 execution bundle found
script/assertion code reading `pm.response.responseSize`. The large bundle was
split at literal Webpack module boundaries, with the original bundle and each
slice hashed. REA analyzed a syntax-wrapped copy of module 842216 without running
its bootstrap. This is partial static evidence, not proof that every packaged
feature is available without payment or that native runtime behavior matches
all transport/compression cases.

The full original script SDK is not implemented by this decision. Response
mutation helpers, full vendor library behavior, and native client equivalence
remain separate work.

## Verification

Regression tests first reproduced undefined measurements. They cover explicitly
recorded values, zero and missing measurements. A real loopback HTTP response
containing Chinese text and an emoji verifies seven body bytes instead of three
UTF-16 code units, with extra headers excluded. Both the main response and a
script-created subrequest must satisfy the same assertion and retain that byte
measurement in execution evidence. Existing script HTTP permissions, resource
limits and worker timeouts are unchanged.
