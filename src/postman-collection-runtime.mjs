// Public collection facade; serialized into the existing isolate, never a host bridge.
export function createCollectionAPI(scopeState, refreshVariables) {
  const variableName = (name) => {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 200 ||
      ["__proto__", "prototype", "constructor"].includes(name)
    )
      throw Error("变量名无效");
  };
  const copyVariableValue = (value) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const collectionWrite = () => {
    if (!scopeState.collectionId)
      throw Error("请求未绑定 Postman collection，不能写入");
  };
  return {
    get: (name) => copyVariableValue(scopeState.collection?.[name]),
    has: (name) =>
      Object.prototype.hasOwnProperty.call(scopeState.collection || {}, name),
    toObject: () => copyVariableValue(scopeState.collection || {}),
    set: (name, value) => {
      collectionWrite();
      variableName(name);
      const text = JSON.stringify(value, (_key, item) => {
        if (
          item === undefined ||
          ["function", "symbol", "bigint"].includes(typeof item) ||
          (typeof item === "number" && !Number.isFinite(item))
        )
          throw Error("collection变量必须为有限JSON");
        return item;
      });
      if (text === undefined) throw Error("collection变量必须为JSON");
      const copy = JSON.parse(text),
        type = scopeState.collectionTypes[name] || "any";
      if (!["any", "string", "boolean", "number"].includes(type))
        throw Error("collection变量类型不支持");
      if (type === "number" && copy !== null && typeof copy === "object")
        throw Error("collection number只支持标量");
      const next =
        type === "string"
          ? String(copy)
          : type === "boolean"
            ? Boolean(copy)
            : type === "number"
              ? Number(copy)
              : copy;
      if (typeof next === "number" && !Number.isFinite(next))
        throw Error("collection number必须有限");
      scopeState.collection[name] = next;
      scopeState.collectionTypes[name] = type;
      refreshVariables();
    },
    unset: (name) => {
      collectionWrite();
      variableName(name);
      delete scopeState.collection[name];
      delete scopeState.collectionTypes[name];
      refreshVariables();
    },
    clear: () => {
      collectionWrite();
      for (const name of Object.keys(scopeState.collection))
        delete scopeState.collection[name];
      for (const name of Object.keys(scopeState.collectionTypes))
        delete scopeState.collectionTypes[name];
      refreshVariables();
    },
  };
}
export const collectionRuntimeSource = createCollectionAPI.toString();
