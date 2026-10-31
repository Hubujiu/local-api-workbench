import { nativeOAuth2Definition } from "../public/native-oauth2-model.js";

const fail = (message) => {
  throw Error("原生 OAuth2 显式授权：" + message);
};
function inputObject(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("输入必须为普通对象");
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !property.enumerable ||
      !("value" in property)
    )
      fail("不接受未知字段、访问器或隐藏字段");
  }
}
function literal(value, required = false) {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    (required && !value.trim()) ||
    Buffer.byteLength(value) > 8192 ||
    /[\x00-\x1f\x7f]|\{\{|\}\}/.test(value)
  )
    fail("活动字段必须为有界已解析文本");
  return value;
}
function refreshCredential(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !value.isWellFormed() ||
    Buffer.byteLength(value) > 8192 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail("refresh token必须为显式有界令牌");
  // This is an explicitly supplied opaque credential, never a template.
  return value;
}
function endpoint(value) {
  literal(value, true);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("端点无效");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    fail("端点仅支持无内嵌凭据和片段的HTTP/HTTPS");
  return value;
}
// Explicit owner adapter only. Normal import/send/freezing never calls this.
// It does not interpolate templates, access a project, contact a provider, save
// tokens or read the original application's uid/clientId refresh-token cache.
export function nativeOAuth2GrantInput(input, operation) {
  if (!["start", "refresh"].includes(operation)) fail("操作类型无效");
  inputObject(
    input,
    operation === "start" ? ["auth"] : ["auth", "refreshToken"],
  );
  const definition = nativeOAuth2Definition(input.auth);
  if (!definition) fail("须提供完整原生OAuth2定义");
  if (
    !["authorization_code", "authorization_code_with_pkce"].includes(
      definition.grant_type,
    )
  )
    fail("仅支持显式授权码/S256流程，不会回退其他grant");
  if (!["header", "body"].includes(definition.client_authentication))
    fail("客户端认证必须明确为header或body");
  for (const key of [
    "authRequestParams",
    "tokenRequestParams",
    "refreshRequestParams",
  ])
    if (definition[key]?.length) fail("首片不支持自定义授权参数");
  const config = {
    clientId: literal(definition.clientId, true),
    clientAuthentication:
      definition.client_authentication === "header" ? "basic" : "body",
    ...(definition.clientSecret !== undefined
      ? { clientSecret: literal(definition.clientSecret) }
      : {}),
    ...(definition.scope !== undefined
      ? { scope: literal(definition.scope) }
      : {}),
    tokenEndpoint: endpoint(
      operation === "start"
        ? definition.accessTokenUrl
        : definition.refreshTokenUrl,
    ),
  };
  if (operation === "start") {
    for (const key of ["redirect_uri", "state", "code_verifier"])
      if (definition[key])
        fail("须使用后端生成的回调、单次state和PKCE verifier");
    if (![undefined, "", "S256"].includes(definition.challengeAlgorithm))
      fail("授权码流程仅支持后端生成的S256");
    config.authorizationEndpoint = endpoint(definition.authUrl);
    return { config };
  }
  // Refresh has no callback/PKCE. Those inactive source fields are not mapped.
  // No fallback to accessTokenUrl and no hidden cache lookup is allowed.
  return {
    config,
    grant: {
      grant_type: "refresh_token",
      refresh_token: refreshCredential(input.refreshToken),
    },
  };
}
