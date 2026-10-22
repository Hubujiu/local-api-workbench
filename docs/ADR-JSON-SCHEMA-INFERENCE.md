# Infer a model from a JSON example

The original model editor documents JSON, XML, JSON Schema and MySQL DDL inputs:
https://wiki.apipost.cn/docs/schema/create/ . This addition covers JSON examples
only; existing raw Schema editing remains separate. It is not an XML/DDL model
importer or evidence of native project-directory compatibility.

Inference is local and pure. It preserves primitive types, object properties and
array item structures; distinct array shapes become `anyOf`, with no truncation.
It retains the parsed example for reproducible request-body generation. A single
example does not establish requiredness, formats, ranges or length constraints,
so those are not invented. Empty arrays have unconstrained items.

Limits: 64 KiB UTF-8 source, 2000 value nodes, depth 20 (root zero), and 16 distinct
array structures. Non-finite numbers and unsafe integers reject; precise large
numbers should be strings. Parsing uses JavaScript JSON number semantics, not
arbitrary precision or raw-text preservation. Literal property names do not
modify prototypes. No source URL, file or network request is evaluated.

Generation replaces only the visible Schema draft. Invalid input leaves that
draft unchanged; closing the dialog discards it. Model/project saves remain
explicit. Manual creation and rename reject duplicate trimmed names before
changing model data; existing identity, folder and linked-component rules stay
in effect. Historical imported duplicate names are not silently renamed.
