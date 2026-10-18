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
  bearer: ["token"],
  basic: ["username", "password"],
  digest: ["username", "password"],
  oauth1: [
    "consumerKey",
    "consumerSecret",
    "accessToken",
    "tokenSecret",
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
export function authPanel(auth = {}) {
  const type = auth.type || "none";
  let html =
    '<div class="form-grid"><label>认证类型</label><select id="auth-type">' +
    options(authTypes, type) +
    "</select>";
  if (type === "oauth1")
    html +=
      '<label>签名算法</label><select data-auth="signatureMethod">' +
      options(
        ["HMAC-SHA1", "HMAC-SHA256"],
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
      .map(
        (key) =>
          `<label>${key}</label><input data-auth="${key}" value="${esc(auth[key])}" type="${secret.has(key) ? "password" : "text"}" placeholder="${esc(hints[key] || "支持 {{变量}}")}">`,
      )
      .join("") + "</div>";
  if (type === "oauth2")
    html +=
      '<p><button id="oauth-get" class="primary">获取令牌</button></p><div class="notice">授权码模式启用PKCE S256。凭据只发送到配置的endpoint；优先使用HTTPS。获取的令牌仅在当前编辑状态，保存时才写入项目。</div>';
  if (type === "oauth1")
    html +=
      '<p class="notice">对最终URL与表单参数签名。优先使用HTTPS；此处使用已有凭据，不自动运行OAuth1授权跳转。RSA/PLAINTEXT尚不支持。</p>';
  if (type === "aws")
    html +=
      '<p class="notice">AWS Signature V4使用明确填写的凭据与region/service，不读取系统AWS配置或自动登录。对最终请求体计算SHA256；S3使用对应路径规则。优先使用HTTPS。</p>';
  return html;
}
