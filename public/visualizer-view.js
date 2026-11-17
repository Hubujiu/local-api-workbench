// Parse into an inert template, then copy only presentation nodes to a fresh tree.
// The result is additionally isolated by an opaque sandbox and a deny-network CSP.
export function visualizerDocument(html, document) {
  if (
    typeof html !== "string" ||
    new TextEncoder().encode(html).length > 262144
  )
    throw Error("可视化输出超过256KiB或格式无效");
  const source = document.createElement("template");
  source.innerHTML = html;
  const output = document.createElement("div");
  const allowed = new Set(
    "div span p br hr pre code strong em b i u s small h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td blockquote".split(
      " ",
    ),
  );
  let nodes = 0;
  function copy(from, into, depth) {
    if (++nodes > 10000 || depth > 32)
      throw Error("可视化DOM超过节点/深度限制");
    if (from.nodeType === 3) {
      into.append(document.createTextNode(from.textContent));
      return;
    }
    if (
      from.nodeType !== 1 ||
      from.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      !allowed.has(from.localName)
    )
      return;
    const element = document.createElement(from.localName);
    for (const attribute of ["class", "title", "dir", "lang"])
      if (from.hasAttribute(attribute))
        element.setAttribute(attribute, from.getAttribute(attribute));
    for (const attribute of ["colspan", "rowspan"])
      if (/^[1-9][0-9]?$/.test(from.getAttribute(attribute) || ""))
        element.setAttribute(attribute, from.getAttribute(attribute));
    for (const child of from.childNodes) copy(child, element, depth + 1);
    into.append(element);
  }
  for (const child of source.content.childNodes) copy(child, output, 0);
  const stylesheet = new URL("/visualizer.css", document.baseURI).href;
  const escaped = stylesheet
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/'/g, "&#39;");
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src ' +
    escaped +
    "; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\"><link rel=\"stylesheet\" href=\"" +
    escaped +
    '"></head><body>' +
    output.innerHTML +
    "</body></html>"
  );
}
export function mountVisualization(frame, html, document) {
  frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer";
  frame.srcdoc = visualizerDocument(html, document);
}
