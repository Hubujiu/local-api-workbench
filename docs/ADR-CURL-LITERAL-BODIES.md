# Literal cURL request bodies

Repeated data arguments previously overwrote earlier bodies, and their default
media type was missing. Preserve ordered data joining, including empty arguments;
support literal data-binary, data-ascii, data-urlencode and json. JSON mode keeps
raw bytes rather than validating JSON. Explicit methods remain authoritative.
Header overrides, suppression and explicitly empty values stay distinct on export.
Reject file/stdin reads and mixed JSON/data/multipart modes instead of guessing.
No imported command is executed and no file is opened by import.

Fixed loopback fixtures compare actual curl, imported HTTP execution, and exported
commands in the existing Linux cURL integration entry point. Unit tests additionally
exercise import/export/reimport; browser import checks persisted Unicode content.
This is not support for arbitrary cURL flags, files, certificates or shell syntax.

Reference: https://curl.se/docs/manpage.html#--data
