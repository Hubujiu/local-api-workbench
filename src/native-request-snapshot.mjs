// Host preflight only copies own data. In particular Worker structured cloning
// must never turn a request getter into trusted snapshot data by invoking it.
export function nativeRequestSnapshotInput(request, sources) {
  if (
    !request ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(request))
  )
    throw Error("请求提取快照需要普通请求对象");
  for (const key of Reflect.ownKeys(request)) {
    const item = Object.getOwnPropertyDescriptor(request, key);
    if (!Object.hasOwn(item, "value")) throw Error("请求快照输入不读取访问器");
  }
  const output = Object.create(null);
  let nodes = 0,
    bytes = 0;
  const clone = (value, depth = 0) => {
    if (++nodes > 10000 || depth > 64) throw Error("请求提取快照结构超限");
    if (typeof value === "string") {
      if (!value.isWellFormed() || (bytes += Buffer.byteLength(value)) > 65536)
        throw Error("请求提取快照超过64KiB或Unicode无效");
      return value;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "undefined"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object")
      throw Error("请求提取快照必须是普通数据");
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : ![Object.prototype, null].includes(prototype)
    )
      throw Error("请求提取快照必须是普通数据");
    const result = array ? [] : Object.create(null);
    if (array) {
      if (
        value.length > 10000 ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        throw Error("请求提取快照数组无效或超限");
      for (let index = 0; index < value.length; index++) {
        const item = Object.getOwnPropertyDescriptor(value, index);
        if (!item?.enumerable || !Object.hasOwn(item, "value"))
          throw Error("请求提取快照数组不能稀疏或有访问器");
      }
    }
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === "length") continue;
      const item = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !item?.enumerable ||
        !Object.hasOwn(item, "value")
      )
        throw Error("请求提取快照不读取访问器");
      clone(key, depth + 1);
      Object.defineProperty(result, key, {
        value: clone(item.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (array && Object.keys(result).length !== value.length)
      throw Error("请求提取快照数组不能稀疏");
    return result;
  };
  const read = (key) => {
    const item = Object.getOwnPropertyDescriptor(request, key);
    if (!item) return undefined;
    if (!item.enumerable || !Object.hasOwn(item, "value"))
      throw Error("请求提取快照不读取访问器");
    return clone(item.value);
  };
  if (sources.includes("requestHeader")) output.headers = read("headers") ?? [];
  if (sources.includes("requestBody")) {
    output.bodyType = read("bodyType") ?? "none";
    if (output.bodyType === "json" || output.bodyType === "raw")
      output.body = read("body") ?? "";
    else if (
      output.bodyType === "form-data" ||
      output.bodyType === "urlencoded"
    )
      output.form = read("form") ?? [];
  }
  return output;
}

// Serialized independently of user data and installed only for request sources.
function createNativeRequestSnapshot(input, sources) {
  const descriptor = Object.getOwnPropertyDescriptor,
    hasOwn = Object.hasOwn,
    keys = Object.keys,
    create = Object.create,
    define = Object.defineProperty,
    parse = JSON.parse,
    isArray = Array.isArray,
    finite = Number.isFinite,
    charCode = Function.prototype.call.bind(String.prototype.charCodeAt),
    lower = Function.prototype.call.bind(String.prototype.toLowerCase),
    execute = Function.prototype.call.bind(RegExp.prototype.exec),
    Failure = Error;
  const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/,
    reserved = create(null),
    results = create(null),
    errors = create(null);
  for (const name of keys(Object.prototype)) reserved[name] = true;
  for (const name of Object.getOwnPropertyNames(Object.prototype))
    reserved[name] = true;
  reserved.prototype = true;
  const own = (object, key) => {
    const item = descriptor(object, key);
    if (!item) return undefined;
    if (!item.enumerable || !hasOwn(item, "value"))
      throw Failure("请求提取快照只读取自有数据");
    return item.value;
  };
  const text = (value) => {
    if (typeof value !== "string" || value.length > 65536)
      throw Failure("请求提取快照需要64KiB内字符串");
    let bytes = 0;
    for (let at = 0; at < value.length; at++) {
      const code = charCode(value, at);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = charCode(value, ++at);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw Failure("请求提取快照Unicode无效");
        bytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw Failure("请求提取快照Unicode无效");
      else bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
      if (bytes > 65536) throw Failure("请求提取快照超过64KiB");
    }
    return bytes;
  };
  let nodes = 0;
  const copy = (value, depth = 0) => {
    if (++nodes > 10000 || depth > 64) throw Failure("请求提取快照结构超限");
    if (typeof value === "string") {
      text(value);
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && finite(value)) return value;
    if (!value || typeof value !== "object")
      throw Failure("请求提取快照需要有限JSON数据");
    const out = isArray(value) ? [] : create(null),
      names = keys(value);
    for (let at = 0; at < names.length; at++) {
      const key = names[at];
      text(key);
      if (hasOwn(reserved, key)) throw Failure("请求提取快照不支持保留名称");
      define(out, key, {
        value: copy(own(value, key), depth + 1),
        enumerable: true,
      });
    }
    return out;
  };
  const rows = (list, header) => {
    if (!isArray(list) || list.length > 256)
      throw Failure("请求提取快照最多256行");
    const map = create(null);
    let bytes = 0;
    for (let at = 0; at < list.length; at++) {
      const row = own(list, String(at));
      if (!row || typeof row !== "object" || isArray(row))
        throw Failure("请求提取快照行无效");
      if (own(row, "enabled") === false) continue;
      const key = own(row, "key"),
        value = own(row, "value");
      bytes += text(key) + text(value);
      if (bytes > 65536) throw Failure("请求提取快照超过64KiB");
      const name = header ? lower(key) : key;
      if (!name || hasOwn(reserved, name) || hasOwn(map, name))
        throw Failure("请求提取快照名称重复或不安全");
      if (header && !execute(token, name))
        throw Failure("请求Header提取只支持字面HTTP字段名");
      if (
        !header &&
        ((own(row, "type") !== undefined && own(row, "type") !== "text") ||
          own(row, "requiresFile") === true)
      )
        throw Failure("请求Body提取不支持文件字段");
      define(map, name, { value, enumerable: true });
    }
    return map;
  };
  const body = () => {
    const mode = own(input, "bodyType");
    if (mode === "urlencoded" || mode === "form-data")
      return rows(own(input, "form"), false);
    if (mode !== "raw" && mode !== "json")
      throw Failure("请求Body提取仅支持严格JSON或文本表单快照");
    const raw = own(input, "body");
    text(raw);
    if (!raw) throw Failure("请求Body提取不支持空正文快照");
    // Resource preflight, not a JSON parser. Native JSON.parse validates syntax.
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let at = 0; at < raw.length; at++) {
      const code = charCode(raw, at);
      if (quoted) {
        if (escaped) escaped = false;
        else if (code === 92) escaped = true;
        else if (code === 34) quoted = false;
      } else if (code === 34) quoted = true;
      else if (code === 123 || code === 91) {
        if (++depth > 64) throw Failure("请求JSON预检超过64层");
      } else if (code === 125 || code === 93) depth--;
    }
    const value = parse(raw);
    if (!value || typeof value !== "object")
      throw Failure("请求Body提取须为JSON对象或数组");
    nodes = 0;
    return copy(value);
  };
  for (let at = 0; at < sources.length; at++) {
    const source = sources[at];
    if (hasOwn(results, source) || hasOwn(errors, source)) continue;
    try {
      results[source] =
        source === "requestHeader" ? rows(own(input, "headers"), true) : body();
    } catch (error) {
      errors[source] = error.message;
    }
  }
  return (source) => {
    if (hasOwn(errors, source)) throw Failure(errors[source]);
    if (!hasOwn(results, source)) throw Failure("请求提取快照来源无效");
    return results[source];
  };
}
export const nativeRequestSnapshotSource =
  createNativeRequestSnapshot.toString();
