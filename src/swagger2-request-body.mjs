import { importOpenAPIBody } from "./openapi-body.mjs";
import { schemaChildMode } from "../public/schema-positions.js";

const own = (value, key) => Object.hasOwn(value, key);
const fail = (message) => {
  throw Error("Swagger 2.0 " + message);
};
function object(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !descriptor.enumerable ||
        !own(descriptor, "value")
      );
    })
  )
    fail(label + "必须是普通数据对象");
}
function parameters(value = []) {
  if (!Array.isArray(value)) fail("parameters必须是数组");
  const seen = new Set();
  return Array.from(value, (parameter) => {
    object(parameter, "parameter");
    if (
      typeof parameter.name !== "string" ||
      !parameter.name ||
      !["query", "path", "header", "body", "formData"].includes(parameter.in)
    )
      fail("parameter名称或位置无效，引用须先解析");
    const key = JSON.stringify([parameter.in, parameter.name]);
    if (seen.has(key)) fail("同层parameters重复");
    seen.add(key);
    return parameter;
  });
}
function annotations(parameter) {
  if (own(parameter, "required") && typeof parameter.required !== "boolean")
    fail("required必须是布尔值");
  if (
    own(parameter, "description") &&
    typeof parameter.description !== "string"
  )
    fail("description必须是文本");
  return Object.fromEntries(
    Object.entries(parameter).filter(
      ([key]) =>
        ["required", "description"].includes(key) || key.startsWith("x-"),
    ),
  );
}
function fields(parameter, allowed) {
  for (const key of Object.keys(parameter))
    if (!allowed.includes(key) && !key.startsWith("x-"))
      fail("正文参数字段尚不能保真转换: " + key);
}
// Only visit schema positions. Examples/defaults/extensions remain literal data.
// Resolved acyclic local references work; an unresolved recursive reference cannot
// be exported to OAS3 without also migrating its definitions registry.
function bodySchema(value) {
  let nodes = 0;
  function visit(schema, depth = 0) {
    if (++nodes > 50000 || depth > 60) fail("正文Schema超过节点/深度上限");
    if (typeof schema === "boolean") fail("正文Schema须使用Swagger对象格式");
    object(schema, "正文Schema");
    if (own(schema, "$ref")) fail("正文Schema含未解析或递归引用");
    if (own(schema, "discriminator"))
      fail("正文Schema discriminator尚不能保真转换");
    if (schema.type === "file") fail("文件仅支持formData显式选择");
    for (const [key, child] of Object.entries(schema)) {
      const mode = schemaChildMode(key, child);
      if (mode === "map") {
        object(child, "Schema映射");
        for (const entry of Object.values(child)) visit(entry, depth + 1);
      } else if (mode === "list") {
        if (!Array.isArray(child)) fail("Schema组合必须是数组");
        for (const entry of child) visit(entry, depth + 1);
      } else if (mode === "schema" && typeof child !== "boolean") {
        visit(child, depth + 1);
      } else if (mode === "dependencies") {
        object(child, "Schema dependencies");
        for (const entry of Object.values(child))
          if (!Array.isArray(entry)) visit(entry, depth + 1);
      }
    }
  }
  visit(value);
  return structuredClone(value);
}
function mediaType(document, operation) {
  const consumes = own(operation, "consumes")
    ? operation.consumes
    : document.consumes;
  if (!Array.isArray(consumes) || !consumes.length)
    fail("正文需要明确非空consumes；空操作覆盖不会回退全局");
  for (const media of consumes)
    if (
      typeof media !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*;[^\r\n\0]*)?$/.test(
        media,
      )
    )
      fail("consumes媒体类型无效");
  const selected =
    consumes.find((media) => media.toLowerCase() === "application/json") ||
    consumes[0];
  return {
    selected,
    mime: selected.split(";")[0].trim().toLowerCase(),
    importNotes:
      consumes.length > 1
        ? [
            "Swagger 2.0正文仅选择媒体 " +
              selected +
              "；不是全部consumes变体的无损归档。",
          ]
        : [],
  };
}
function scalar(value, type) {
  return type === "integer"
    ? Number.isInteger(value)
    : type === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : typeof value === type;
}
function formSchema(parameter) {
  fields(parameter, [
    "name",
    "in",
    "type",
    "description",
    "required",
    "format",
    "default",
    "enum",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
  ]);
  annotations(parameter);
  if (["__proto__", "constructor", "prototype"].includes(parameter.name))
    fail("formData字段名称无效");
  const type = parameter.type;
  if (!["string", "number", "integer", "boolean", "file"].includes(type))
    fail("formData仅支持标量或文件；数组及其序列化须显式转换");
  if (type === "file") {
    if (
      Object.keys(parameter).some(
        (key) =>
          !["name", "in", "type", "required", "description"].includes(key) &&
          !key.startsWith("x-"),
      )
    )
      fail("文件字段不能携带默认值、路径或其他序列化配置");
    const schema = {
      type: "string",
      format: "binary",
      ...annotations(parameter),
    };
    delete schema.required;
    return schema;
  }
  if (own(parameter, "default") && !scalar(parameter.default, type))
    fail("formData default必须符合标量类型");
  if (
    own(parameter, "enum") &&
    (!Array.isArray(parameter.enum) ||
      !parameter.enum.length ||
      parameter.enum.some((value) => !scalar(value, type)))
  )
    fail("formData enum必须符合标量类型");
  for (const key of ["minimum", "maximum", "multipleOf"])
    if (
      own(parameter, key) &&
      (!["number", "integer"].includes(type) ||
        typeof parameter[key] !== "number" ||
        !Number.isFinite(parameter[key]) ||
        (key === "multipleOf" && parameter[key] <= 0))
    )
      fail("formData数值约束无效");
  for (const key of ["exclusiveMinimum", "exclusiveMaximum"])
    if (
      own(parameter, key) &&
      (!["number", "integer"].includes(type) ||
        typeof parameter[key] !== "boolean")
    )
      fail("formData排他边界无效");
  for (const key of ["minLength", "maxLength"])
    if (
      own(parameter, key) &&
      (type !== "string" ||
        !Number.isInteger(parameter[key]) ||
        parameter[key] < 0)
    )
      fail("formData长度约束无效");
  for (const key of ["format", "pattern"])
    if (own(parameter, key) && typeof parameter[key] !== "string")
      fail("formData文本约束无效");
  if (parameter.format === "binary")
    fail("binary格式须使用file参数，不猜测文件语义");
  return Object.fromEntries(
    Object.entries(parameter).filter(
      ([key]) => !["name", "in", "required"].includes(key),
    ),
  );
}

