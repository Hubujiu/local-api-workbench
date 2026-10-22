# Bounded MySQL model inference

The model input choices documented by the original application include MySQL DDL:
https://wiki.apipost.cn/docs/schema/create/ . This preview reuses the existing
static dictionary parser rather than introducing a second SQL parser. The shared
implementation lives in public/mysql-ddl.js; the server module re-exports it.
No SQL is connected, submitted or evaluated.

The model preview accepts at most 64 KiB and one CREATE TABLE. The dictionary
parser retains its 1 MiB limit, 20000-token/32-parenthesis-depth/1000-column limits
and rejection of multiple statements or executable comments. Duplicate column
names, unsupported types, unsafe names and unsafe numeric defaults reject before
changing the draft. Column-name comparison is case-insensitive.

Properties retain the dictionary's finite type mapping, string enums, comments
and compatible literal defaults. Expressions remain visible notes, never computed
values. Incompatible typed defaults and defaults outside an enum reject rather
than silently coercing or generating an invalid example. SQL DEFAULT NULL remains
a visible note, not an inferred API default. NOT NULL remains a note, not a claim
that an API property must be supplied.

This is not complete database-to-API schema inference. It does not derive table
key constraints, nullable unions, string lengths, numeric precision, date formats,
SQL-mode conversions or generated columns. In particular the inherited TINYINT(1)
boolean and JSON-object mappings are compatibility approximations, not the full
set of values MySQL accepts. Users review the raw Schema before confirming and
can edit constraints explicitly. XML model input remains unsupported.

Errors preserve the previous draft; confirmation and project save remain explicit.
