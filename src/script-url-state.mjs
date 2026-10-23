// Reviewed phase-boundary codec. Script URL mode is not wired to this yet.
// It accepts SDK toJSON output, not SDK instances and not arbitrary script objects.
export function validateURLSnapshot(input) {
  const fail = (detail) => {
    throw Error("URL状态无效: " + detail);
  };
  let nodes = 0,
    textBytes = 0;
  const seen = new Set();
  const clone = (value, depth = 0) => {
    if (++nodes > 8192 || depth > 16) fail("结构超限");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.length > 65536) fail("文本超限");
      for (let i = 0; i < value.length; i++) {
        const cp = value.charCodeAt(i);
        if (cp >= 0xd800 && cp <= 0xdbff) {
          const lo = value.charCodeAt(++i);
          if (!(lo >= 0xdc00 && lo <= 0xdfff)) fail("无效Unicode");
          textBytes += 4;
        } else if (cp >= 0xdc00 && cp <= 0xdfff) fail("无效Unicode");
        else textBytes += cp < 128 ? 1 : cp < 2048 ? 2 : 3;
        if (textBytes > 65536) fail("文本总量超过64KiB");
      }
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object") fail("必须为有限JSON数据");
    if (seen.has(value)) fail("循环引用");
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (!array && proto !== Object.prototype && proto !== null)
      fail("不能携带对象原型");
    const keys = Reflect.ownKeys(value);
    if (keys.length > 2048 || (array && value.length > 1000)) fail("成员超限");
    seen.add(value);
    const out = array ? [] : {};
    if (array && keys.length !== value.length + 1)
      fail("稀疏数组或额外数组字段");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") fail("Symbol字段");
      clone(key, depth + 1);
      if (array && !/^(?:0|[1-9][0-9]*)$/.test(key)) fail("额外数组字段");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        fail("访问器或隐藏字段");
      Object.defineProperty(out, key, {
        value: clone(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    seen.delete(value);
    return out;
  };
  const state = clone(input);
  const fields = (object, allowed) => {
    if (
      !object ||
      typeof object !== "object" ||
      Array.isArray(object) ||
      Object.keys(object).some((k) => !allowed.includes(k))
    )
      fail("未知结构字段");
  };
  const textFields = (object, names) => {
    for (const key of names)
      if (Object.hasOwn(object, key) && typeof object[key] !== "string")
        fail(key + "必须为文本");
  };
  fields(state, ["version", "url"]);
  if (state.version !== 1) fail("版本");
  const url = state.url;
  fields(url, [
    "auth",
    "protocol",
    "port",
    "path",
    "hash",
    "host",
    "query",
    "variable",
  ]);
  textFields(url, ["protocol", "port", "hash"]);
  if (url.auth !== undefined) {
    fields(url.auth, ["user", "password"]);
    textFields(url.auth, ["user", "password"]);
  }
  for (const name of ["path", "host"])
    if (
      url[name] !== undefined &&
      (!Array.isArray(url[name]) ||
        url[name].some((v) => typeof v !== "string"))
    )
      fail(name + "必须为文本数组");
  const metadata = (row) => {
    textFields(row, ["id", "name"]);
    for (const key of ["disabled", "system", "secret"])
      if (Object.hasOwn(row, key) && typeof row[key] !== "boolean")
        fail(key + "必须为布尔值");
    if (row.description !== undefined) {
      fields(row.description, ["content", "type"]);
      textFields(row.description, ["content", "type"]);
    }
  };
  for (const name of ["query", "variable"]) {
    if (!Array.isArray(url[name])) fail(name + "必须为数组");
    for (const row of url[name]) {
      fields(
        row,
        name === "query"
          ? ["key", "value", "disabled", "description", "id", "name", "system"]
          : [
              "key",
              "value",
              "type",
              "disabled",
              "description",
              "id",
              "name",
              "system",
              "secret",
            ],
      );
      metadata(row);
      if (name === "query") {
        for (const key of ["key", "value"])
          if (
            Object.hasOwn(row, key) &&
            row[key] !== null &&
            typeof row[key] !== "string"
          )
            fail("Query须保留文本或null");
      } else {
        if (
          typeof row.key !== "string" ||
          !["any", "string", "number", "boolean", "array", "object"].includes(
            row.type,
          )
        )
          fail("Variable类型");
      }
    }
  }
  let bytes = 0;
  for (const char of JSON.stringify(state)) {
    const cp = char.codePointAt(0);
    bytes += cp <= 127 ? 1 : cp <= 2047 ? 2 : cp <= 65535 ? 3 : 4;
    if (bytes > 65536) fail("序列化超过64KiB");
  }
  return state;
}

// Do not invoke SDK/user toJSON: upstream cloning can silently erase functions.
// Read only own data descriptors and known list storage; validate before transfer.
export function captureURLSnapshot(url) {
  const fail = () => {
    throw Error("URL状态无效: 不支持的SDK成员或访问器");
  };
  const data = (object, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
    return descriptor.value;
  };
  const publicFields = (object, parent) => {
    if (!object || typeof object !== "object" || Array.isArray(object)) fail();
    const result = {};
    const keys = Reflect.ownKeys(object);
    if (keys.length > 2048) fail();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (
        key === "__parent" &&
        parent !== undefined &&
        !descriptor.enumerable &&
        descriptor.value === parent
      )
        continue;
      if (
        typeof key !== "string" ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        fail();
      if (descriptor.value !== undefined)
        Object.defineProperty(result, key, {
          value: descriptor.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    return result;
  };
  const result = publicFields(url);
  const list = (value) => {
    if (!value || typeof value !== "object") fail();
    const members = data(value, "members");
    if (
      !Array.isArray(members) ||
      members.length > 1000 ||
      Reflect.ownKeys(members).length !== members.length + 1
    )
      fail();
    const rows = [];
    for (let index = 0; index < members.length; index++) {
      const row = publicFields(data(members, String(index)), value);
      if (Object.hasOwn(row, "description"))
        row.description = publicFields(row.description);
      rows.push(row);
    }
    return rows;
  };
  result.query = list(data(url, "query"));
  result.variable = list(data(url, "variables"));
  delete result.variables;
  return validateURLSnapshot({ version: 1, url: result });
}
