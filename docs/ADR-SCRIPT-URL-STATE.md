# URL SDK phase-state boundary

This codec prepares the URL object integration; it does not enable a script URL
mode. Existing scripts still receive strings. The request pipeline, dynamic
providers, encoding-origin metadata and UI selection are not connected here.

## Preserve data rather than SDK methods

Each script phase must retain its existing fresh VM and resource limits. URL
state crosses that boundary as a versioned, bounded JSON snapshot, not a class
instance, host handle, closure or executable serializer. Snapshot fields retain
SDK query order, duplicates, missing values versus null flags, disabled members,
descriptions, path-variable values and raw component spelling.

The capture routine reads own data descriptors and known SDK member storage. It
does not call user-overridable toJSON or collection methods. Upstream SDK cloning
can silently turn a function-valued variable into an empty object. Capture must
reject that value before serialization instead of reporting successful migration.
Accessor fields are rejected without invoking their getters. Hidden fields and
symbols are rejected except for the verified internal SDK parent link.

Validation returns a detached copy. It rejects cycles, custom object prototypes,
nonfinite/non-JSON values, invalid Unicode, unknown snapshot fields, external
variable resolver metadata and unsupported variable types. Prototype-sensitive
keys inside ordinary variable data remain own data properties. Query system and
variable system/secret flags are retained as metadata; they grant no authority.

## Bounds and evidence

Limits are 1,000 entries per array, 8,192 visited values/keys, depth 16, and 64 KiB
of serialized snapshot UTF-8. Aggregate input text is bounded during traversal,
before constructing the final serialized string. These are state-boundary limits,
not an increase to the VM's existing 16 MiB memory, 512 KiB stack or 250 ms activity
limits.

Tests exercise actual selected SDK objects, strict input rejection, immutable
capture, raw syntax round trips and transfer between two fresh isolated VMs.
The second VM receives only validated JSON: globals from the first phase do not
survive and no process binding is provided. No network behavior or complete SDK
compatibility is claimed by these tests. Function-valued variables and arbitrary
SDK object extensions remain explicitly unsupported at this boundary.
