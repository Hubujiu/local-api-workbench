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
  oauth1: [
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
export function authPanel(auth = {}, { acquire = true } = {}) {
  const type = auth.type || "none";
  let html =
    '<div class="form-grid"><label>认证类型</label><select id="auth-type">' +
    options(authTypes, type) +
    "</select>";
  if (type === "hawk")
    html +=
      '<label>Hawk算法</label><select data-auth="algorithm">' +
      options(["sha256", "sha1"], auth.algorithm || "sha256") +
      '</select><label>请求体Hash</label><select data-auth="payloadHash">' +
      options(["enabled", "disabled"], auth.payloadHash || "enabled") +
      "</select>";
  if (type === "oauth1")
    html +=
      '<label>签名算法</label><select data-auth="signatureMethod">' +
      options(
        ["HMAC-SHA1", "HMAC-SHA256", "RSA-SHA1"],
        auth.signatureMethod || "HMAC-SHA1",
      ) +
      "</select>";
  if (type === "oauth2")
    html +=
      '<label>授权方式</label><select data-auth="grantType">' +
      options(
        ["client_credentials", "authorization_code", "refresh_token"],
        auth.grantType || "client_credentials",
      ) +
      "</select>";
  html +=
    (fields[type] || [])
      .map((key) =>
        key === "privateKey"
          ? `<label>privateKey (RSA PEM)</label><textarea data-auth="privateKey" rows="4" autocomplete="off" spellcheck="false" placeholder="仅RSA-SHA1；直接粘贴PEM或{{变量}}，不读取文件路径">${esc(auth[key])}</textarea>`
          : `<label>${key}</label><input data-auth="${key}" value="${esc(auth[key])}" type="${secret.has(key) || (type === "hawk" && key === "key") ? "password" : "text"}" placeholder="${esc(hints[key] || "支持 {{变量}}")}">`,
      )
      .join("") + "</div>";
  if (type === "oauth2") {
    if (acquire)
      html += '<p><button id="oauth-get" class="primary">获取令牌</button></p>';
    html += acquire
      ? '<div class="notice">授权码模式启用PKCE S256。凭据只发送到配置的endpoint；优先使用HTTPS。获取的令牌仅在当前编辑状态，保存时才写入项目。</div>'
      : '<div class="notice">步骤快照使用明确填写的令牌，不自动启动授权跳转。</div>';
  }
  if (type === "oauth1")
    html +=
      '<p class="notice">对最终URL与表单参数签名。优先使用HTTPS；此处使用已有凭据，不自动运行OAuth1授权跳转。RSA-SHA1仅兼容旧服务，非新系统推荐算法；RSA私钥仅在本机签名，不发送私钥。保存接口/步骤会把填写的凭据写入本地项目文件，请勿提交真实密钥到Git。PLAINTEXT尚不支持。</p>';
  if (type === "aws")
    html +=
      '<p class="notice">AWS Signature V4使用明确填写的凭据与region/service，不读取系统AWS配置或自动登录。对最终请求体计算SHA256；S3使用对应路径规则。优先使用HTTPS。</p>';
  if (type === "edgegrid")
    html +=
      '<p class="notice">EdgeGrid EG1-HMAC-SHA256；仅使用明确填写的凭据，不读取.edgerc。timestamp格式YYYYMMDDTHH:mm:ss+0000，留空自动生成。headersToSign为按顺序逗号分隔的Header名，POST默认对前131072字节计算Hash，不截断发送内容。</p>';
  if (type === "hawk")
    html +=
      '<p class="notice">使用本地填写的Hawk凭据生成MAC；默认包含已有请求体Hash。nonce/时间戳留空自动生成。不执行远端登录或时钟同步，也不校验Server-Authorization响应。</p>';
  return html;
}
