import { createHash } from "node:crypto";
import {
  responseMediaEntries,
  isJsonResponseType,
  isResponseMediaType,
} from "./response-media.mjs";
import { validateMockResponse } from "../public/response-example.js";
const own = (object, key) => Object.hasOwn(object, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const encoder = new TextEncoder();
const concrete = (status) => /^[1-5]\d\d$/.test(String(status));
const baseType = (type) => type.split(";")[0].trim().toLowerCase();
function textType(type) {
  const base = baseType(type);
  return (
    base.startsWith("text/") ||
    base.endsWith("+xml") ||
    [
      "application/xml",
      "application/javascript",
      "application/graphql",
      "application/x-www-form-urlencoded",
    ].includes(base)
  );
}
function bindingKey(source) {
  return JSON.stringify([
    String(source.status),
    source.mediaType,
    source.kind,
    source.key ?? null,
  ]);
}
function sourceHash(annotation) {
  let nodes = 0;
  const canonical = (value, depth = 0) => {
    if (++nodes > 100000 || depth > 64)
      throw Error("响应示例结构超过100000节点或64层");
    if (Array.isArray(value))
      return value.map((item) => canonical(item, depth + 1));
    if (object(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key], depth + 1)]),
      );
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(annotation)))
    .digest("hex");
}
function budget() {
  let count = 0,
    bytes = 0;
  return (body = "") => {
    if (++count > 1000) throw Error("每个接口响应示例最多1000项");
    bytes += encoder.encode(body).length;
    if (bytes > 8 * 1024 * 1024)
      throw Error("每个接口响应示例正文合计最多8MiB");
  };
}
export function responseContent(response, produces = ["application/json"]) {
  if (!object(response)) throw Error("响应定义必须是对象");
  if (response.content !== undefined) return response.content;
  const content = Object.create(null);
  if (response.schema !== undefined) {
    if (
      !Array.isArray(produces) ||
      produces.length === 0 ||
      produces.length > 1000
    )
      throw Error("响应媒体定义无效");
    for (const type of produces) {
      if (!isResponseMediaType(type)) throw Error("响应媒体类型无效");
      content[type] = { schema: response.schema };
    }
  }
  if (response.examples !== undefined) {
    if (!object(response.examples)) throw Error("响应示例必须是媒体类型映射");
    for (const [type, value] of Object.entries(response.examples)) {
      if (!isResponseMediaType(type)) throw Error("响应示例媒体类型无效");
      content[type] = { ...content[type], example: value };
    }
  }
  return Object.fromEntries(Object.entries(content));
}
function sourceEntries(responses) {
  const entries = [],
    notes = new Set(),
    consume = budget();
  for (const [status, response] of Object.entries(responses)) {
    if (!concrete(status)) continue;
    const mediaEntries = responseMediaEntries(response.content).sort(
      ([a], [b]) => {
        const priority = (type) =>
          baseType(type) === "application/json"
            ? 0
            : isJsonResponseType(type)
              ? 1
              : 2;
        return priority(a) - priority(b);
      },
    );
    for (const [type, media] of mediaEntries) {
      if (!isResponseMediaType(type)) throw Error("响应示例媒体类型无效");
      if (own(media, "example") && own(media, "examples"))
        throw Error("响应示例example与examples不能同时存在");
      const add = (value, kind, key, descriptor) => {
        let body;
        if (isJsonResponseType(type)) body = JSON.stringify(value, null, 2);
        else if (textType(type) && typeof value === "string") body = value;
        else
          throw Error("此响应示例媒体类型或值暂不支持；文字/XML示例须为字符串");
        const name =
          kind === "examples"
            ? (descriptor.summary ?? key)
            : response.description || status;
        if (typeof name !== "string" || name.length > 8192)
          throw Error("响应示例名称格式无效或超过8192字符");
        validateMockResponse(
          { status: Number(status), body, headers: { "content-type": type } },
          { allowInformational: true },
        );
        consume(body);
        entries.push({
          name,
          status: Number(status),
          body,
          headers: { "content-type": type },
          openapiExampleSource: {
            status,
            mediaType: type,
            kind,
            sourceSHA256: sourceHash(descriptor || { value }),
            ...(key !== undefined ? { key } : {}),
          },
          descriptor,
        });
      };
      if (own(media, "example")) add(media.example, "example");
      if (own(media, "examples")) {
        if (!object(media.examples)) throw Error("响应命名示例必须是对象");
        for (const [key, descriptor] of Object.entries(media.examples)) {
          if (!object(descriptor)) throw Error("响应命名示例定义必须是对象");
          if (own(descriptor, "value") && own(descriptor, "externalValue"))
            throw Error("响应示例value与externalValue不能同时存在");
          if (own(descriptor, "value"))
            add(descriptor.value, "examples", key, descriptor);
          else {
            consume();
            notes.add("外部或无内联值的响应示例仅保留原定义，不下载或执行。");
          }
        }
      }
    }
  }
  return { entries, notes: [...notes] };
}
export function importResponseExamples(responses) {
  const { entries, notes } = sourceEntries(responses);
  return {
    examples: entries.map(({ descriptor, ...example }) => example),
    importNotes: notes,
    openapiExampleSources: entries.map((entry) =>
      structuredClone(entry.openapiExampleSource),
    ),
  };
}
export function appendResponseExamples(
  responses,
  examples,
  { managed = false, registry = [] } = {},
) {
  if (!Array.isArray(examples)) throw Error("响应示例必须是数组");
  const originals = managed ? sourceEntries(responses).entries : [];
  const sources = new Map(
    originals.map((entry) => [bindingKey(entry.openapiExampleSource), entry]),
  );
  if (managed) {
    if (!Array.isArray(registry) || registry.length > 1000)
      throw Error("响应示例来源绑定登记无效");
    const expected = new Map();
    for (const source of registry) {
      if (!object(source) || !/^[a-f0-9]{64}$/.test(source.sourceSHA256 || ""))
        throw Error("响应示例来源绑定登记无效");
      const key = bindingKey(source);
      if (expected.has(key)) throw Error("响应示例来源绑定登记重复");
      expected.set(key, source.sourceSHA256);
    }
    if (
      expected.size !== sources.size ||
      originals.some(
        (entry) =>
          expected.get(bindingKey(entry.openapiExampleSource)) !==
          entry.openapiExampleSource.sourceSHA256,
      )
    )
      throw Error(
        "响应示例来源绑定已变化，请使用示例编辑器或重新导入，避免覆盖原定义修改",
      );
  }
  for (const entry of originals) {
    const source = entry.openapiExampleSource,
      media = responses[source.status].content[source.mediaType];
    if (source.kind === "example") delete media.example;
    else {
      delete media.examples[source.key];
      if (!Object.keys(media.examples).length) delete media.examples;
    }
  }
  const groups = new Map(),
    usedSources = new Set(),
    consume = budget();
  for (const example of examples) {
    if (!object(example) || !concrete(example.status ?? 200))
      throw Error("响应示例状态无效");
    const status = String(example.status ?? 200);
    const types = Object.entries(example.headers || {}).filter(
      ([name]) => name.toLowerCase() === "content-type",
    );
    if (types.length > 1) throw Error("响应示例Content-Type重复");
    const type = types[0]?.[1] ?? "application/json";
    if (!isResponseMediaType(type)) throw Error("响应示例Content-Type无效");
    const body = example.body ?? "{}";
    if (typeof body !== "string" || !body.isWellFormed())
      throw Error("响应示例正文必须是有效文本");
    consume(body);
    let value = body;
    if (isJsonResponseType(type)) {
      try {
        value = JSON.parse(body);
      } catch {
        throw Error("JSON响应示例正文无效，不能改写成字符串示例");
      }
    } else if (!textType(type)) throw Error("此响应示例媒体类型暂不支持导出");
    let original;
    if (managed && example.openapiExampleSource !== undefined) {
      if (!object(example.openapiExampleSource))
        throw Error("响应示例来源绑定无效");
      const key = bindingKey(example.openapiExampleSource);
      if (!sources.has(key) || usedSources.has(key))
        throw Error("响应示例来源绑定已变化或重复，请检查原响应定义");
      usedSources.add(key);
      original = sources.get(key);
      if (
        example.openapiExampleSource.sourceSHA256 !==
        original.openapiExampleSource.sourceSHA256
      )
        throw Error("响应示例来源绑定校验不一致");
    }
    if (
      example.name !== undefined &&
      (typeof example.name !== "string" || example.name.length > 8192)
    )
      throw Error("响应示例名称无效");
    const key = JSON.stringify([status, type]);
    if (!groups.has(key)) groups.set(key, { status, type, entries: [] });
    groups.get(key).entries.push({ example, value, original });
  }
  for (const { status, type, entries } of groups.values()) {
    responses[status] ??= {
      description: entries[0].example.name || "Response",
      content: {},
    };
    responses[status].content ??= {};
    const media = (responses[status].content[type] ??= {});
    if (!managed && (own(media, "example") || own(media, "examples"))) continue;
    const first = entries[0];
    const simple =
      entries.length === 1 &&
      !own(media, "examples") &&
      (first.original
        ? first.original.openapiExampleSource.kind === "example" &&
          first.example.name === first.original.name
        : first.example.name === undefined ||
          first.example.name === responses[status].description);
    if (simple) {
      media.example = first.value;
      continue;
    }
    media.examples ??= Object.create(null);
    entries.forEach(({ example, value, original }, index) => {
      let key =
        original?.openapiExampleSource.kind === "examples"
          ? original.openapiExampleSource.key
          : `example_${index + 1}`;
      const base = key;
      for (let suffix = 2; own(media.examples, key); suffix++)
        key = `${base}_${suffix}`;
      const descriptor = original?.descriptor
        ? structuredClone(original.descriptor)
        : {};
      descriptor.value = value;
      if (!original || example.name !== original.name)
        descriptor.summary = example.name ?? `Example ${index + 1}`;
      Object.defineProperty(media.examples, key, {
        value: descriptor,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
  }
  // Retained external definitions count toward the emitted managed catalogue.
  if (managed) sourceEntries(responses);
}
