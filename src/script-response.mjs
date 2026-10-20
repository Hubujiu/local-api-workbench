// Serialized into the existing isolated VM; no host module references.
function installResponseCompatibility({ response, pm, apt }) {
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
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
  function chain(negative = false) {
    let proxy;
    const check = (condition, label) => {
      if (!response) throw Error("当前脚本没有响应");
      apt.expect(Boolean(condition), label).to.equal(!negative);
      return proxy;
    };
    const methods = {
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
}
export const responseCompatibilitySource =
  installResponseCompatibility.toString();
