# Script inputs are JSON data, not JavaScript object literals

Previously the worker interpolated JSON.stringify(input) into its trusted setup program as a JavaScript object literal. JSON and object-literal semantics differ for an own __proto__ field: the literal can change a nested object's prototype or discard a primitive/null property instead of preserving the JSON data. Failing regressions demonstrated this for structured variable values, response header maps and values carried across shared stages. This is a data-fidelity defect; no host escape or global prototype-pollution incident is claimed.

The host now transfers the serialized JSON through a temporary QuickJS string handle. Trusted setup calls the VM's native JSON.parse and removes the temporary global before loading user functions or running user scripts. The host handle is disposed immediately after assignment; normal context/runtime disposal handles setup failures. Input values no longer become source text. Existing JSON serialization behavior for unsupported values remains unchanged.

Main-response and brokered-subrequest header readers now return only own dictionary values. Missing names such as constructor or toString must yield undefined rather than an inherited JavaScript property. This does not change Node's HTTP parsing/filtering policy, reintroduce filtered wire headers or relax network admission rules. The real HTTP fixture uses a constructor header and verifies missing inherited names; synthetic JSON maps separately verify exact __proto__ preservation.

The fresh VM and worker boundary, 16 MiB heap, 512 KiB stack, startup/activity/wall limits, source/output limits and HTTP grants are unchanged. Private timing probes are not shipped with this change. No claim is made that this fixes the separate intermittent startup or script-time-budget failures.

Regression coverage includes own-key preservation, ordinary prototypes, unchanged host prototypes, inert quoted/Unicode data, shared-stage serialization, absence of the temporary bridge global, real HTTP after-scripts and callback/Promise subrequest header readers.
