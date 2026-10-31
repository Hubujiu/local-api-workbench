import { validateHeaderValue } from "node:http";
import sdk from "./vendor/url-sdk-host.js";
import urlEncoder from "postman-url-encoder";
import { postmanOAuth2Definition } from "../public/postman-oauth2-model.js";
const fail = () => {
  throw Error("Postman OAuth2 令牌尚未解析或不能安全发送");
};
function ready(value) {
  if (/\{\{|\}\}/.test(value)) fail();
  return value;
}
export function applyPostmanOAuth2(url, headers, auth) {
  const definition = postmanOAuth2Definition(auth);
  if (definition === undefined) return false;
  if (!definition.accessToken) return true;
  const token = ready(definition.accessToken);
  let pair, authorization;
  if (definition.addTokenTo === "queryParams") {
    const query = new sdk.Url({
      query: [{ key: "access_token", value: token }],
    }).getQueryString();
    pair = urlEncoder.toLegacyNodeUrl("http://oauth.invalid/?" + query).query;
    if (
      typeof pair !== "string" ||
      !pair.startsWith("access_token=") ||
      pair.includes("&") ||
      pair.includes("#")
    )
      fail();
  } else {
    const prefix = ready(definition.headerPrefix ?? "Bearer").trim();
    authorization = (prefix ? prefix + " " : "") + token;
    try {
      validateHeaderValue("authorization", authorization);
    } catch {
      fail();
    }
  }
  // Postman matches literal raw query keys, not URLSearchParams-decoded keys.
  // Only touch matching segments; preserve unrelated spelling/order/separators.
  const raw = url.search.slice(1);
  if (raw.length > 1024 * 1024) fail();
  const rows = raw ? raw.split("&") : [];
  if (rows.length > 10000) fail();
  const kept = rows.filter((row) => {
    const at = row.indexOf("=");
    return (at < 0 ? row : row.slice(0, at)) !== "access_token";
  });
  if (pair !== undefined) kept.push(pair);
  url.search = kept.join("&");
  delete headers.authorization;
  if (authorization !== undefined) headers.authorization = authorization;
  return true;
}
