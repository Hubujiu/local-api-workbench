# Conservative allOf sample intersections

Deterministic sample generation now supports up to16 allOf branches for a bounded, explicit subset: object properties/required fields, compatible types, numeric and size bounds, identical constraints, enum intersections and recursively compatible item schemas. Shared property definitions intersect instead of overwriting one another. Local-reference siblings use the same conservative intersection, fixing a reproduced bug where a sibling minimum2 weakened a referenced minimum10.

Closed/additional-property schema combinations that would change allowed property sets fail, rather than silently flattening them into a different schema. Unsupported combinations, conflicting types, mixed value-choice and validation constraints, nested conditional/choice composition and different unsupported keywords require an explicit example. This is not a general JSON Schema validator/solver. Existing explicit top-level examples remain illustrative user-provided data. Original generation node/depth/output bounds remain.

Red-first tests cover combining object fields, intersecting numeric bounds, contradictory ranges, the reference-minimum regression, closed objects, enum intersection and unsupported choices. Browser generation checks a combined object's exact shape alongside existing tuple/reference constraints.

## Union alternatives

anyOf now tries up to16 branches in order, intersecting siblings rather than dropping them, skipping false or unsupported/impossible candidates. oneOf supports one surviving branch, or branches with explicit disjoint JSON types; number overlaps integer, so overlapping/unknown partitions require an example instead of silently returning a value that could match multiple branches. Branches must be Schema objects/booleans. This is a conservative generator, not full union validation, discriminator solving or arbitrary constraint search. Explicit examples/defaults/enums and field mocks retain their illustrative contract; they are not certified by a universal validator. All branch attempts share the original node budget.

The red-first regression demonstrated that a false first anyOf branch prevented a valid later branch. Tests additionally cover sibling numeric/type constraints, disjoint oneOf and overlapping number/integer rejection. Browser output verifies both a sibling-constrained alternative and a disjoint union.