// Receives an already locally resolved Swagger operation. This is an original
// bounded adapter, not a full Swagger-to-OpenAPI document converter.
export function convertSwagger2Operation(document, pathItem, operation) {
  object(document, "document");
  object(pathItem, "path item");
  object(operation, "operation");
  if (document.swagger !== "2.0" || own(document, "openapi"))
    fail("版本必须明确为2.0");
  if (own(operation, "requestBody")) fail("不接受混合OAS3 requestBody");
  if (own(operation, "schemes"))
    fail("尚不支持operation schemes覆盖，不会改变现有URL方案");
  const merged = new Map();
  for (const parameter of [
    ...parameters(pathItem.parameters),
    ...parameters(operation.parameters),
  ])
    merged.set(JSON.stringify([parameter.in, parameter.name]), parameter);
  const effective = [...merged.values()];
  const bodies = effective.filter((parameter) => parameter.in === "body");
  const forms = effective.filter((parameter) => parameter.in === "formData");
  if (bodies.length > 1) fail("最多一个body参数");
  if (bodies.length && forms.length) fail("body与formData不能混用");
  const projected = structuredClone(operation);
  for (const key of ["consumes", "produces", "schemes", "requestBody"])
    delete projected[key];
  projected.parameters = structuredClone(
    effective.filter(
      (parameter) => !["body", "formData"].includes(parameter.in),
    ),
  );
  let requestBody,
    importNotes = [];
  if (bodies.length || forms.length) {
    const media = mediaType(document, operation);
    importNotes = media.importNotes;
    if (bodies.length) {
      const parameter = bodies[0];
      fields(parameter, ["name", "in", "schema", "required", "description"]);
      const schema = bodySchema(parameter.schema);
      if (
        !(
          media.mime === "application/json" ||
          media.mime.endsWith("+json") ||
          media.mime.startsWith("text/") ||
          media.mime === "application/xml" ||
          media.mime.endsWith("+xml") ||
          media.mime === "application/javascript"
        )
      )
        fail("body媒体类型尚不能保真转换: " + media.selected);
      requestBody = {
        ...annotations(parameter),
        content: {
          [media.selected]: {
            schema,
            ...(own(schema, "example")
              ? { example: structuredClone(schema.example) }
              : {}),
          },
        },
      };
    } else {
      if (
        !["application/x-www-form-urlencoded", "multipart/form-data"].includes(
          media.mime,
        ) ||
        media.selected.includes(";")
      )
        fail("formData需要无自定义序列化参数的表单媒体类型");
      if (
        media.mime !== "multipart/form-data" &&
        forms.some((parameter) => parameter.type === "file")
      )
        fail("文件字段需要显式multipart/form-data");
      const properties = Object.fromEntries(
        forms.map((parameter) => [parameter.name, formSchema(parameter)]),
      );
      const required = forms
        .filter((parameter) => parameter.required === true)
        .map((parameter) => parameter.name);
      requestBody = {
        ...(required.length ? { required: true } : {}),
        content: {
          [media.selected]: {
            schema: {
              type: "object",
              properties,
              ...(required.length ? { required } : {}),
            },
          },
        },
      };
    }
    try {
      // Preflight using the existing media/form contract; no new wire encoder.
      importOpenAPIBody(requestBody);
    } catch (error) {
      fail(error.message);
    }
    projected.requestBody = structuredClone(requestBody);
  }
  return {
    parameters: structuredClone(effective),
    requestBody,
    operation: projected,
    importNotes,
  };
}
