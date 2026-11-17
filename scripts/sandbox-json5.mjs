import JSON5 from "json5";

function checkText(text, label) {
  if (typeof text !== "string") throw Error(`JSON5 ${label}需要字符串`);
  if (text.length > 65536) throw Error(`JSON5 ${label}最多64KiB`);
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > 65536) throw Error(`JSON5 ${label}最多64KiB`);
  }
  return text;
}

// Preflight plain data before JSON5's character-by-character serializer. Accessors
// are not evaluated twice; their eventual execution stays under the VM budget.
function checkValue(
  value,
  seen = new WeakSet(),
  depth = 0,
  budget = { nodes: 0 },
) {
  if (++budget.nodes > 10000 || depth > 32)
    throw Error("JSON5 数据最多10000节点/32层");
  if (typeof value === "string") checkText(value, "字符串值");
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Object.keys(value)) {
    checkText(key, "属性名");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value"))
      checkValue(descriptor.value, seen, depth + 1, budget);
  }
}

// All parsing, callbacks and serialization stay inside the existing QuickJS VM.
export const boundedJSON5 = Object.freeze({
  parse(text, reviver) {
    return JSON5.parse(checkText(text, "输入"), reviver);
  },
  stringify(value, replacer, space) {
    checkValue(value);
    const text = JSON5.stringify(value, replacer, space);
    return text === undefined ? undefined : checkText(text, "输出");
  },
});
