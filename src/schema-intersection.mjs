import { isDeepStrictEqual } from "node:util";
// Conservative intersection for deterministic sample generation, not a validator.
export function intersectSampleSchemas(left, right) {
  let nodes = 0;
  const fail = () => {
    throw Error("组合约束无法安全合并，请提供 example");
  };
  function merge(a, b, depth = 0) {
    if (++nodes > 10000 || depth > 12) fail();
    if (a === false || b === false) return false;
    if (a === true) a = {};
    if (b === true) b = {};
    if (
      !a ||
      !b ||
      typeof a !== "object" ||
      typeof b !== "object" ||
      Array.isArray(a) ||
      Array.isArray(b)
    )
      fail();
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const annotations = new Set([
      "title",
      "description",
      "$comment",
      "example",
      "examples",
      "default",
      "deprecated",
      "readOnly",
      "writeOnly",
      "$defs",
      "definitions",
    ]);
    const constraintKeys = (value) =>
      Object.keys(value).filter(
        (k) => !annotations.has(k) && !k.startsWith("x-"),
      );
    if (!constraintKeys(a).length || !constraintKeys(b).length)
      return { ...structuredClone(a), ...structuredClone(b) };
    const assertions = [...keys].filter(
      (k) => !annotations.has(k) && !k.startsWith("x-"),
    );
    if (
      assertions.some((k) =>
        [
          "allOf",
          "oneOf",
          "anyOf",
          "not",
          "if",
          "then",
          "else",
          "dependentSchemas",
          "unevaluatedProperties",
          "unevaluatedItems",
        ].includes(k),
      )
    )
      fail();
    if (
      ["const", "enum", "example", "default"].some((k) => keys.has(k)) &&
      assertions.some((k) => !["const", "enum"].includes(k))
    )
      fail();
    if (keys.has("const") && keys.has("enum")) fail();

    const properties = new Set([
      ...Object.keys(a.properties || {}),
      ...Object.keys(b.properties || {}),
    ]);
    for (const source of [a, b])
      if (
        source.additionalProperties !== undefined &&
        source.additionalProperties !== true &&
        [...properties].some((k) => !Object.hasOwn(source.properties || {}, k))
      )
        fail();
    const result = {};
    for (const k of keys) {
      const x = a[k],
        y = b[k];
      let value;
      if (!Object.hasOwn(a, k)) value = structuredClone(y);
      else if (!Object.hasOwn(b, k) || isDeepStrictEqual(x, y))
        value = structuredClone(x);
      else if (k === "type") {
        const xs = Array.isArray(x) ? x : [x],
          ys = Array.isArray(y) ? y : [y];
        const types = [
          ...new Set(
            xs.flatMap((t) =>
              ys.flatMap((u) =>
                t === u
                  ? [t]
                  : [t, u].every((v) => ["number", "integer"].includes(v))
                    ? ["integer"]
                    : [],
              ),
            ),
          ),
        ];
        if (!types.length) fail();
        value = types.length === 1 ? types[0] : types;
      } else if (
        ["minimum", "minLength", "minItems", "minProperties"].includes(k)
      ) {
        if (
          typeof x !== "number" ||
          typeof y !== "number" ||
          !Number.isFinite(x) ||
          !Number.isFinite(y)
        )
          fail();
        value = Math.max(x, y);
      } else if (
        ["maximum", "maxLength", "maxItems", "maxProperties"].includes(k)
      ) {
        if (
          typeof x !== "number" ||
          typeof y !== "number" ||
          !Number.isFinite(x) ||
          !Number.isFinite(y)
        )
          fail();
        value = Math.min(x, y);
      } else if (k === "required") {
        if (!Array.isArray(x) || !Array.isArray(y)) fail();
        value = [...new Set([...x, ...y])];
      } else if (k === "properties") {
        if (
          !x ||
          !y ||
          typeof x !== "object" ||
          typeof y !== "object" ||
          Array.isArray(x) ||
          Array.isArray(y)
        )
          fail();
        value = Object.fromEntries(
          [...new Set([...Object.keys(x), ...Object.keys(y)])].map((name) => [
            name,
            Object.hasOwn(x, name) && Object.hasOwn(y, name)
              ? merge(x[name], y[name], depth + 1)
              : structuredClone(Object.hasOwn(x, name) ? x[name] : y[name]),
          ]),
        );
      } else if (k === "enum") {
        if (!Array.isArray(x) || !Array.isArray(y)) fail();
        value = x.filter((v) => y.some((w) => isDeepStrictEqual(v, w)));
        if (!value.length) fail();
      } else if (k === "items" && !Array.isArray(x) && !Array.isArray(y))
        value = merge(x, y, depth + 1);
      else if (
        ["additionalProperties", "uniqueItems"].includes(k) &&
        typeof x === "boolean" &&
        typeof y === "boolean"
      )
        value = k === "uniqueItems" ? x || y : x && y;
      else if (
        [
          "title",
          "description",
          "$comment",
          "example",
          "examples",
          "default",
          "deprecated",
          "readOnly",
          "writeOnly",
        ].includes(k) ||
        k.startsWith("x-")
      )
        value = structuredClone(y);
      else fail();
      Object.defineProperty(result, k, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    // Boolean legacy exclusivity and numeric modern exclusivity may not safely
    // combine with a second bound unless they are identical: require an example.
    for (const k of ["exclusiveMinimum", "exclusiveMaximum"])
      if (
        Object.hasOwn(result, k) &&
        ((Object.hasOwn(a, k) &&
          !Object.hasOwn(b, k) &&
          Object.hasOwn(b, k === "exclusiveMinimum" ? "minimum" : "maximum")) ||
          (Object.hasOwn(b, k) &&
            !Object.hasOwn(a, k) &&
            Object.hasOwn(a, k === "exclusiveMinimum" ? "minimum" : "maximum")))
      )
        fail();
    return result;
  }
  return merge(left, right);
}
