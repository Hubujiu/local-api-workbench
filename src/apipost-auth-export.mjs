import { isDeepStrictEqual } from "node:util";
import { importExtendedApipostAuth } from "./apipost-auth-import.mjs";

// Definition conversion only: never signs, obtains credentials, or sends traffic.
export function exportExtendedApipostAuth(value) {
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
