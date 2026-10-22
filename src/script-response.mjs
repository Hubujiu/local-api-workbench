// Serialized into the existing isolated VM; no host module references.
function installResponseCompatibility({ response, pm, apt }) {
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const { toPath, isEqual, isPlainObject } = globalThis._;
  const headers = response?.headers || Object.create(null);
  const headerView = new Proxy(headers, {
    get(target, key) {
      return typeof key === "string" && own(target, key.toLowerCase())
        ? target[key.toLowerCase()]
        : undefined;
    },
    has(target, key) {
      return typeof key === "string" && own(target, key.toLowerCase());
    },
  });
  apt.response = {
    code: response?.status,
    status: response?.statusText,
    responseTime: response?.duration,
    responseSize: response?.size,
    json: response?.json,
    headers: headerView,
    cookies: response?.cookies || Object.create(null),
    raw: response?.raw,
    text: () => response?.body || "",
  };
  const categories = {
    info: [100, 199],
    success: [200, 299],
    redirection: [300, 399],
    clientError: [400, 499],
    serverError: [500, 599],
    error: [400, 599],
    ok: [200, 200],
    accepted: [202, 202],
    badRequest: [400, 400],
    unauthorized: [401, 401],
    forbidden: [403, 403],
    notFound: [404, 404],
    rateLimited: [429, 429],
  };
  const parseJSON = (body) => {
    try {
      return JSON.parse(body);
    } catch {
      throw Error("jsonSchema 断言需要有效 JSON 响应");
    }
  };
  const responseJSON = () => {
    if (!response) throw Error("当前脚本没有响应");
    return parseJSON(response.body);
  };
  const schemaReaders = new WeakMap([
    [pm.response, responseJSON],
    [apt.response, responseJSON],
  ]);
  globalThis.chai.Assertion.addMethod("jsonSchema", function (schema, options) {
    let data = globalThis.chai.util.flag(this, "object");
    const read = schemaReaders.get(data);
    if (read) data = read();
    const result = globalThis.__validateJSONSchema(schema, data, options);
    this.assert(
      result.valid,
      result.message,
      "expected data to not satisfy JSON Schema",
    );
  });
  function chain(negative = false) {
    let proxy;
    const check = (condition, label) => {
      if (!response) throw Error("当前脚本没有响应");
      apt.expect(Boolean(condition), label).to.equal(!negative);
      return proxy;
    };
    const methods = {
      jsonSchema(schema, options) {
        const result = globalThis.__validateJSONSchema(
          schema,
          responseJSON(),
          options,
        );
        return check(result.valid, result.message);
      },
      status(value) {
        if (
          typeof value !== "string" &&
          !(Number.isInteger(value) && value >= 100 && value <= 599)
        )
          throw Error("status需要状态码或状态文本");
        return check(
          (typeof value === "string"
            ? response?.statusText
            : response?.status) === value,
          "响应状态",
        );
      },
      header(name, value) {
        if (typeof name !== "string" || !name) throw Error("header需要名称");
        const key = name.toLowerCase();
        return check(
          own(headers, key) && (arguments.length < 2 || headers[key] === value),
          "响应Header " + name,
        );
      },
      jsonBody(path, value) {
        if (!response) throw Error("当前脚本没有响应");
        if (arguments.length > 2) throw Error("jsonBody最多接受两个参数");
        let data,
          valid = true;
        try {
          data = JSON.parse(response.body);
        } catch {
          valid = false;
        }
        if (!arguments.length) return check(valid, "响应JSON格式");
        if (!valid) throw Error("jsonBody路径或值断言需要有效JSON响应");
        if (typeof path === "string") {
          if (path.length > 1024) throw Error("jsonBody路径最多1024字符");
          const parts =
            path === "" || (data != null && own(data, path))
              ? [path]
              : toPath(path);
          if (!parts.length || parts.length > 32)
            throw Error("jsonBody路径最多32层");
          let found = true,
            current = data;
          for (const part of parts) {
            if (current == null || !own(current, part)) {
              found = false;
              break;
            }
            current = current[part];
          }
          return check(
            found && (arguments.length < 2 || isEqual(current, value)),
            "响应JSON路径 " + path,
          );
        }
        if (
          arguments.length === 1 &&
          (isPlainObject(path) || Array.isArray(path))
        )
          return check(isEqual(data, path), "响应JSON整体值");
        throw Error("jsonBody需要字符串路径或JSON对象/数组");
      },
      body(value) {
        if (typeof value !== "string") throw Error("body需要完整文本");
        return check(response?.body === value, "响应正文");
      },
    };
    proxy = new Proxy(Object.create(null), {
      get(_, key) {
        if (key === "then") return undefined;
        if (["to", "be", "have", "and"].includes(key)) return proxy;
        if (key === "not") return chain(!negative);
        if (own(methods, key)) return methods[key];
        if (own(categories, key)) {
          const [min, max] = categories[key];
          return check(
            response?.status >= min && response?.status <= max,
            "响应类别 " + key,
          );
        }
        throw Error("不支持的响应断言: " + String(key));
      },
    });
    return proxy;
  }
  for (const facade of [apt.response, pm.response])
    Object.defineProperty(facade, "to", { get: () => chain() });
  return (facade, body) => schemaReaders.set(facade, () => parseJSON(body));
}
export const responseCompatibilitySource =
  installResponseCompatibility.toString();
