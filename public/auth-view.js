import { asapAlgorithms } from "./asap-auth-model.js";
import { jwtAlgorithms } from "./jwt-auth-model.js";
import { authTypes } from "./auth-model.js";
export { authTypes } from "./auth-model.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const fields = {
  none: [],
  asap: ["iss", "aud", "kid", "privateKey", "sub", "ttlSeconds", "claims"],
  jwt: ["secret", "payload", "header", "headerPrefix", "queryParamKey"],
  edgegrid: [
    "clientToken",
    "clientSecret",
    "accessToken",
    "baseURL",
    "headersToSign",
    "maxBodySize",
    "nonce",
    "timestamp",
  ],
  hawk: ["id", "key", "ext", "app", "dlg", "nonce", "timestamp"],
  bearer: ["token"],
  basic: ["username", "password"],
  digest: ["username", "password"],
  ntlm: ["username", "password", "domain", "workstation"],
  oauth1: [
    "requestTokenEndpoint",
    "authorizationEndpoint",
    "tokenEndpoint",
    "consumerKey",
    "consumerSecret",
    "accessToken",
    "tokenSecret",
    "privateKey",
    "privateKeyPassphrase",
    "realm",
    "nonce",
    "timestamp",
    "version",
    "callback",
    "verifier",
  ],
  oauth2: [
    "authorizationEndpoint",
    "tokenEndpoint",
    "clientId",
    "clientSecret",
    "clientAuthentication",
    "scope",
    "refreshToken",
    "token",
  ],
  aws: [
    "accessKey",
    "secretKey",
    "sessionToken",
    "region",
    "service",
    "signingDate",
  ],
  apiKey: ["key", "value", "in"],
};
const secret = new Set([
  "password",
  "token",
  "consumerSecret",
  "tokenSecret",
  "privateKeyPassphrase",
  "clientSecret",
  "refreshToken",
  "secretKey",
  "sessionToken",
  "accessToken",
]);
const hints = {
  in: "header 或 query",
  aud: "单个受众，或JSON字符串数组",
  kid: "Issuer/key-id",
  ttlSeconds: "1至3600秒，默认60",
  clientAuthentication: "body 或 basic",
  nonce: "留空每次自动生成",
  timestamp: "留空每次自动生成",
  version: "留空或1.0",
  signingDate: "留空使用当前时间，或ISO时间",
};
const options = (list, selected) =>
  list
    .map(
      (value) =>
        `<option ${value === selected ? "selected" : ""}>${esc(value)}</option>`,
    )
    .join("");
