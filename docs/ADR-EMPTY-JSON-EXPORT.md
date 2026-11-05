# Empty JSON definition exports

Ordinary HTTP execution treats an exactly empty JSON body as `{}`. Literal
request export now applies that same fallback in the shared temporary preparation
used by cURL, Node, Python and Go. The normalized saved definition remains empty;
this is not a persistence migration or a change to runtime replay evidence.

Only `bodyType: json` with normalized `body === ""` receives the fallback.
Nonempty text is never parsed or reserialized by export, including whitespace,
duplicate JSON keys and large numbers. Whitespace-only JSON remains invalid in
ordinary execution; export still preserves it literally. Raw bodies are not
classified by Content-Type. In particular imported `curl --json ''` remains raw
and empty. None, URL-encoded and multipart behavior is unchanged. GET/HEAD code
examples remain rejected; cURL retains its existing explicit-method behavior.

Fixed loopback tests compare runtime with generated cURL, Node and Python, and Go
when a real Go toolchain is available. cURL wire execution requires a probed
POSIX `/bin/sh`; hosts without it skip only cURL execution, not other targets.
Assertions cover body bytes, method,
Content-Type and Content-Length. The existing body-less cURL POST omits
Content-Length while runtime sends zero; this client default is preserved and
asserted separately. Tests also cover inherited media types, environment values
resolving to empty text, no script execution, no request during generation, and
unchanged input/project state. A separate loopback probe confirms neither the
main request nor before/after scripts run during export. A positive control runs
the same authored fixture through `runPlan` and observes before/main/after calls.
No original program or external target is executed.
