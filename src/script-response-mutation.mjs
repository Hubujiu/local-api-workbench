// Pure validation is shared by the host and the isolated VM. No host bindings.
export function validateResponseMutation(
  value,
  hasResponse = true,
  originals = false,
) {
  if (value == null) return null;
  if (!hasResponse) throw Error("响应修改仅支持已有响应的后置脚本");
  if (typeof value !== "object" || Array.isArray(value))
    throw Error("响应修改必须是对象");
  const result = {};
  for (const key of Object.keys(value)) {
    if (key === "status") {
      if (
        !Number.isInteger(value.status) ||
        value.status < 100 ||
        value.status > 599
      )
        throw Error("响应状态须为100至599的整数");
      result.status = value.status;
    } else if (key === "body") {
      if (typeof value.body !== "string")
        throw Error("响应正文须可序列化为文本");
      const limit = originals ? 512 * 1024 : 64 * 1024;
      let bytes = 0;
      for (let i = 0; i < value.body.length; i++) {
        const code = value.body.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.body.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff))
            throw Error("响应正文包含无效Unicode");
          bytes += 4;
        } else if (code >= 0xdc00 && code <= 0xdfff)
          throw Error("响应正文包含无效Unicode");
        else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
        if (bytes > limit)
          throw Error(
            originals ? "响应原值超过512KiB" : "响应修改正文超过64KiB",
          );
      }
      result.body = value.body;
    } else throw Error("响应修改只支持body和status");
  }
  return Object.keys(result).length ? result : null;
}

function installResponseMutation(
  { response, pm, apt, previous, wireResponse },
  validate,
) {
  let changes = null;
  let originals = validate(previous, Boolean(response), true);
  const facades = [...new Set([pm.response, apt.response])];
  const json = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  // Shared stages get the original phase response separately from their working view.
  if (response && wireResponse) {
    const body = wireResponse.body || "";
    const raw = {
      status: wireResponse.status,
      responseTime: wireResponse.duration,
      responseText: body,
      type:
        json(body) !== undefined
          ? "json"
          : String(response.headers?.["content-type"] || "").includes("xml")
            ? "xml"
            : "text",
    };
    response.raw = raw;
    for (const facade of facades) facade.raw = raw;
  }
  const installOriginalReaders = () => {
    for (const facade of facades) {
      if (
        originals &&
        Object.prototype.hasOwnProperty.call(originals, "body")
      ) {
        facade.originalText = () => originals.body;
        facade.originalJson = () => json(originals.body) ?? null;
      }
      if (
        originals &&
        Object.prototype.hasOwnProperty.call(originals, "status")
      )
        facade.originalCode = () => originals.status;
    }
  };
  installOriginalReaders();
  const setBody = (value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const change = validate({ body: text }, Boolean(response));
    const prior = validate(
      { ...originals, body: response.body || "" },
      true,
      true,
    );
    response.body = text;
    response.json = json(text);
    for (const facade of facades)
      if (typeof facade.json !== "function") facade.json = json(text);
    originals = prior;
    changes = { ...changes, ...change };
    installOriginalReaders();
  };
  const setCode = (code) => {
    const change = validate({ status: code }, Boolean(response));
    const prior = validate(
      { ...originals, status: response.status },
      true,
      true,
    );
    response.status = response.code = code;
    for (const facade of facades) facade.code = code;
    originals = prior;
    changes = { ...changes, ...change };
    installOriginalReaders();
  };
  for (const facade of facades) {
    facade.setBody = setBody;
    facade.setCode = setCode;
  }
  return () => ({
    responseOverride: validate(changes, Boolean(response)),
    responseOriginals: validate(originals, Boolean(response), true),
  });
}

export const responseMutationSource = installResponseMutation.toString();
export const responseMutationValidatorSource =
  validateResponseMutation.toString();
