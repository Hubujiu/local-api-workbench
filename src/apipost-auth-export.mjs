import { exportApipostOAuth2 } from "./apipost-oauth2-auth.mjs";
import { exportApipostOAuth1 } from "./apipost-oauth1-auth.mjs";
import { exportApipostNtlm } from "./apipost-ntlm-auth.mjs";
import { exportApipostDigest } from "./apipost-digest-auth.mjs";
import { exportApipostAsap } from "./apipost-asap-auth.mjs";
import { isDeepStrictEqual } from "node:util";
import { importExtendedApipostAuth } from "./apipost-auth-import.mjs";
import { importJwtConfig } from "../public/jwt-auth-model.js";

const jwtFields = new Set([
  "type",
  "algorithm",
  "secret",
  "isSecretBase64Encoded",
  "payload",
  "headerPrefix",
  "queryParamKey",
  "header",
  "addTokenTo",
]);
function exportJwtDefinition(value) {
  const fail = () => {
    throw Error("原生JWT认证导出无法无损保留此定义；请使用项目备份");
  };
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !jwtFields.has(key) ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      fail();
  }
  const config = Object.fromEntries(
    Object.entries(descriptors)
      .filter(([key]) => key !== "type")
      .map(([key, descriptor]) => [key, descriptor.value]),
  );
  // This validates definition shape only. Never sign, parse keys, normalize
  // defaults or resolve templates while exporting explicit saved credentials.
  try {
    if (!isDeepStrictEqual(importJwtConfig(config), { ...value })) fail();
  } catch {
    // Import errors can include arbitrary unknown field names. Keep the export
    // boundary independent of error text and never echo source credentials.
    fail();
  }
  return { type: "jwt", jwt: config };
}

// Definition conversion only: never signs, obtains credentials, or sends traffic.
export function exportExtendedApipostAuth(value) {
  if (value && typeof value === "object") {
    const type = Object.getOwnPropertyDescriptor(value, "type");
    if ((!type && "type" in value) || (type && !Object.hasOwn(type, "value")))
      throw Error("原生认证导出不接受访问器定义；请使用项目备份");
    if (type?.value === "jwt") return exportJwtDefinition(value);
    if (type?.value === "asap") return exportApipostAsap(value);
    if (type?.value === "digest") return exportApipostDigest(value);
    if (type?.value === "ntlm") return exportApipostNtlm(value);
    if (type?.value === "oauth1") return exportApipostOAuth1(value);
    if (type?.value === "oauth2") return exportApipostOAuth2(value);
  }
  if (!["aws", "hawk", "edgegrid"].includes(value?.type)) return undefined;
  const fail = () => {
    throw Error("原生认证导出无法无损映射此配置；请使用项目备份");
  };
  const fields = (names, extras = []) => {
    if (
      Object.keys(value).some(
        (key) => !["type", ...names, ...extras].includes(key),
      )
    )
      fail();
    return Object.fromEntries(
      names.map((key) => {
        if (value[key] !== undefined && typeof value[key] !== "string") fail();
        return [key, value[key] ?? ""];
      }),
    );
  };
  let native, expected;
  if (value.type === "aws") {
    const config = fields(
      ["accessKey", "secretKey", "sessionToken", "region", "service"],
      ["addAuthDataToQuery"],
    );
    if (value.addAuthDataToQuery !== undefined) {
      if (typeof value.addAuthDataToQuery !== "boolean") fail();
      config.addAuthDataToQuery = value.addAuthDataToQuery;
    }
    native = { type: "awsv4", awsv4: config };
    expected = { type: "aws", ...config };
  } else if (value.type === "hawk") {
    const config = fields(
      ["id", "key", "algorithm", "app", "dlg", "ext", "nonce", "timestamp"],
      ["payloadHash"],
    );
    if (
      value.payloadHash !== undefined &&
      !["enabled", "disabled"].includes(value.payloadHash)
    )
      fail();
    config.algorithm ||= "sha256";
    expected = {
      type: "hawk",
      ...config,
      payloadHash: value.payloadHash ?? "enabled",
    };
    const { id, key, dlg, ext, ...rest } = config;
    native = {
      type: "hawk",
      hawk: {
        ...rest,
        authId: id,
        authKey: key,
        delegation: dlg,
        extraData: ext,
        includePayloadHash: expected.payloadHash === "enabled",
        user: "",
      },
    };
  } else {
    const config = fields([
      "clientToken",
      "clientSecret",
      "accessToken",
      "baseURL",
      "headersToSign",
      "nonce",
      "timestamp",
    ]);
    expected = { type: "edgegrid", ...config };
    const { baseURL, ...rest } = config;
    native = { type: "edgegrid", edgegrid: { ...rest, baseURi: baseURL } };
  }
  if (!isDeepStrictEqual(importExtendedApipostAuth(native), expected)) fail();
  return native;
}
