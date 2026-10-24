# Bounded SSE parsing and connection lifecycle

Use eventsource-parser 4.1.2 (MIT) for incremental SSE framing instead of the two former hand-written newline splitters. The existing capture path lost bare-CR streams, could mishandle split CRLF boundaries, sent a request even when its AbortSignal was already aborted, and accepted error statuses or misleading content types as event streams. Fixed real-HTTP regression tests first reproduced those failures.

Both capture and interactive sessions now require status 200 and the exact text/event-stream media type (parameters and media-type case are accepted). Redirects remain manual; the implementation does not forward credentials, reconnect automatically or schedule retries. This is a bounded diagnostic client, not a complete browser EventSource replacement.

Each connection owns a fresh UTF-8 decoder and parser. CR, LF, split CRLF, split multibyte text, one leading BOM, multiline and empty data, event types, valid id updates including id-only blocks, id reset and invalid NUL ids follow the protocol parser. Last-event ID and valid integer retry metadata remain connection-local. Unknown fields, comments and invalid retry fields do not become data events. EOF does not invent the blank line required to dispatch unfinished data.

Existing safety ceilings remain: capture at most 100 events and 1 MiB of wire data, interactive sessions at most 8 MiB of cumulative wire data, the existing 15-minute lifecycle/5-live-session limits, and a bounded 1 Mi-character parser buffer. Each emitted event's data/type/id additionally has a 1 MiB UTF-8 ceiling. These are bounded parsing/output checks, not claims that native fetch chunks allocate nothing before a size check. Comments and discarded unknown lines also consume the wire budget.

Interactive received-event text is now a canonical event/id/data representation, not a byte-for-byte raw-wire transcript. Existing 100,000-character preview retention is preserved and explicitly labeled with a `truncated` flag. Structured `sse` metadata supplies event type, effective ID and optional numeric retry. A large preview is not presented as complete evidence. Capture results keep full accepted event data within their existing aggregate bound.

Verification covers every two-part byte split and byte-at-a-time feeding, real fragmented HTTP streams in both paths, error handshakes, cancellation before dispatch, active-stream abort/stop with no reconnect, ID-state isolation, EOF behavior, event-count stopping, and oversized comments/partial lines/multibyte payloads. Existing browser and three-platform gates remain required. No frontend development is included.

References: [WHATWG SSE parsing and interpretation](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream), [eventsource-parser](https://github.com/rexxars/eventsource-parser).
