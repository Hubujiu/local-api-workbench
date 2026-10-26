import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateMockResponse } from "../public/response-example.js";
const formats = {
  "application/json": "json",
  "application/xml": "xml",
  "text/html": "html",
  "text/plain": "text",
};
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
function schema(value, depth = 0) {
  if (
    !object(value) ||
    depth > 40 ||
    Buffer.byteLength(JSON.stringify(value)) > 262144
  )
    throw Error("原生响应导出需要有界的内联对象schema");
  const visit = (node, level) => {
    if (level > 40) throw Error("原生响应schema层级超过40");
    if (!node || typeof node !== "object") return;
    if (
      ["$ref", "$dynamicRef", "$recursiveRef"].some((key) =>
        Object.hasOwn(node, key),
      ) ||
      (typeof node.ref === "string" && node.ref.startsWith("#/"))
    )
      throw Error("原生响应导出尚不支持模型引用");
    for (const child of Object.values(node)) visit(child, level + 1);
  };
  visit(value, depth);
  return structuredClone(value);
}
export function exportApipostResponses(request) {
  const examples = request.examples || [],
    responses = request.responses || [];
  if (
    !Array.isArray(examples) ||
    !Array.isArray(responses) ||
    examples.length > 100 ||
    responses.length > 100
  )
    throw Error("原生响应示例/定义最多100项");
  const definitions = new Map();
  for (const response of responses) {
    if (
      !object(response) ||
      Object.keys(response).some(
        (k) => !["status", "description", "schema", "content"].includes(k),
      ) ||
      !/^[1-5][0-9]{2}$/.test(String(response.status)) ||
      typeof response.description !== "string" ||
      !object(response.content)
    )
      throw Error("原生响应定义含不能表达的字段");
    const media = Object.keys(response.content);
    if (media.length !== 1 || !Object.hasOwn(formats, media[0]))
      throw Error("原生响应须明确单一支持的媒体类型");
    const content = response.content[media[0]];
    if (!object(content) || Object.keys(content).some((k) => k !== "schema"))
      throw Error("原生响应内容定义不可丢弃");
    const definition = schema(content.schema ?? response.schema ?? {});
    if (
      response.schema !== undefined &&
      !isDeepStrictEqual(response.schema, definition)
    )
      throw Error("响应顶层及媒体schema不一致");
    const key = response.status + ":" + media[0];
    if (definitions.has(key)) throw Error("原生响应状态/媒体定义重复");
    definitions.set(key, {
      schema: definition,
      name: response.description,
      used: false,
    });
  }
  const exampleKeys = new Set();
  const output = examples.map((example, index) => {
    if (
      !object(example) ||
      Object.keys(example).some(
        (k) => !["name", "status", "headers", "body", "delayMs"].includes(k),
      ) ||
      typeof example.name !== "string" ||
      !example.name.trim() ||
      example.name.length > 200
    )
      throw Error("原生响应示例含不能表达的字段或名称");
    validateMockResponse(example, { allowInformational: true });
    const headers = Object.fromEntries(
      Object.entries(example.headers || {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const media = headers["content-type"];
    if (!Object.hasOwn(formats, media))
      throw Error("原生响应示例需要明确支持的Content-Type");
    const exampleKey = example.status + ":" + media;
    if (exampleKeys.has(exampleKey)) throw Error("原生响应状态/媒体示例重复");
    exampleKeys.add(exampleKey);
    const definition = definitions.get(exampleKey);
    if (definition && definition.name !== example.name)
      throw Error("原生响应示例名称与定义说明不一致");
    if (definition?.used) throw Error("原生响应状态/媒体示例重复");
    if (definition) definition.used = true;
    return {
      example_id:
        "example_" +
        createHash("sha256")
          .update(String(request.id) + "\0" + String(index))
          .digest("hex")
          .slice(0, 24),
      raw_parameter: [],
      raw: example.body,
      headers: Object.entries(headers).map(([key, value], i) => ({
        param_id: `response_${index}_${i}`,
        key,
        value,
        is_checked: 1,
      })),
      expect: {
        is_default: -1,
        verify_type: "schema",
        mock: "",
        name: example.name,
        code: String(example.status),
        content_type: formats[media],
        schema: definition?.schema ?? {},
        ...(example.delayMs === undefined ? {} : { sleep: example.delayMs }),
      },
    };
  });
  if ([...definitions.values()].some((d) => !d.used))
    throw Error("原生响应定义须有明确正文示例；不会丢弃无示例schema");
  return { is_check_result: -1, example: output };
}
