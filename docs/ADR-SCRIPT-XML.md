# Bounded XML response conversion

The official built-in library documentation shows xml2Json(text) returning a named root with text children: https://wiki.apipost.cn/docs/usescript/js/ . Postman's legacy example uses an attribute map under $: https://github.com/postmanlabs/postman-collection/issues/285 . This bounded contract does not establish full current Offline2 or x2js/xml2js equivalence.

Bundle the already pinned @xmldom/xmldom 0.9.12 dependency inside QuickJS, using a private imported DOMParser in the bundle. Neither a host callback nor a DOMParser global is exposed. Include its license and retain byte-reproducible bundle generation in CI. No new dependency version, host import, network/filesystem permission, memory increase or time increase.

The independently implemented converter returns string leaves, arrays for repeated same-name children, attributes under $, and text of attributed leaves under _. Preserve namespace-qualified names and namespace attributes; do not coerce numeric/boolean strings. Empty elements yield empty strings. Comments/processing instructions are ignored. Reject mixed non-whitespace text with element children instead of losing ordering. Prototype-shaped XML names are data, accumulated in null-prototype maps.

Limits: one string argument, 64 KiB UTF-8, 10000 traversed nodes/attributes and depth32. Reject DTD/entity declarations before parsing, unknown entities and malformed XML through parser errors; the declaration guard is intentionally conservative even within literal CDATA. All parsing/conversion runs within the existing 16 MiB VM, cumulative250ms active execution and2s deadline, with unchanged output limits. Repeated calls cannot reset those outer budgets. No optional parser configuration or xml2js require alias.

Red-first tests cover response XML, attributes/repeated children/CDATA, malicious/malformed/mixed input, bytes/depth/nodes, prototype-shaped names and absent DOM globals. Real browser and all three packaged desktop scripts exercise conversion, and CI reproduces the generated library and license bundle.


Resumed validation exposed excessive DOM allocation in the node-limit negative case. An early element ceiling now rejects it before DOM construction, ignoring literal markup in comments, CDATA and processing instructions. Traversal retains the combined node/attribute ceiling. Each independent invalid-input regression runs within the unchanged normal script budget; no production timeout or assertion was relaxed.
