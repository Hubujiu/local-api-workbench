// Import-time scalar selection only. Existing stored rows, transport encoders,
// Swagger imports and independently supported compound parameters are unchanged.
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const scalarTypes = new Set(["string", "number", "integer", "boolean"]);
const fail = (message) => {
  throw Error("OpenAPI标量参数 " + message);
};

export function importOpenAPIScalarValue(parameter, legacyValue = "") {
  const schema = parameter.schema;
  // This slice must not reinterpret arrays/objects, content encodings, unions,
  // or other compound contracts. In root integration arrays use their own codec.
  if (
    own(parameter, "content") ||
    (object(schema) &&
      ((own(schema, "type") && !scalarTypes.has(schema.type)) ||
        ["allOf", "anyOf", "oneOf"].some((key) => own(schema, key))))
  )
    return legacyValue;
  if (own(parameter, "example") && own(parameter, "examples"))
    fail("example和examples不能同时提供");
  let value;
  if (own(parameter, "example")) value = parameter.example;
  else if (own(parameter, "examples")) {
    if (
      !object(parameter.examples) ||
      Object.keys(parameter.examples).length !== 1
    )
      fail("examples须只有一个明确的内联value，不能自动选择");
    const example = Object.values(parameter.examples)[0];
    if (
      !object(example) ||
      !own(example, "value") ||
      own(example, "$ref") ||
      own(example, "externalValue")
    )
      fail("examples不支持外部、未解析引用或缺失value");
    value = example.value;
  } else if (object(schema) && own(schema, "default")) value = schema.default;
  else if (object(schema) && own(schema, "example")) value = schema.example;
  else return legacyValue;
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    (typeof value === "number" &&
      (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))))
  )
    fail("选定值须为文本、有限安全数值或布尔值；不隐式转换null或复合值");
  return value;
}
