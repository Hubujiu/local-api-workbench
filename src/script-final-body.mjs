// Runs inside the existing QuickJS VM. No host callbacks or modules.
function installFinalBody({ request, response, pm, apt, previous }) {
  const matches = (value) =>
    value && value.bodyType === request.bodyType && value.body === request.body;
  let finalized = matches(previous) ? previous : undefined;
  if (!response) {
    const source = request.body ?? "";
    const inherited = finalized;
    const finalize = () => {
      if (
        !["raw", "json"].includes(request.bodyType) ||
        typeof source !== "string"
      )
        throw Error("getFinalRequestRawBody目前仅支持文本或JSON正文");
      if (/\{\{@value:[A-Za-z0-9_-]{1,100}\}\}/.test(source))
        throw Error(
          "getFinalRequestRawBody暂不支持声明式动态正文，请使用普通变量或项目备份",
        );
      // A proof carried from a preceding fresh VM already contains literal output.
      const body = inherited ? inherited.body : pm.variables.replaceIn(source);
      pm.setRequestBody(body);
      finalized = { body: request.body, bodyType: request.bodyType };
      return body;
    };
    pm.getFinalRequestRawBody = finalize;
    apt.getFinalRequestRawBody = finalize;
  }
  return () => (matches(finalized) ? finalized : undefined);
}
export const finalBodySource = installFinalBody.toString();

// Execution-only metadata, never a persisted request-definition property.
export function finalBodyLiteral(proof, request) {
  if (proof === undefined) return undefined;
  if (
    !proof ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(proof))
  )
    throw Error("最终正文记录无效");
  const keys = Reflect.ownKeys(proof),
    fields = Object.getOwnPropertyDescriptors(proof);
  if (
    keys.length !== 2 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !["body", "bodyType"].includes(key) ||
        !fields[key].enumerable ||
        !Object.hasOwn(fields[key], "value"),
    ) ||
    typeof fields.body?.value !== "string" ||
    !["raw", "json"].includes(fields.bodyType?.value) ||
    Buffer.byteLength(fields.body.value, "utf8") > 65536
  )
    throw Error("最终正文记录无效或超过64KiB");
  return proof.body === request.body && proof.bodyType === request.bodyType
    ? proof.body
    : undefined;
}
