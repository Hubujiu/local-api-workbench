// Serialized into QuickJS. Only text operations and opaque selected-file metadata.
function installScriptFormBody({ request, body }) {
  const own = (object, key) =>
    Object.prototype.hasOwnProperty.call(object, key);
  const bytes = (text, limit, label) => {
    if (typeof text !== "string") throw Error(label + "必须是文本");
    if (text.length > limit) throw Error(label + "超过" + limit / 1024 + "KiB");
    if (/^[\x00-\x7f]*$/.test(text)) return text.length;
    let size = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw Error(label + "包含无效Unicode");
        size += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw Error(label + "包含无效Unicode");
      else size += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (size > limit) throw Error(label + "超过" + limit / 1024 + "KiB");
    }
    return size;
  };
  const key = (value, mode) => {
    const size = bytes(value, 1024, "表单字段名");
    if (!size) throw Error("表单字段名不能为空");
    if (mode === "formdata" && /["\r\n]/.test(value))
      throw Error("multipart字段名不能包含引号或换行");
    return size;
  };
  const typeFor = (mode) => (mode === "formdata" ? "form-data" : "urlencoded");
  const inspect = (rows, mode) => {
    if (!Array.isArray(rows) || rows.length > 1000)
      throw Error("脚本表单最多1000项");
    let size = 0;
    const views = rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw Error("表单项必须是对象");
      size += key(row.key, mode);
      const file = row.type === "file";
      if (row.type !== undefined && !["text", "file"].includes(row.type))
        throw Error("未知表单字段类型");
      if (file && mode !== "formdata")
        throw Error("urlencoded不能包含文件字段");
      const view = {
        key: row.key,
        type: file ? "file" : "text",
        disabled: row.enabled === false,
      };
      if (file) {
        view.filename = row.filename || "";
        size += bytes(view.filename, 1024, "文件名");
      } else {
        if (
          row.value != null &&
          !["string", "number", "boolean"].includes(typeof row.value)
        )
          throw Error("表单值必须是文本");
        view.value = String(row.value ?? "");
        size += bytes(view.value, 65536, "表单值");
      }
      if (row.description !== undefined) {
        size += bytes(row.description, 8192, "表单描述");
        view.description = row.description;
      }
      if (size > 262144) throw Error("脚本表单文本合计超过256KiB");
      return view;
    });
    return { rows, views };
  };
  const checkTextFields = (item) => {
    for (const name of Reflect.ownKeys(item))
      if (!["key", "value", "type", "disabled", "description"].includes(name))
        throw Error("脚本表单不支持字段: " + String(name));
  };
  const textRow = (item, mode, previous) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw Error("表单项需要key/value对象");
    checkTextFields(item);
    key(item.key, mode);
    if (item.type !== undefined && item.type !== "text")
      throw Error("脚本只能新增文本字段，文件须在界面选择");
    if (previous?.type === "file")
      throw Error("不能用文本覆盖已选择的文件字段");
    if (item.disabled !== undefined && typeof item.disabled !== "boolean")
      throw Error("disabled必须是布尔值");
    const value = item.value === undefined ? "" : item.value;
    bytes(value, 65536, "表单值");
    if (item.description !== undefined)
      bytes(item.description, 8192, "表单描述");
    return {
      ...previous,
      key: item.key,
      value,
      type: "text",
      enabled:
        item.disabled === undefined
          ? previous?.enabled !== false
          : !item.disabled,
      ...(item.description === undefined
        ? {}
        : { description: item.description }),
    };
  };
  let generation = 0;
  const makeList = (mode, created) => {
    const active = () => {
      if (request.bodyType !== typeFor(mode) || created !== generation)
        throw Error("表单模式已改变，请重新读取当前集合");
    };
    const read = () => {
      active();
      return inspect(request.form ?? [], mode);
    };
    const commit = (rows) => {
      inspect(rows, mode);
      request.form = rows;
    };
    const lastIndex = (rows, name) => {
      key(name, mode);
      for (let i = rows.length - 1; i >= 0; i--)
        if (rows[i].key === name) return i;
      return -1;
    };
    const locate = (row) => {
      active();
      const rows = request.form ?? [];
      const index = rows.indexOf(row);
      if (index < 0) throw Error("表单项已移除，不能修改过期记录");
      return { rows, index };
    };
    const replace = (row, item) => {
      const { rows, index } = locate(row);
      const next = textRow(item, mode, row);
      const candidate = [...rows];
      candidate[index] = next;
      inspect(candidate, mode);
      Object.assign(row, next);
    };
    const wrappers = new WeakMap();
    const entry = (row) => {
      if (!row) return undefined;
      if (wrappers.has(row)) return wrappers.get(row);
      const view = () => inspect([row], mode).views[0];
      const update = (patch) => {
        if (!patch || typeof patch !== "object" || Array.isArray(patch))
          throw Error("表单项update需要对象");
        if (row.type === "file") throw Error("已选择文件的集合记录只读");
        checkTextFields(patch);
        const next = view();
        for (const name of Reflect.ownKeys(patch)) next[name] = patch[name];
        replace(row, next);
      };
      const proxy = new Proxy(Object.create(null), {
        get(_, name) {
          if (name === "then") return undefined;
          if (name === "update") return update;
          if (name === "toJSON") return view;
          if (name === "valueOf") return () => view().value;
          if (name === "toString")
            return () => {
              const v = view();
              return v.key + "=" + (v.value ?? "");
            };
          const v = view();
          return own(v, name) ? v[name] : undefined;
        },
        set(_, name, value) {
          if (
            !["key", "value", "type", "disabled", "description"].includes(name)
          )
            throw Error("不支持的表单项属性");
          update({ [name]: value });
          return true;
        },
        ownKeys: () => Object.keys(view()),
        getOwnPropertyDescriptor(_, name) {
          const v = view();
          return own(v, name)
            ? {
                configurable: true,
                enumerable: true,
                writable: row.type !== "file",
                value: v[name],
              }
            : undefined;
        },
        deleteProperty() {
          throw Error("请使用集合remove或显式赋值，不支持删除记录属性");
        },
        defineProperty() {
          throw Error("请使用表单项属性赋值或update");
        },
        setPrototypeOf() {
          throw Error("不能改变表单项原型");
        },
        preventExtensions() {
          throw Error("不能冻结表单活动记录");
        },
      });
      wrappers.set(row, proxy);
      return proxy;
    };
    return {
      count: () => read().rows.length,
      all: () => read().rows.map(entry),
      one(name) {
        const { rows } = read();
        return entry(rows[lastIndex(rows, name)]);
      },
      get(name) {
        return this.one(name)?.value;
      },
      has(name, value) {
        const { views } = read();
        key(name, mode);
        return views.some(
          (row) =>
            row.key === name && (arguments.length < 2 || row.value === value),
        );
      },
      idx(index) {
        if (!Number.isInteger(index)) throw Error("表单索引必须是整数");
        return entry(read().rows[index]);
      },
      each(fn) {
        if (typeof fn !== "function") throw Error("each需要函数");
        read().rows.map(entry).forEach(fn);
      },
      toObject(excludeDisabled = false) {
        if (typeof excludeDisabled !== "boolean" || arguments.length > 1)
          throw Error("toObject仅支持excludeDisabled布尔参数");
        const values = new Map();
        for (const row of read().views) {
          if (excludeDisabled && row.disabled) continue;
          if (!values.has(row.key)) values.set(row.key, row.value);
          else {
            const previous = values.get(row.key);
            if (Array.isArray(previous)) previous.push(row.value);
            else values.set(row.key, [previous, row.value]);
          }
        }
        return Object.fromEntries(values);
      },
      add(item) {
        const { rows } = read();
        commit([...rows, textRow(item, mode)]);
      },
      upsert(item) {
        const { rows } = read();
        const index = lastIndex(rows, item?.key);
        if (index >= 0) {
          replace(rows[index], item);
          return false;
        }
        commit([...rows, textRow(item, mode)]);
        return true;
      },
      remove(name) {
        const { rows } = read();
        key(name, mode);
        commit(rows.filter((row) => row.key !== name));
      },
      clear() {
        active();
        request.form = [];
      },
    };
  };
  const lists = new Map();
  for (const mode of ["urlencoded", "formdata"])
    Object.defineProperty(body, mode, {
      get() {
        if (request.bodyType !== typeFor(mode)) return undefined;
        const cached = lists.get(mode);
        if (!cached || cached.generation !== generation)
          lists.set(mode, { generation, list: makeList(mode, generation) });
        return lists.get(mode).list;
      },
    });
  const originalUpdate = body.update;
  body.update = (value) => {
    if (!value || !["urlencoded", "formdata"].includes(value.mode)) {
      const result = originalUpdate(value);
      generation++;
      return result;
    }
    const mode = value.mode;
    if (Reflect.ownKeys(value).some((name) => !["mode", mode].includes(name)))
      throw Error("脚本表单更新只支持mode与表单列表");
    const source = value[mode] === undefined ? [] : value[mode];
    if (!Array.isArray(source) || source.length > 1000)
      throw Error("脚本表单需要数组，最多1000项");
    const rows = source.map((item) => textRow(item, mode));
    inspect(rows, mode);
    request.bodyType = typeFor(mode);
    request.body = "";
    request.form = rows;
    generation++;
  };
  return {
    replaceValues(values, clear = true) {
      const mode =
        request.bodyType === "form-data" ? "formdata" : request.bodyType;
      if (!["formdata", "urlencoded"].includes(mode))
        throw Error("需要表单模式");
      if (!values || typeof values !== "object" || Array.isArray(values))
        throw Error("表单替换需要文本值对象");
      const entries = Object.entries(values);
      if (entries.length > 1000) throw Error("脚本表单最多1000项");
      const old = request.form || [];
      const names = new Set(entries.map(([name]) => name));
      const kept = clear ? [] : old.filter((row) => !names.has(row.key));
      const added = entries.map(([name, value]) => {
        if (
          !clear &&
          old.some((row) => row.key === name && row.type === "file")
        )
          throw Error("不能用文本覆盖已选择的文件字段");
        return textRow(
          { key: name, value, disabled: false },
          mode,
          clear ? undefined : old.find((row) => row.key === name),
        );
      });
      const candidate = [...kept, ...added];
      inspect(candidate, mode);
      request.form = candidate;
    },
  };
}

export const scriptFormBodySource = installScriptFormBody.toString();
