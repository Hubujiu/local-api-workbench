# Reviewed URL SDK foundation, not a shipped script URL mode

Existing scripts still receive a string at pm.request.url / apt.request.url.
This change adds separately tested build assets only. It does not expose an
object mode to scripts, alter requests, implement native project migration, or
claim complete SDK equivalence. Runtime state, query encoding, dynamic-value
single evaluation, export behavior and explicit UI opt-in must be integrated
and verified before that feature is delivered.

## Source and dependency boundary

Ten URL/QueryParam/Variable/Property data-class source modules are selected from
the npm registry postman-collection 5.3.1 archive, not the full package's runtime
entry. Registry gitHead is 01d914a2a132420f5db1695b34cea2668d645947; the archive
SHA-256 is e486b4b4b61397bcc6aee2bbe5b0829c0bca6fb574a190d8a69d0266bc8e7275.
The reviewed source hashes and local modifications are recorded beside those
sources. The URL, QueryParam and Property files also match the separately read
pinned upstream snapshot b378e3febf34c74da1d5ba8509ce4c1fe764172e.

The full SDK dependency closure previously brought vulnerable legacy Faker/UUID
packages. Those packages are not installed as application dependencies and are
not loaded by this adapter. Build-time imports instead use the already pinned
lodash 4.18.1 and the standalone postman-url-encoder parser 3.0.8. ID generation
and buffer decoding have explicit throwing adapters; default dynamic generators
are absent. These unavailable features are not presented as implemented.
The build rejects unreviewed inputs and external imports, checks source hashes
and dependency versions, and emits both a browser/VM bundle and an ESM host
bundle. No host module loader, process, filesystem or network binding is added.

Two reviewed PropertyList changes protect data fidelity: default reference
indexes have a null prototype, and toObject creates own properties explicitly.
A failed prototype probe demonstrated that constructor could be mistaken for an
inherited index member. Regressions cover constructor/**proto**/toString names
and removal. This is not claimed to be an escape from the existing sandbox.

Apache-2.0 upstream terms and complete dependency license texts accompany the
runtime assets. Vendored files remain source-reviewable; no installation scripts
or full SDK dependency tree are run during the build.

## Fixed evidence and remaining integration work

Tests distinguish a flag's null member value from its empty-string get() value,
preserve duplicate identity and disabled behavior, and cover literal delimiters,
opaque templates, IPv6, path-variable suffixes and deprecated getRaw behavior.
The VM artifact is tested under the existing 16 MiB memory, 512 KiB stack and
250 ms activity limits. Generated assets and dependency inputs are hash checked;
CI rebuilds them with the other trusted sandbox assets. Legacy script behavior
is explicitly checked unchanged.

The SDK object is not a drop-in replacement for URLSearchParams or a primitive
string. Its query values retain raw escaping, and object identity is observable.
Integration must preserve disabled rows and dynamic specifications while avoiding
double evaluation of generated values. A new explicit compatibility choice and
real HTTP/export/browser evidence remain required; foundation tests alone do not
constitute delivery of that integration.
