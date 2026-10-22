# XML examples as JSON-shaped model input

The original editor lists XML as a model input:
https://wiki.apipost.cn/docs/schema/create/ . This mode converts an XML example
into an explicit JSON representation, then uses the existing bounded type/shape
inference. It is not an XSD generator or XML request-body serializer.

The conversion is shared with the existing isolated xml2Json script helper.
Browser previews use the browser's detached DOM parser; the script wrapper keeps
its pinned xmldom parser inside QuickJS. Neither exposes DOM objects to scripts
or inserts source XML into the live page. Browser parse-error documents reject.

The root name is preserved. Attributes live under `$`, leaf text stays a string,
repeated same-name children become arrays, and text accompanying attributes lives
under `_`. CDATA becomes text; namespace-qualified names stay explicit. Comments
and processing instructions are ignored. Cross-name element ordering and original
XML serialization are not preserved. No number/boolean coercion is guessed.

DTD/entity declarations, undeclared entities, malformed input and mixed text with
child elements reject. No external entities, schemas, stylesheets or documents are
loaded. XML conversion retains its 64 KiB/10000-node/depth-32 guards, followed by
model JSON bounds of 64 KiB/2000 value nodes/depth 20 and 16 array variants. These
can be stricter after conversion and JSON escaping. The parser-error namespace is
reserved for diagnostics, not accepted as ordinary input.

Preview errors retain the previous draft. The converted example remains explicit
and must be updated or removed when later editing structure. Confirmation and
project save are separate; this does not establish native Offline2 migration.

Native DOMParser reports invalid XML as an error document instead of invoking the
xmldom error callback. Both Gecko and Chromium/WebKit parsererror namespaces are
rejected conservatively. An ordinary unnamespaced element named parsererror is
still valid input. The original browser malformed-input rejection assertion is
retained unchanged.
