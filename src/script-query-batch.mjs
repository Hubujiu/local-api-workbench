// Serialized into the existing isolated VM. No URL host binding or new authority.
function installQueryBatch({ request, pm, urlTools }) {
  const bytes = (text, limit, label) => {
    if (typeof text !== "string") throw Error(label + "必须为文本");
    let size = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const low = text.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff))
          throw Error(label + "包含无效Unicode");
        size += 4;
      } else if (c >= 0xdc00 && c <= 0xdfff)
        throw Error(label + "包含无效Unicode");
      else size += c < 128 ? 1 : c < 2048 ? 2 : 3;
      if (size > limit) throw Error(label + "超过限制");
    }
    return size;
  };
  const name = (key) => {
    const size = bytes(key, 1024, "查询参数名");
    if (!size || key.includes("\0")) throw Error("查询参数名不能为空或包含NUL");
    return size;
  };
  const parts = () => urlTools.splitURL(request.url);
  const inspect = (rows, raw) => {
    if (!Array.isArray(rows)) throw Error("查询参数必须为数组");
    const query = urlTools.splitURL(raw).query;
    const rawCount = query ? urlTools.splitQuery(query).length : 0;
    if (rows.length + rawCount > 1000) throw Error("查询参数合计最多1000项");
    let size = bytes(raw, 65536, "URL");
    for (const row of rows) {
      if (!row || typeof row !== "object") throw Error("查询参数项无效");
      size += name(row.key);
      if (
        row.value != null &&
        !["string", "number", "boolean"].includes(typeof row.value)
      )
        throw Error("查询参数值必须为文本");
      size += bytes(String(row.value ?? ""), 65536, "查询参数值");
      if (row.description !== undefined)
        size += bytes(row.description, 8192, "查询参数描述");
      if (size > 65536) throw Error("查询参数和URL合计超过64KiB");
    }
  };
  const decode = urlTools.decodeComponent;
  pm.request.addQueryParams = (input) => {
    let source;
    if (typeof input === "string") {
      bytes(input, 65536, "查询字符串");
      if (input.startsWith("?")) throw Error("查询字符串不包含开头问号");
      source =
        input === ""
          ? []
          : urlTools.splitQuery(input).map((item) => {
              const at = urlTools.pairBoundary(item);
              if (at < 0)
                throw Error(
                  "查询字符串仅支持明确的key=value项，不支持无等号标记",
                );
              return {
                key: decode(item.slice(0, at)),
                value: decode(item.slice(at + 1)),
              };
            });
    } else source = Array.isArray(input) ? input : [input];
    if (source.length > 1000) throw Error("查询参数最多1000项");
    const added = source.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).some(
          (k) => !["key", "value", "disabled", "description"].includes(k),
        )
      )
        throw Error("查询参数需要key/value对象");
      name(row.key);
      bytes(row.value, 65536, "查询参数值");
      if (row.disabled !== undefined && typeof row.disabled !== "boolean")
        throw Error("disabled必须为布尔值");
      return {
        key: row.key,
        value: row.value,
        enabled: row.disabled !== true,
        ...(row.description === undefined
          ? {}
          : { description: row.description }),
      };
    });
    const candidate = [...(request.query || []), ...added];
    inspect(candidate, parts().raw);
    request.query = candidate;
  };
  pm.request.removeQueryParams = (input) => {
    const values = Array.isArray(input) ? input : [input];
    if (values.length > 1000) throw Error("查询参数选择器最多1000项");
    const names = new Set(
      values.map((item) => {
        const key = item && typeof item === "object" ? item.key : item;
        name(key);
        return key;
      }),
    );
    const current = parts();
    const rows = (request.query || []).filter((row) => !names.has(row.key));
    const raw = urlTools.remove(current.raw, names);
    inspect(rows, raw);
    request.query = rows;
    request.url = raw;
  };
}
export const queryBatchSource = installQueryBatch.toString();