export function authPanel(auth = {}, { acquire = true, shared = false } = {}) {
  const attribute = shared ? "data-shared-auth" : "data-auth";
  const type = auth.type || "none";
  let html =
    '<div class="form-grid"><label>认证类型</label><select id="' +
    (shared ? "shared-auth-type" : "auth-type") +
    '">' +
    options(authTypes, type) +
    "</select>";
  if (type === "asap")
    html +=
      "<label>ASAP算法</label><select " +
      attribute +
      '="alg">' +
      options(asapAlgorithms, auth.alg || "RS256") +
      "</select>";
  if (type === "jwt")
    html +=
      "<label>JWT算法</label><select " +
      attribute +
      '="algorithm">' +
      options(jwtAlgorithms, auth.algorithm || "HS256") +
      "</select><label>发送位置</label><select " +
      attribute +
      '="addTokenTo">' +
      options(["header", "queryParam"], auth.addTokenTo || "header") +
      "</select><label>Secret为Base64</label><select " +
      attribute +
      '="isSecretBase64Encoded">' +
      options(["false", "true"], String(auth.isSecretBase64Encoded ?? false)) +
      "</select>";
  if (type === "hawk")
    html +=
      "<label>Hawk算法</label><select " +
      attribute +
      '="algorithm">' +
      options(["sha256", "sha1"], auth.algorithm || "sha256") +
      "</select><label>请求体Hash</label><select " +
      attribute +
      '="payloadHash">' +
      options(["enabled", "disabled"], auth.payloadHash || "enabled") +
      "</select>";
  if (type === "oauth1")
    html +=
      "<label>签名算法</label><select " +
      attribute +
      '="signatureMethod">' +
      options(
        ["HMAC-SHA1", "HMAC-SHA256", "RSA-SHA1"],
        auth.signatureMethod || "HMAC-SHA1",
      ) +
      "</select>";
  if (type === "oauth2")
    html +=
      "<label>授权方式</label><select " +
      attribute +
      '="grantType">' +
      options(
        ["client_credentials", "authorization_code", "refresh_token"],
        auth.grantType || "client_credentials",
      ) +
      "</select>";
  html +=
    (fields[type] || [])
      .map((key) =>
        (type === "jwt" && ["secret", "payload", "header"].includes(key)) ||
        (type === "asap" && key === "claims")
          ? `<label>${esc(key === "secret" ? "Secret / PEM私钥" : key)}</label><textarea ${attribute}="${key}" rows="3" autocomplete="off" spellcheck="false">${esc(auth[key] ?? (key === "secret" ? "" : "{}"))}</textarea>`
          : key === "privateKey"
            ? `<label>privateKey (${type === "asap" ? "RSA / EC" : "RSA"} PEM)</label><textarea ${attribute}="privateKey" rows="4" autocomplete="off" spellcheck="false" placeholder="${type === "asap" ? "未加密PEM或{{变量}}，不读取文件路径" : "仅RSA-SHA1；直接粘贴PEM或{{变量}}，不读取文件路径"}">${esc(auth[key])}</textarea>`
            : `<label>${key === "ttlSeconds" ? "有效期（秒）" : key}</label><input ${attribute}="${key}" value="${esc(auth[key] ?? (type === "jwt" ? { headerPrefix: "Bearer", queryParamKey: "token" }[key] : type === "asap" && key === "ttlSeconds" ? "60" : ""))}" type="${secret.has(key) || (type === "hawk" && key === "key") ? "password" : "text"}" placeholder="${esc(hints[key] || "支持 {{变量}}")}">`,
      )
      .join("") + "</div>";
  if (type === "jwt")
    html +=
      '<p class="notice">JWT仅在本机签名，不登录、不读取密钥文件；HMAC密钥至少32/48/64字节，RSA为2048至8192位，EC曲线必须匹配。仅接受未加密PEM；Payload/Header为JSON对象，不自动添加iat/exp。仅支持alg/typ/cty/kid头字段，拒绝none和远程取钥。保存会把Secret/私钥明文写入项目；Query令牌可能进入URL、历史和日志，请优先HTTPS Header，勿提交真实凭据到Git。</p>';
  if (type === "asap")
    html +=
      '<p class="notice">ASAP按协议仅允许非对称签名，默认RS256；仅发送Bearer Header。Issuer与公钥必须已在服务端登记，本工具不注册服务、不上传或发现密钥。有效期默认60秒、最多3600秒，每次生成新jti；claims不得覆盖专用字段。仅支持未加密内联PEM。保存会明文写入私钥，请优先HTTPS，勿提交真实凭据到Git。</p>';
  if (type === "ntlm")
    html +=
      '<div class="notice">有限NTLMv2：仅HTTP/1.1直连，不读取系统凭据、不降级v1。需要MIC/EPA/通道绑定的服务会拒绝；请使用可信服务并优先HTTPS。保存会把密码写入本地项目，历史可能包含认证响应；勿提交真实凭据到Git。</div>';

  if (type === "oauth2") {
    if (acquire)
      html += '<p><button id="oauth-get" class="primary">获取令牌</button></p>';
    html += acquire
      ? '<div class="notice">授权码模式启用PKCE S256。凭据只发送到配置的endpoint；优先使用HTTPS。获取的令牌仅在当前编辑状态，保存时才写入项目。</div>'
      : '<div class="notice">步骤快照使用明确填写的令牌，不自动启动授权跳转。</div>';
  }
  if (type === "oauth1" && acquire)
    html +=
      '<p><button id="oauth1-get" class="primary">OAuth1 授权（OOB/PIN）</button></p>';
  if (type === "oauth1")
    html +=
      '<p class="notice">对最终URL与表单参数签名。优先使用HTTPS；可使用已有凭据；OOB/PIN流程可请求临时令牌、打开服务授权页并用验证码交换访问令牌。服务必须支持OOB，端点和Consumer凭据需填明确值。RSA-SHA1仅兼容旧服务，非新系统推荐算法；RSA私钥仅在本机签名，不发送私钥。保存接口/步骤会把填写的凭据写入本地项目文件，请勿提交真实密钥到Git。PLAINTEXT尚不支持。</p>';
  if (type === "aws")
    html +=
      '<p class="notice">AWS Signature V4使用明确填写的凭据与region/service，不读取系统AWS配置或自动登录。对最终请求体计算SHA256；S3使用对应路径规则。重复的普通请求头按顺序规范化空白并以逗号合并后签名发送；Cookie及签名控制头不接受重复。优先使用HTTPS。</p>';
  if (type === "edgegrid")
    html +=
      '<p class="notice">EdgeGrid EG1-HMAC-SHA256；仅使用明确填写的凭据，不读取.edgerc。timestamp格式YYYYMMDDTHH:mm:ss+0000，留空自动生成。headersToSign为按顺序逗号分隔的Header名，POST默认对前131072字节计算Hash，不截断发送内容。</p>';
  if (type === "hawk")
    html +=
      '<p class="notice">使用本地填写的Hawk凭据生成MAC；默认包含已有请求体Hash。nonce/时间戳留空自动生成。不执行远端登录或时钟同步，也不校验Server-Authorization响应。</p>';
  return html;
}
