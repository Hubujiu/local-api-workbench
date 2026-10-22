# Bounded script JSON Schema assertions

Add `pm.response.to.have.jsonSchema` and Chai `expect(data).to.have.jsonSchema`,
including negation and existing Apipost aliases. The original package's static
sandbox implementation exposes this assertion family. This implementation is
independent and uses the project's pinned Ajv 8.20.0 plus ajv-formats 3.0.1.

## Authority and correctness boundaries

Compilation and validation happen only inside the existing QuickJS worker, never
in the Node host or browser page. Load the validator lazily during script activity.
Keep the existing 16 MiB memory, 512 KiB stack, 250 ms activity and two-second
worker limits. No filesystem, network, module-loading or asynchronous-schema
capability is added. External references and asynchronous schemas are rejected.

Support bounded JSON data and the draft-07 vocabulary, local references and known
formats. Unknown dialects, validation keywords, formats and options fail explicitly
rather than silently weakening checks. Only boolean `allErrors` and `verbose`
options are supported initially. Validation does not coerce, remove or default
data. A missing/non-JSON response, invalid schema or resource limit is an error,
not a successful negative assertion. Standard formats run under the same worker
limits because regex-based validation can be expensive.

Limit schema JSON to 64 KiB, depth 32 and 5000 nodes; data to 256 KiB, depth 64 and
10000 nodes. Reject cyclic/non-JSON values. Clone input without repeatedly invoking
getters. Cache at most two option sets and eight compiled schemas per set. The
schema meta-validation remains enabled. This is not full historical Ajv option,
draft-04/2020-12, custom-keyword or external-schema compatibility.
User-supplied patterns remain subject to the existing QuickJS regular-expression
dialect; this is not a general regular-expression transpiler.

## Runtime syntax adaptation

The pinned fast-uri source has escaped hyphens in Unicode character classes which
the current QuickJS parser rejects. During the reproducible build only, move those
literal hyphens to the end of their character classes. This preserves the accepted
character sets, not relaxing URI parsing. Verify the two original source hashes
and require exactly nine changed classes in eight named expressions. Preserve
third-party license notices. A source/package change fails the build pending review.

Regression tests cover actual positive/negative assertion results, local references,
formats, mutation isolation, malformed inputs, limits, regex equivalence and real
HTTP execution. Reproducible bundle checks and all existing CI gates stay enabled.

References:

- https://ajv.js.org/guide/formats.html
- https://ajv.js.org/security.html
