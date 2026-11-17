# Python literal UTF-8 request code export

The existing HAR-to-code product goal supports generating request examples. This
change is an independent backend implementation, not a claim of byte-for-byte
matching output from the original application. No original application or script
was executed to implement this change.

The previous Python generator inserted raw text into a Python bytes literal and
therefore rejected non-ASCII bodies. Python now has a small standard-library
`http.client` renderer. It encodes validated literal text to UTF-8 at generation
time and escapes each non-printable, non-ASCII, quote or backslash byte as `\xHH`.
The generated payload is bytes, not a Python Unicode string or a parsed JSON
object. JSON whitespace, duplicate keys and large numbers remain untouched.
Raw, JSON, XML and already serialized URL-encoded text use the same byte path.
Empty explicit text uses `b""`; absent bodies still omit the body argument.
The later [empty JSON fallback](ADR-EMPTY-JSON-EXPORT.md) prepares `{}` for
exactly empty ordinary JSON definitions before this byte renderer.

The renderer retains the previous connection scheme/host/port, pathname and
query behavior. Fragments are not transmitted. Existing URL, method, header,
authentication and unsupported-body validation remains in front of rendering.
Invalid Unicode and the 1 MiB serialized-input and generated-output budgets
remain enforced. Byte escaping can reach the output budget before the input
budget. Multipart, binary, files, protocol scripts, unsupported authentication,
transport-control headers and GET/HEAD bodies are not newly supported. Ordinary
pre/post scripts are not executed or embedded. Node and Go rendering is unchanged.

Generation returns code only. It does not send the request, execute supplied
scripts or change the project. Code intentionally includes selected request
credentials, so the existing warning against public sharing remains; credentials
are not repeated in warnings. Tests execute only newly generated examples against
loopback fixtures and verify raw bytes, Content-Length, encoded duplicate queries,
headers, authentication, Chinese, emoji, combining characters, quotes,
backslashes, CRLF, NUL, other control characters and code-looking strings.
The UTF-8 regression requires an actual Python 3 interpreter and fails rather than
silently skipping if it is unavailable. HTTP endpoint tests verify unchanged
project state and body-free Unicode rejection errors.
