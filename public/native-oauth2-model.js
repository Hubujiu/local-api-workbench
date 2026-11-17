// Native definitions are data. OAuthManager grant configuration is separate.
const strings = [
  "addTokenTo",
  "headerPrefix",
  "access_token",
  "grant_type",
  "redirect_uri",
  "authUrl",
  "accessTokenUrl",
  "clientId",
  "clientSecret",
  "username",
  "password",
  "challengeAlgorithm",
  "code_verifier",
  "scope",
  "state",
  "client_authentication",
  "refreshTokenUrl",
];
const arrays = [
  "authRequestParams",
  "tokenRequestParams",
  "refreshRequestParams",
];
const fail = () => {
  throw Error("原生 OAuth2 定义无效或超过安全限制");
};
function own(value) {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  return Object.getOwnPropertyDescriptors(value);
}
function entries(descriptors) {
  return Reflect.ownKeys(descriptors).map((key) => {
    const d = descriptors[key];
    if (
      typeof key !== "string" ||
      !d.enumerable ||
      !Object.hasOwn(d, "value") ||
      ["__proto__", "prototype", "constructor"].includes(key)
    )
      fail();
    return [key, d.value];
  });
}
export function nativeOAuth2Definition(auth) {
  if (!auth || typeof auth !== "object" || !("nativeOAuth2" in auth)) return;
  const fields = entries(own(auth));
  if (
    fields.length !== 2 ||
    fields.some(([key]) => !["type", "nativeOAuth2"].includes(key)) ||
    fields.find(([key]) => key === "type")?.[1] !== "oauth2"
  )
    fail();
  const source = fields.find(([key]) => key === "nativeOAuth2")?.[1];
  let nodes = 0;
  const active = new Set();
  function json(value, depth) {
    if (++nodes > 2048 || depth > 8) fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (!value.isWellFormed()) fail();
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) fail();
      return value;
    }
    if (!value || typeof value !== "object" || active.has(value)) fail();
    active.add(value);
    let result;
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > 256
      )
        fail();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail();
      result = [];
      for (let index = 0; index < value.length; index++) {
        const d = descriptors[index];
        if (!d?.enumerable || !Object.hasOwn(d, "value")) fail();
        result.push(json(d.value, depth + 1));
      }
    } else {
      result = Object.fromEntries(
        entries(own(value)).map(([key, item]) => [key, json(item, depth + 1)]),
      );
    }
    active.delete(value);
    return result;
  }
  const definition = {};
  for (const [key, value] of entries(own(source))) {
    if (strings.includes(key)) {
      if (typeof value !== "string" || !value.isWellFormed()) fail();
      definition[key] = value;
    } else if (arrays.includes(key)) {
      if (!Array.isArray(value)) fail();
      definition[key] = json(value, 0);
    } else fail();
  }
  if (
    definition.addTokenTo !== undefined &&
    !["", "header", "queryParams"].includes(definition.addTokenTo)
  )
    fail();
  if (new TextEncoder().encode(JSON.stringify(definition)).length > 65536)
    fail();
  return definition;
}
