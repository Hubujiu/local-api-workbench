import { validateHeaderValue } from "node:http";
import sdk from "./vendor/url-sdk-host.js";
import urlEncoder from "postman-url-encoder";
import { nativeOAuth2Definition } from "../public/native-oauth2-model.js";

const fail = () => {
  throw Error("原生 OAuth2 令牌注入字段无效");
};
function ready(value) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    /[\x00-\x1f\x7f]|\{\{|\}\}/.test(value) ||
    Buffer.byteLength(value) > 8192
  )
    fail();
  return value;
}
// Only the selected injection fields are used. Grant metadata remains inert.
export function applyNativeOAuth2(url, headers, auth) {
  const definition = nativeOAuth2Definition(auth);
  if (definition === undefined) return false;
  const placement = definition.addTokenTo;
  if (!placement || !definition.access_token) return true;
  const token = ready(definition.access_token);
  if (placement === "header") {
    const prefix = ready(definition.headerPrefix || "Bearer");
    const value = prefix + " " + token;
    try {
      validateHeaderValue("authorization", value);
    } catch {
      fail();
    }
    headers.authorization = value;
  } else {
    // Reuse the reviewed SDK and legacy encoder on a single synthetic pair.
    // Never parse/rewrite the real host/path/query, or replace an existing token.
    const query = new sdk.Url({
      query: [{ key: "access_token", value: token }],
    }).getQueryString();
    const pair = urlEncoder.toLegacyNodeUrl(
      "http://oauth.invalid/?" + query,
    ).query;
    if (
      typeof pair !== "string" ||
      !pair.startsWith("access_token=") ||
      pair.includes("&") ||
      pair.includes("#")
    )
      fail();
    url.search = (url.search ? url.search.slice(1) + "&" : "") + pair;
  }
  return true;
}
