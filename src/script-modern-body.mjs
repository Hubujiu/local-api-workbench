// Runs only inside the existing VM, with its existing lodash and form validators.
function installModernBody({ request, pm, apt, forms, lodash }) {
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
  const bounded = (text) => {
    if (typeof text !== "string") throw Error("正文必须是文本或可序列化JSON");
    let size = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff))
          throw Error("正文包含无效Unicode");
        size += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw Error("正文包含无效Unicode");
      else size += code < 128 ? 1 : code < 2048 ? 2 : 3;
      if (size > 65536) throw Error("脚本正文超过64KiB");
    }
    return text;
  };
  const jsonText = (value) => bounded(JSON.stringify(value));
  const form = () => ["form-data", "urlencoded"].includes(request.bodyType);
  const parsed = () => {
    if (request.bodyType !== "json")
      throw Error("字段操作仅支持JSON或表单模式");
    const value = JSON.parse(bounded(request.body || "{}"));
    if (!value || typeof value !== "object")
      throw Error("JSON字段操作需要对象或数组");
    return value;
  };
  const pathFor = (object, name) => {
    if (typeof name !== "string" || !name || name.length > 1024)
      throw Error("JSON路径需要非空字符串，最多1024字符");
    const tokens = own(object, name) ? [name] : lodash.toPath(name);
    if (!tokens.length || tokens.length > 32) throw Error("JSON路径最多32层");
    let cursor = object;
    for (const token of tokens) {
      if (!token || ["__proto__", "prototype", "constructor"].includes(token))
        throw Error("不安全JSON路径");
      const index = /^(0|[1-9][0-9]*)$/.test(token);
      if (index && Number(token) > 999) throw Error("JSON数组下标最多999");
      if (Array.isArray(cursor) && !index)
        throw Error("数组路径必须是非负整数下标");
      cursor =
        cursor && typeof cursor === "object" && own(cursor, token)
          ? cursor[token]
          : undefined;
    }
    return tokens;
  };
  pm.setRequestBody = function (value, fieldValue, clear = true) {
    if (typeof clear !== "boolean") throw Error("表单覆盖开关必须是布尔值");
    if (arguments.length === 1 || fieldValue === undefined) {
      if (form()) {
        forms.replaceValues(value, clear);
        return;
      }
      if (typeof value !== "string" && (!value || typeof value !== "object"))
        throw Error("正文替换仅接受文本或JSON对象/数组");
      let text, language;
      if (typeof value === "string") {
        text = bounded(value);
        language = request.bodyType === "json" ? "json" : "text";
        if (language === "json") {
          try {
            JSON.parse(text);
          } catch {
            language = "text";
          }
        }
      } else {
        text = jsonText(value);
        language = "json";
      }
      pm.request.body.update({
        mode: "raw",
        raw: text,
        options: { raw: { language } },
      });
      return;
    }
    // Vendor null is overloaded as whole-body input; reject instead of guessing.
    if (fieldValue === null) throw Error("null字段请通过完整JSON对象设置");
    if (form()) {
      if (typeof value !== "string") throw Error("表单字段名必须是文本");
      forms.replaceValues({ [value]: String(fieldValue) }, false);
      return;
    }
    const object = parsed(),
      tokens = pathFor(object, value);
    const copied = JSON.parse(jsonText(fieldValue));
    lodash.set(object, tokens, copied);
    pm.request.body.update({
      mode: "raw",
      raw: jsonText(object),
      options: { raw: { language: "json" } },
    });
  };
  pm.removeRequestBody = (name) => {
    if (form()) {
      pm.request.body[
        request.bodyType === "form-data" ? "formdata" : "urlencoded"
      ].remove(name);
      return;
    }
    const object = parsed(),
      tokens = pathFor(object, name);
    lodash.unset(object, tokens);
    pm.request.body.update({
      mode: "raw",
      raw: jsonText(object),
      options: { raw: { language: "json" } },
    });
  };
  if (request.scriptDialect === "apipost8") {
    apt.setRequestBody = pm.setRequestBody;
    apt.removeRequestBody = pm.removeRequestBody;
  }
}
export const modernBodySource = installModernBody.toString();
