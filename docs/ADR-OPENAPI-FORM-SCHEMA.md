# Preserve form schema constraints

Form values are request payload data, not automatically schema declarations.
The exporter previously rebuilt the root using only type, properties and
required, dropping root bounds, closed-object rules and annotations. It also
replaced imported binary field schemas with a minimal binary schema.

Retain the root schema's other keywords while rebuilding explicitly declared
fields and their required flags. Preserve required names not represented by a
declared editor field. Do not invent an object type when an imported schema did
not specify one. Native new forms still get the existing generated object
schema. Explicit non-object form types are unsupported and rejected.

An imported field found only in an example gets `schemaDefined: false`. Keep its
payload value, but do not add it to properties. Otherwise an invalid extra key
could silently become permitted under additionalProperties: false. Renaming,
applying a parameter definition/dictionary, or changing its file/text kind is
an explicit declaration edit and clears this marker. Merely editing its value
does not. Duplicate payload keys remain rejected independently of declarations.

Keep imported binary/base64 file schemas, including their constraints. Root
keywords unsupported by the existing OpenAPI 3.0 exporter now reach that
exporter's explicit rejection instead of disappearing. Workbench JSON retains
the original schema and marker. This is not support for composed/nested forms,
arbitrary encoding or full dialect conversion.

Regression checks compare independent validator results, preserve invalid
examples without legitimizing them, cover required names and file metadata,
and exercise explicit declaration edits through the browser editor.
