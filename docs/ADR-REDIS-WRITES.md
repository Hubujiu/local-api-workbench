# Explicit single-key Redis SET

The manual database page has a separate one-request write grant. The default
query API and every session/script database connection retain the read-only
command allowlist, even if a caller supplies allowWrite. Only the manual HTTP
route dispatches to mutateRedis after an exact boolean true grant.

The target must explicitly include Redis type, host, port and database index
0–1023. Arguments must be a dense JSON array of well-formed Unicode strings, rejecting
unpaired surrogates rather than silently replacing bytes; one nonempty key and
one value are limited to 4096 UTF-8 bytes each. Only SET is accepted, optionally
with one NX or XX condition and one EX, PX or KEEPTTL expiration choice. EX/PX
accept decimal integer strings 1–2147483647. GET, absolute expiry, multiple keys,
scripting, deletion, administrative commands and arbitrary options are refused.

Redis's [SET contract](https://redis.io/docs/latest/commands/set/) determines
replacement, expiry and conditional behavior: an ordinary SET replaces the
value and removes previous expiry, KEEPTTL retains it, and an unmet NX/XX
condition returns a null reply. The UI names the exact key and explicit target,
warns about replacement, TTL loss and inability to roll back, and requires a
confirmation. Cancellation makes no database request. The grant resets after
each attempted execution or cancellation and on provider/TLS changes.

AUTH and SELECT must each acknowledge before SET is sent. SET is sent at most
once, without reconnect or automatic retry. An OK reply means acknowledged and
applied, not guaranteed disk durability; a conditional null means acknowledged
but not applied. Any error after sending SET is conservatively reported as an
uncertain outcome, including server errors: it never promises rollback or safe
replay. Errors before SET cannot cause a write. Existing verified TLS, 3-second
total deadline and response/request byte caps are unchanged.

Protocol fixtures exercise authorization, sequencing, missing acknowledgements
and no replay. HTTP and browser fixtures exercise default rejection, cancellation,
explicit execution and grant reset. An isolated real Redis CI service validates
UTF-8/CRLF values, conditions, KEEPTTL, clearing expiry and millisecond expiry;
this is not validation against a user's production database or every Redis version.
