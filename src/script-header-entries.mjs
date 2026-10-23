// Runs inside the existing VM; entries only mutate the request's header rows.
function installHeaderEntries({ request, headers, requestFacade }) {
  const bytes = (value, limit) => {
    if (typeof value !== "string" || value.length > limit)
      throw Error("Header文本类型或长度无效");
    if (/^[\x00-\x7f]*$/.test(value)) return value.length;
    let size = 0;
    for (let i = 0; i < value.length; i++) {
      const n = value.charCodeAt(i);
      if (n >= 0xd800 && n <= 0xdbff) {
        const low = value.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff))
          throw Error("Header包含无效Unicode");
        size += 4;
      } else if (n >= 0xdc00 && n <= 0xdfff)
        throw Error("Header包含无效Unicode");
      else size += n < 128 ? 1 : n < 2048 ? 2 : 3;
      if (size > limit) throw Error("Header文本超过限制");
    }
    return size;
  };
  const name = (value) => {
    const size = bytes(value, 1024);
    if (!size || /[\0\r\n]/.test(value)) throw Error("Header名称无效");
    return size;
  };
  const view = (row) => ({
    key: row.key,
    value: String(row.value ?? ""),
    disabled: row.enabled === false,
    enabled: row.enabled !== false,
    ...(row.description === undefined ? {} : { description: row.description }),
  });
  const inspect = (rows) => {
    if (!Array.isArray(rows) || rows.length > 1000)
      throw Error("Header最多1000项");
    let size = 0;
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw Error("Header记录无效");
      size += name(row.key);
      if (
        row.value != null &&
        !["string", "number", "boolean"].includes(typeof row.value)
      )
        throw Error("Header值必须是文本");
      size += bytes(String(row.value ?? ""), 65536);
      if (row.description !== undefined) size += bytes(row.description, 8192);
      if (size > 262144) throw Error("Header文本合计超过256KiB");
    }
    return rows;
  };
  const read = () => inspect(request.headers ?? []);
  const cache = new WeakMap();
  const entry = (row) => {
    if (!row) return undefined;
    if (cache.has(row)) return cache.get(row);
    const update = (patch) => {
      if (
        !patch ||
        typeof patch !== "object" ||
        Array.isArray(patch) ||
        Reflect.ownKeys(patch).some(
          (k) =>
            !["key", "value", "disabled", "enabled", "description"].includes(k),
        )
      )
        throw Error("Header更新字段无效");
      const rows = read(),
        index = rows.indexOf(row);
      if (index < 0) throw Error("Header项已移除，请重新读取当前记录");
      for (const key of ["disabled", "enabled"])
        if (Object.hasOwn(patch, key) && typeof patch[key] !== "boolean")
          throw Error("Header启用状态必须为布尔值");
      if (
        Object.hasOwn(patch, "disabled") &&
        Object.hasOwn(patch, "enabled") &&
        patch.disabled === patch.enabled
      )
        throw Error("Header启用状态冲突");
      const next = { ...row };
      for (const key of ["key", "value", "description"])
        if (Object.hasOwn(patch, key)) next[key] = patch[key];
      if (Object.hasOwn(patch, "value")) bytes(patch.value, 65536);
      if (Object.hasOwn(patch, "disabled")) next.enabled = !patch.disabled;
      if (Object.hasOwn(patch, "enabled")) next.enabled = patch.enabled;
      const candidate = [...rows];
      candidate[index] = next;
      inspect(candidate);
      Object.assign(row, next);
    };
    const proxy = new Proxy(Object.create(null), {
      get(_, key) {
        if (key === "then") return undefined;
        if (key === "update") return update;
        if (key === "toJSON") return () => view(row);
        if (key === "valueOf") return () => view(row).value;
        if (key === "toString")
          return () => row.key + ": " + String(row.value ?? "");
        const values = view(row);
        return Object.hasOwn(values, key) ? values[key] : undefined;
      },
      set(_, key, value) {
        update({ [key]: value });
        return true;
      },
      ownKeys: () => Object.keys(view(row)),
      getOwnPropertyDescriptor(_, key) {
        const values = view(row);
        return Object.hasOwn(values, key)
          ? {
              configurable: true,
              enumerable: true,
              writable: true,
              value: values[key],
            }
          : undefined;
      },
      defineProperty() {
        throw Error("请通过Header赋值或update修改记录");
      },
      deleteProperty() {
        throw Error("请使用Header集合remove或显式赋值");
      },
      setPrototypeOf() {
        throw Error("不能修改Header记录原型");
      },
      preventExtensions() {
        throw Error("不能冻结Header活动记录");
      },
    });
    cache.set(row, proxy);
    return proxy;
  };
  headers.count = () => read().length;
  headers.one = (key) => {
    name(key);
    const rows = read();
    for (let i = rows.length - 1; i >= 0; i--)
      if (rows[i].key.toLowerCase() === key.toLowerCase())
        return entry(rows[i]);
  };
  headers.get = (key) => headers.one(key)?.value;
  headers.has = function (item, value) {
    const withValue = arguments.length > 1;
    if (typeof item === "string") name(item);
    return read().some((row) => {
      const matches =
        typeof item === "string"
          ? row.key.toLowerCase() === item.toLowerCase()
          : item !== null &&
            typeof item === "object" &&
            cache.get(row) === item;
      return matches && (!withValue || view(row).value === value);
    });
  };
  headers.toObject = (
    excludeDisabled = false,
    caseSensitive = false,
    multiValue = false,
    sanitizeKeys = false,
  ) => {
    if (
      [excludeDisabled, caseSensitive, multiValue, sanitizeKeys].some(
        (value) => typeof value !== "boolean",
      )
    )
      throw Error("Header对象转换选项必须为布尔值");
    const result = new Map();
    for (const row of read()) {
      if (excludeDisabled && row.enabled === false) continue;
      const key = caseSensitive ? row.key : row.key.toLowerCase(),
        value = view(row).value;
      if (result.has(key)) {
        const prior = result.get(key);
        if (Array.isArray(prior)) prior.push(value);
        else result.set(key, [prior, value]);
      } else result.set(key, value);
    }
    return Object.fromEntries(result);
  };
  headers.idx = (index) => {
    if (!Number.isInteger(index)) throw Error("Header索引必须为整数");
    return entry(read()[index]);
  };
  headers.all = () => read().map(entry);
  const callback = (fn, context) => {
    if (typeof fn !== "function") throw Error("Header迭代需要函数");
    return (...args) => Reflect.apply(fn, context, args);
  };
  headers.each = (fn, context) => {
    const invoke = callback(fn, context || requestFacade),
      rows = read().map(entry);
    for (let i = 0; i < rows.length; i++)
      if (invoke(rows[i], i, rows) === false) break;
  };
  headers.map = (fn, context) =>
    read()
      .map(entry)
      .map(callback(fn, context || headers));
  headers.filter = (fn, context) =>
    read().map(entry).filter(callback(fn, context));
  headers.find = (fn, context) => read().map(entry).find(callback(fn, context));
  headers.reduce = (fn, initial, context) =>
    read()
      .map(entry)
      .reduce(callback(fn, context || headers), initial);
}
export const headerEntriesSource = installHeaderEntries.toString();
