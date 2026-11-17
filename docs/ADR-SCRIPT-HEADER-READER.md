# Request getHeaders snapshot reader

Primary static reference: official Offline2 2.0.0 send.asar/index.js Request
getHeaders and its PropertyList.toObject implementation at decoded offset
26216077. Header declares case-insensitive indexing and multiple-value support.
The request reader passes enabled, the inverse of ignoreCase, multiValue and
sanitizeKeys options to that implementation. Inspection is static only.

pm.request.getHeaders(options) and the shared apt.request facade now expose a
detached snapshot of configured request headers. Defaults preserve case and
include disabled rows. enabled:true excludes disabled rows; ignoreCase:true
lowers keys; sanitizeKeys:true excludes empty names. Repeated same resulting
keys yield arrays. Header multiple-value support takes precedence, so specifying
multiValue:false does not collapse duplicates. All supported options must be
booleans and unknown options are rejected.

Snapshots do not alias request rows or duplicate-value arrays. A Map and own-data
property construction preserve literal names such as __proto__ without invoking
prototype setters. Missing values use an empty string. Current JSON-compatible
header values are copied rather than exposed by reference.

The reader permits at most 1000 rows, 1KiB names, 64KiB serialized values, and
256KiB aggregate name/value representation. Existing VM and overall output
limits remain. It does not read credentials elsewhere or claim to include
transport-generated/authentication headers that have not yet been attached.
Existing headers.get/toObject semantics are unchanged; this is not a full live
HeaderList implementation.

Tests cover duplicates, case modes, enabled filtering, empty and prototype-like
names, independent snapshots, strict options and output rejection. Browser
coverage compares the reader with an actual request and confirms a disabled
header is absent on the wire. The packaged runtime also calls the reader on all
three CI platforms; those results require exact-head CI verification.
