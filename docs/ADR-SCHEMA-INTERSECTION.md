# Conservative allOf sample intersections

Deterministic sample generation now supports up to16 allOf branches for a bounded, explicit subset: object properties/required fields, compatible types, numeric and size bounds, identical constraints, enum intersections and recursively compatible item schemas. Shared property definitions intersect instead of overwriting one another. Local-reference siblings use the same conservative intersection, fixing a reproduced bug where a sibling minimum2 weakened a referenced minimum10.

Closed/additional-property schema combinations that would change allowed property sets fail, rather than silently flattening them into a different schema. Unsupported combinations, conflicting types, mixed value-choice and validation constraints, nested conditional/choice composition and different unsupported keywords require an explicit example. This is not a general JSON Schema validator/solver. Existing explicit top-level examples remain illustrative user-provided data. Original generation node/depth/output bounds remain.

Red-first tests cover combining object fields, intersecting numeric bounds, contradictory ranges, the reference-minimum regression, closed objects, enum intersection and unsupported choices. Browser generation checks a combined object's exact shape alongside existing tuple/reference constraints.

## Union alternatives

anyOf now tries up to16 branches in order, intersecting siblings rather than dropping them, skipping false or unsupported/impossible candidates. oneOf supports one surviving branch, or branches with explicit disjoint JSON types; number overlaps integer, so overlapping/unknown partitions require an example instead of silently returning a value that could match multiple branches. Branches must be Schema objects/booleans. This is a conservative generator, not full union validation, discriminator solving or arbitrary constraint search. Explicit examples/defaults/enums and field mocks retain their illustrative contract; they are not certified by a universal validator. All branch attempts share the original node budget.

The red-first regression demonstrated that a false first anyOf branch prevented a valid later branch. Tests additionally cover sibling numeric/type constraints, disjoint oneOf and overlapping number/integer rejection. Browser output verifies both a sibling-constrained alternative and a disjoint union.

## Required string-tagged object unions

When types overlap, oneOf may also prove object branches disjoint using a common
required property with nonoverlapping string const/enum values. Every branch must
explicitly be an object and require that property; a discriminator hint alone is
not a constraint. Only finite string choices with compatible type and annotations
are accepted. Additional tag validation keywords, sparse/duplicate choices and
overlapping value sets require an explicit example instead of guesswork.

Inspect at most32 candidate properties,100 values per tag and1024 characters per
value. Proof work shares the existing10000-node budget;16 branches and the original
depth/output caps remain. Keep sibling constraints, try later supported branches
if an earlier one is impossible, and verify the generated tag after illustrative
overrides. This does not interpret discriminator mappings or become a universal
validator; explicit examples/defaults retain their established illustrative role.

Independent Ajv checks valid generated objects and sibling preservation. Negative
cases cover missing/overlapping tags, unsupported tag constraints, bad overrides
and shared-budget exhaustion. The existing browser generation workflow also checks
a tagged object's actual request-body output.
