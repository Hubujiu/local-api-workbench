import { createHash } from "node:crypto";
import { applySharedAuth } from "./shared-auth.mjs";

// Definition-only projection. Imported security is not executable auth configuration.
export function openAPIAuthDefinition(project, request, registry) {
  if (
    registry !== undefined &&
    (!registry || typeof registry !== "object" || Array.isArray(registry))
  )
    throw Error("OpenAPI securitySchemes 无效");
  const explicit = request.auth?.type && request.auth.type !== "none";
  const closed = request.authSnapshot === true || request.inheritAuth === false;
  if (
    !explicit &&
    !closed &&
    Object.hasOwn(request.openapiOperation || {}, "security")
  )
    return { security: structuredClone(request.openapiOperation.security) };
  const auth = applySharedAuth(project, request).auth || { type: "none" };
  if (!auth.type || auth.type === "none") return { security: [] };
  let scheme;
  switch (auth.type) {
    case "basic":
      scheme = { type: "http", scheme: "basic" };
      break;
    case "bearer":
      scheme = { type: "http", scheme: "bearer" };
      break;
    case "apiKey": {
      if (
        typeof auth.key !== "string" ||
        !auth.key.trim() ||
        /[\r\n]/.test(auth.key) ||
        ![undefined, "header", "query"].includes(auth.in)
      )
        throw Error("OpenAPI API Key 定义须包含有效名称和 header/query 位置");
      scheme = { type: "apiKey", in: auth.in ?? "header", name: auth.key };
      break;
    }
    case "jwt":
    case "asap":
      scheme =
        auth.type === "jwt" && auth.addTokenTo === "queryParam"
          ? {
              type: "apiKey",
              in: "query",
              name: auth.queryParamKey ?? "token",
              description: "JWT; signing credentials are not exported",
            }
          : auth.type === "asap" || (auth.headerPrefix ?? "Bearer") === "Bearer"
            ? { type: "http", scheme: "bearer", bearerFormat: "JWT" }
            : {
                type: "apiKey",
                in: "header",
                name: "Authorization",
                description:
                  "JWT with an explicit custom prefix; signing credentials are not exported",
              };
      break;
    default:
      throw Error("OpenAPI 不支持此认证机制的定义投影，请使用项目备份");
  }
  const legacy = ["jwt", "asap"].includes(auth.type);
  const name =
    (legacy ? "localapi_jwt_" : "localapi_auth_") +
    createHash("sha256")
      .update(JSON.stringify(scheme))
      .digest("hex")
      .slice(0, 12);
  if (
    registry &&
    Object.hasOwn(registry, name) &&
    JSON.stringify(registry[name]) !== JSON.stringify(scheme)
  )
    throw Error(legacy ? "OpenAPI JWT认证方案冲突" : "OpenAPI 认证方案冲突");
  return {
    security: [{ [name]: [] }],
    securitySchemes: { ...structuredClone(registry || {}), [name]: scheme },
  };
}
