/** Serialized into QuickJS. This function must not reference host modules or closures. */
function installScriptCompatibility({
  request,
  response,
  pm,
  apt,
  variables,
  localVariables,
  tests,
  parameterName,
  modifyPair,
}) {
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const own = (object, key) =>
    Object.prototype.hasOwnProperty.call(object, key);
  pm.variables.get = (name) =>
    own(localVariables, name) ? localVariables[name] : variables[name];
  pm.variables.has = (name) =>
    own(localVariables, name) || own(variables, name);
  pm.variables.toObject = () => copy({ ...variables, ...localVariables });
  pm.environment.delete = pm.environment.unset;
  pm.globals.delete = pm.globals.unset;
  pm.variables.delete = pm.variables.unset;
  const headerRows = () =>
    Array.isArray(request.headers) ? request.headers : [];
  const headerGet = (name) => {
    const rows = headerRows();
    for (let i = rows.length - 1; i >= 0; i--)
      if (
        rows[i].enabled !== false &&
        String(rows[i].key).toLowerCase() === String(name).toLowerCase()
      )
        return rows[i].value;
  };
  const headerObject = () =>
    Object.fromEntries(
      headerRows()
        .filter((row) => row.enabled !== false && row.key)
        .map((row) => [row.key, row.value]),
    );
  const headerList = {
    get: headerGet,
    has: (name) => headerGet(name) !== undefined,
    all: () => copy(headerRows()),
    toObject: headerObject,
    add: (item) => {
      if (!item || typeof item !== "object")
        throw Error("Header需要{key,value}对象");
      parameterName(item.key);
      request.headers = [
        ...headerRows(),
        {
          key: item.key,
          value: String(item.value ?? ""),
          enabled: item.disabled !== true,
        },
      ];
    },
    upsert: (item) => {
      if (!item || typeof item !== "object")
        throw Error("Header需要{key,value}对象");
      modifyPair("headers", item.key, item.value);
      if (item.disabled === true)
        request.headers[request.headers.length - 1].enabled = false;
    },
    remove: (name) => modifyPair("headers", name, null, true),
    clear: () => {
      request.headers = [];
    },
    each: (fn) =>
      headerRows()
        .map(copy)
        .forEach((item, index) => fn(item, index)),
  };
  const bodyFacade = {
    get mode() {
      return ["none", "form-data", "urlencoded"].includes(request.bodyType)
        ? request.bodyType === "form-data"
          ? "formdata"
          : request.bodyType
        : "raw";
    },
    get raw() {
      return request.body || "";
    },
    update(value) {
      if (typeof value === "string") {
        request.body = value;
        request.bodyType = request.bodyType === "json" ? "json" : "raw";
        return;
      }
      if (!value || value.mode !== "raw" || typeof value.raw !== "string")
        throw Error("脚本Body.update目前支持字符串或raw对象，不读取文件");
      request.body = value.raw;
      request.bodyType =
        value.options?.raw?.language === "json" ? "json" : "raw";
    },
  };
  pm.request = {
    get method() {
      return request.method;
    },
    set method(value) {
      request.method = String(value).toUpperCase();
    },
    get url() {
      return request.url;
    },
    set url(value) {
      request.url = String(value);
    },
    headers: headerList,
    body: bodyFacade,
    addHeader: (item) => headerList.add(item),
    removeHeader: (name) => headerList.remove(name),
  };
  Object.defineProperties(request, {
    request_headers: { get: headerObject },
    request_querys: {
      get: () =>
        Object.fromEntries(
          (request.query || [])
            .filter((row) => row.enabled !== false && row.key)
            .map((row) => [row.key, row.value]),
        ),
    },
    request_bodys: { get: () => request.body || "" },
  });
  const cookies = Object.create(null);
  let responseHeaders = Object.create(null);
  if (response) {
    responseHeaders = Object.fromEntries(
      Object.entries(response.headers || {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const lines = responseHeaders["set-cookie"];
    for (const line of Array.isArray(lines) ? lines : lines ? [lines] : []) {
      const pair = String(line).split(";")[0],
        at = pair.indexOf("=");
      if (at < 1) continue;
      let value = pair.slice(at + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {}
      cookies[pair.slice(0, at).trim()] = value;
    }
    let parsed,
      parsedJSON = false;
    try {
      parsed = JSON.parse(response.body);
      parsedJSON = true;
    } catch {}
    response.code = response.status;
    response.responseTime = response.duration;
    response.headers = responseHeaders;
    response.cookies = cookies;
    response.json = parsed;
    response.raw = {
      status: response.status,
      responseTime: response.duration,
      responseText: response.body || "",
      type: parsedJSON
        ? "json"
        : String(responseHeaders["content-type"] || "").includes("xml")
          ? "xml"
          : "text",
    };
  }
  pm.response.headers = {
    get: (name) => responseHeaders[String(name).toLowerCase()],
    has: (name) => own(responseHeaders, String(name).toLowerCase()),
    all: () =>
      Object.entries(responseHeaders).map(([key, value]) => ({ key, value })),
    toObject: () => copy(responseHeaders),
  };
  pm.response.raw = response?.raw;
  pm.response.responseTime = response?.duration;
  pm.response.status = response?.statusText;
  pm.cookies = {
    get: (name) => cookies[name],
    has: (name) => own(cookies, name),
    toObject: () => copy(cookies),
  };
  pm.response.cookies = pm.cookies;
  apt.request = pm.request;
  apt.response = pm.response;
  const originalTest = pm.test;
  pm.test = (name, fn) => {
    if (tests.length >= 1000) throw Error("脚本断言最多1000条");
    return originalTest(name, fn);
  };
  apt.test = pm.test;
  apt.assert = (expression) => {
    if (tests.length >= 1000) throw Error("脚本断言最多1000条");
    const name = String(expression);
    try {
      const result = new Function(
        "response",
        "request",
        "return (" + name + ")",
      )(response ? copy(response) : null, {
        ...copy(request),
        request_headers: headerObject(),
      });
      const passed = result === true;
      tests.push({
        name: name.slice(0, 1000),
        passed,
        ...(passed ? {} : { error: "表达式未返回true" }),
      });
      return passed;
    } catch (error) {
      tests.push({
        name: name.slice(0, 1000),
        passed: false,
        error: String(error.message).slice(0, 4000),
      });
      return false;
    }
  };
  pm.assert = apt.assert;
  globalThis.postman = {
    setEnvironmentVariable: pm.environment.set,
    getEnvironmentVariable: pm.environment.get,
    clearEnvironmentVariable: pm.environment.unset,
    clearEnvironmentVariables: pm.environment.clear,
    setGlobalVariable: pm.globals.set,
    getGlobalVariable: pm.globals.get,
    clearGlobalVariable: pm.globals.unset,
    clearGlobalVariables: pm.globals.clear,
    getResponseCookie: (name) =>
      own(cookies, name) ? { name, value: cookies[name] } : undefined,
  };
  globalThis.apipost = globalThis.postman;
}
export const scriptCompatibilitySource = installScriptCompatibility.toString();
