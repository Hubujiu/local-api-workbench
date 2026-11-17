# JSON equality for generated unique Mock samples

The ordinary Schema Mock route delegates to `sampleFromSchema`. Its homogeneous
`uniqueItems` branch formerly deduplicated enum members by `JSON.stringify` text.
That is not JSON value equality: object property order is insignificant, while
array order is significant. An explicitly 2020-12 schema with repeated equal enum
members is meta-schema-valid, and may have enough other members to generate the
requested distinct array. Draft-07's enum meta-schema is stricter; the regression
uses the declared 2020-12 dialect rather than disabling meta-schema validation.

The sampler now preserves the first representative of each distinct enum value
and uses Node's existing `isDeepStrictEqual` implementation on validated copies.
Copies contain only JSON data, normalize object prototypes and negative zero,
and retain ordinary `__proto__`, `constructor`, `toString` and `valueOf` data keys.
No new dependency or license is introduced. Existing Ajv 8.20.0 provides an
independent validator for the ordinary JSON regression cases; its
fast-deep-equal helper is not used in production because it reads constructor and
can call valueOf/toString on supplied objects.

The same equality applies to generated tuples, without reordering their slots.
A duplicate deterministic tuple produces an explicit unsupported-sample error;
this does not claim that the original schema has no solution. Tuple candidate
schemas and literal/reference values are checked before literal cloning. Direct
JS values with accessors, Proxy objects, exotic prototypes, cycles, sparse
arrays, undefined, nonfinite numbers or hidden/symbol properties are outside
this candidate domain and rejected rather than executing hooks. This is not a
new general-purpose validation guarantee for every sampler input or callback.

One sample invocation shares limits of 10,000 inspected candidate/schema nodes,
32 nested candidate-data levels, 1,048,576 UTF-16 text code units (including
keys), and 16,777,216 abstract comparison-work units. Both inspected operand
sizes are charged before each native comparison, including duplicate/cache-like
repeated values. The text budget is not a UTF-8 byte budget or a hard runtime
SLA. Object key enumeration itself still occurs before its count can be checked;
the existing outer HTTP/project input bounds remain necessary. The existing
100 generated array-item and final 1 MiB encoded output limits remain unchanged.
Exceeding these bounds fails explicitly; there is no success fallback or partial
sample. A later request receives a fresh budget.

Top-level explicit const/example/default values remain illustrative overrides,
not promises of full JSON Schema certification. Ordinary Mock condition eq/neq
text semantics, native Mock matching, script Mock templates, and field rules are
not changed by this fix. JSON data is compared, not reordered or rewritten in
the saved project. Owner-save, Mock GET, failed generation, healthy follow-up,
and reopen tests assert that requests do not mutate stored project state.

References:
- https://json-schema.org/draft/2020-12/json-schema-core#section-4.2.2
- https://json-schema.org/draft/2020-12/json-schema-validation#section-6.4.3
