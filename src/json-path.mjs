// Single-value lookup paths, not an evaluator or a full JSONPath query engine.
export function jsonPathSegments(path) {
  const source = String(path),
    parts = [];
  let at = 0;
  const invalid = () => {
    throw Error("JSON 路径仅支持点字段、引号字段和非负索引");
  };
  if (source.length > 4096) throw Error("JSON 路径超过长度上限");
  const push = (key) => {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw Error("禁止的 JSON 路径");
    if (!key.isWellFormed()) invalid();
    parts.push(key);
    if (parts.length > 64) throw Error("JSON 路径超过层级上限");
  };
  const whitespace = () => {
    while (at < source.length && /[ \t\r\n]/.test(source[at])) at++;
  };
  const hex = () => {
    const text = source.slice(at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(text)) invalid();
    at += 4;
    return parseInt(text, 16);
  };
  function quoted() {
    const quote = source[at++];
    let value = "";
    while (at < source.length) {
      const character = source[at++];
      if (character === quote) return value;
      if (character === "\\") {
        const escaped = source[at++];
        if (escaped === quote) value += quote;
        else if (escaped === "u") {
          const first = hex();
          if (first >= 0xd800 && first <= 0xdbff) {
            if (source.slice(at, at + 2) !== "\\u") invalid();
            at += 2;
            const second = hex();
            if (second < 0xdc00 || second > 0xdfff) invalid();
            value += String.fromCharCode(first, second);
          } else {
            if (first >= 0xdc00 && first <= 0xdfff) invalid();
            value += String.fromCharCode(first);
          }
        } else {
          const escapes = {
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
            "/": "/",
            "\\": "\\",
          };
          if (!Object.hasOwn(escapes, escaped)) invalid();
          value += escapes[escaped];
        }
      } else {
        const code = character.charCodeAt(0);
        if (code < 0x20 || (code >= 0xdc00 && code <= 0xdfff)) invalid();
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = source.charCodeAt(at);
          if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
          value += character + source[at++];
        } else value += character;
      }
    }
    invalid();
  }
  function bare() {
    const start = at;
    while (at < source.length && !".[]".includes(source[at])) at++;
    const key = source.slice(start, at);
    if (!key || key === "*" || /[\x00-\x1f]/.test(key)) invalid();
    push(key);
  }
  if (source.startsWith("$")) {
    at = 1;
    if (at < source.length && !".[".includes(source[at])) invalid();
  } else if (source && !".[".includes(source[0])) bare();
  while (at < source.length) {
    if (source[at] === ".") {
      at++;
      bare();
    } else if (source[at] === "[") {
      at++;
      whitespace();
      let key;
      if (source[at] === "'" || source[at] === '"') key = quoted();
      else {
        const start = at;
        while (at < source.length && source[at] !== "]") at++;
        key = source.slice(start, at).replace(/[ \t\r\n]+$/, "");
        if (
          !/^(0|[1-9][0-9]*)$/.test(key) ||
          !Number.isSafeInteger(Number(key))
        )
          invalid();
      }
      whitespace();
      if (source[at++] !== "]") invalid();
      push(key);
    } else invalid();
  }
  return parts;
}
