# Literal cURL query options

The importer supports -G/--get and literal --url-query arguments. The
[cURL manual](https://curl.se/docs/manpage.html#--url-query) defines query
arguments and the leading-plus unencoded form; --get moves data into the query
rather than a request body. File arguments are never read and shell expansion
is never evaluated.

The accepted subset preserves explicit -X methods, duplicate and empty-valued
parameters, existing query spelling and fragments. Appended percent escapes
use lowercase hex, matching native cURL observations; preexisting escapes are
not rewritten. JSON's explicit default headers survive --get, while ordinary
form-data defaults are not invented when no body is sent. --url-query can
coexist with an ordinary body without changing its method or contents.

New query fragments must be nonempty encoded ASCII URL text, with valid percent
triplets and a combined 64 KiB cap. At most 1000 --url-query fragments are
accepted. Raw whitespace, Unicode, fragment markers and unsafe URL characters
are refused; urlencode forms encode values before validation. Raw names must
already be encoded. Empty query data and multipart with --get are refused.
Combining --get and --url-query is also refused: a native probe dropped the
url-query data in that combination, so the importer must not silently invent a
merge. These restrictions are not full cURL CLI compatibility.

Fixed loopback fixtures compare native cURL against the importer and exported
commands, including exact request-target bytes rather than decoded query maps.
Core tests also exercise real HTTP and export/reimport on each platform.
The browser checks persisted query bytes alongside a separately preserved body.
No user-provided command is executed, no remote account is contacted, and no
network, TLS or shell safety boundary changes.
