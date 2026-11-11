# MySQL raw port text admission

The shared database page previously called `Number()` before sending either a
manual query or a session-registration request. This erased exponent, hexadecimal,
signed and fractional spelling before the backend could reject it. Non-numeric
text also became `null` during JSON serialization.

Only the MySQL branch of those two handlers now validates the original text.
After trimming outer whitespace it accepts ASCII decimal digits and values
0–65535. Empty text and zero retain the existing default-port convention; leading
zeroes and surrounding whitespace remain compatible. Invalid text produces one
fixed message before any fetch or authorization dialog. Correcting the field does
not require reloading the page. Backend validation remains independently required.

Other database providers keep their existing conversion and authorization
contracts. In particular this change does not add defaults to Redis writes, alter
PostgreSQL write confirmation, or apply a MySQL guard to SQLite's hidden field.
It does not change the protocol page, database transport, grants, SQL or deadlines.

`mysql-port-input.test.mjs` covers the pure conversion. The actual browser flow in
`helpers/mysql-port-ui.mjs` is included by the existing `ui-smoke.mjs`, and can also
be run using `node tests/mysql-port-ui.mjs`. It operates the real page but intercepts
database responses, so it proves frontend admission and unchanged non-MySQL wire
conversion, not real server acceptance, database connectivity or authentication.
The fixture checks both entrypoints, no fetch/no dialog on rejection, correction,
default/decimal compatibility, and non-MySQL including hidden SQLite state.
