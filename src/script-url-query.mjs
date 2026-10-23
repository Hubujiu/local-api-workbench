// Only balanced interpolation tokens are opaque; no values are resolved here.
function createURLQueryTools() {
  const positions = (text, delimiter, first = false) => {
    const tokens = /{{[^{}]*}}/g;
    let token = tokens.exec(text);
    const found = [];
    for (let i = 0; i < text.length; i++) {
      if (token && i === token.index) {
        i += token[0].length - 1;
        token = tokens.exec(text);
        continue;
      }
      if (text[i] === delimiter) {
        if (first) return i;
        found.push(i);
      }
    }
    return first ? -1 : found;
  };
  const splitURL = (value) => {
    const raw = String(value || "");
    const hash = positions(raw, "#", true);
    const base = hash < 0 ? raw : raw.slice(0, hash);
    const fragment = hash < 0 ? "" : raw.slice(hash);
    const at = positions(base, "?", true);
    return { raw, base, fragment, at, query: at < 0 ? "" : base.slice(at + 1) };
  };
  const splitQuery = (query) => {
    const result = [];
    let start = 0;
    for (const at of positions(query, "&")) {
      result.push(query.slice(start, at));
      start = at + 1;
    }
    result.push(query.slice(start));
    return result;
  };
  const remove = (value, names) => {
    const url = splitURL(value);
    if (url.at < 0) return url.raw;
    const selected = new Set(names),
      rows = splitQuery(url.query);
    const kept = rows.filter((row) => {
      const at = positions(row, "=", true);
      const key = at < 0 ? row : row.slice(0, at);
      try {
        return !selected.has(decodeURIComponent(key.replace(/\+/g, " ")));
      } catch {
        return true;
      }
    });
    if (kept.length === rows.length) return url.raw;
    return (
      url.base.slice(0, url.at) +
      (kept.length ? "?" + kept.join("&") : "") +
      url.fragment
    );
  };
  return Object.freeze({ splitURL, splitQuery, remove });
}
export const urlQueryToolsSource = createURLQueryTools.toString();
export const urlQueryTools = createURLQueryTools();
