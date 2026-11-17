# Script execution context and read-only iteration data

The official [apt API reference](https://wiki.apipost.cn/docs/usescript/apt/) documents script phase, request identity, iteration information and read-only data access. This implementation reports real engine state rather than inferring iteration from request URLs or mutable variables.

`apt.info` exposes eventName (pre_script/test), requestId, requestName, iteration and iterationCount. `pm.info` uses prerequest/test phase names. Both objects are frozen within the VM. Ordinary debug/case/plan execution has iteration0/count1; a plan step index is not misreported as an iteration. One-click load execution supplies its actual zero-based iteration index and configured count (up to100), independent of concurrent completion order.

`apt.iterationData` / `pm.iterationData` provide has/get/toObject/replaceIn over the current CSV row (empty for no row), with no set/unset/clear. Reads return JSON copies so scripts cannot mutate the row. replaceIn uses row values plus supported dynamic variables, not an accidental fallback to environment values. Shared script stages see the same context. Runtime variables continue receiving the existing CSV overlay; this does not change saved environment/global state.

The new context accepts at most50 top-level fields and512KiB serialized JSON. This accommodates JSON escape expansion of the existing64KiB raw CSV limit rather than silently reducing that limit. Invalid iteration ranges, unsafe field names, non-JSON values and larger payloads fail before starting the script worker. VM activity, wall deadline, output and replaceIn limits are unchanged. Global-variable replaceIn is also exposed against its own scope; existing legacy apt.variables/environment semantics are preserved, not silently migrated.

This does not add dataset mutation, multi-round execution plans, environment-name/pre-URL metadata or complete vendor SDK parity. For this tool, load iterations are the supported iteration source; vendor automation-module behavior is not assumed identical.

Red-first tests cover default/actual phases and identity, frozen metadata, read-copy isolation, missing-key rejection and real concurrent CSV HTTP execution in both script phases. Additional bounds tests protect existing CSV encoding capacity. Browser debug/load and actual packaged desktop scripts exercise the APIs; exact-head CI is required before marking those paths verified.
