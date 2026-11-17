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

The first CI comparison exposed a real version difference: curl 8.5.0 sends
`&a=1` for `-d '' -d a=1`, while the local curl 8.14.1 sends `a=1`. A pasted
command does not identify its source version. Therefore repeated data after an
empty prefix is explicitly rejected, rather than guessing. A single empty body,
trailing empty pieces and JSON concatenation remain supported. The original
counterexample stays in both the unit and actual-curl tests as a required refusal;
normal-body wire comparisons are unchanged. Users can disambiguate by combining
their intended bytes into one literal data-raw argument.

The literal tokenizer also preserves backslashes before ordinary characters inside
double quotes and removes backslash-newline continuations without inventing empty
arguments. It does not read shell variables or evaluate command substitutions.
Recognized expansions, unquoted command operators and comments are rejected;
single-quoted or escaped literal dollar signs remain usable. This is a bounded
import parser, not a shell interpreter. Fixed, reviewed quoting fixtures are checked
against a real noninteractive shell and curl only inside the Linux test entry point.
No imported user command is executed by the product or test helpers.

Quoting reference: https://www.gnu.org/s/bash/manual/html_node/Double-Quotes.html
