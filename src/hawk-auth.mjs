import Hawk from "hawk";
export function hawkAuthorization(url, method, headers, body, auth = {}) {
  if (
    typeof auth.id !== "string" ||
    !auth.id ||
    typeof auth.key !== "string" ||
    !auth.key
  )
    throw Error("Hawk需要明确填写id与key");
  const algorithm = auth.algorithm || "sha256";
  if (!["sha1", "sha256"].includes(algorithm))
    throw Error("Hawk仅支持sha1/sha256");
  const target = new URL(url);
  if (headers.host) {
    if (/[\s\/@?#]/.test(headers.host)) throw Error("Hawk Host无效");
    target.host = headers.host;
  }
  const options = {
    credentials: { id: auth.id, key: auth.key, algorithm },
    contentType: headers["content-type"] || "",
  };
  for (const key of ["ext", "nonce", "app", "dlg"])
    if (auth[key]) options[key] = String(auth[key]);
  if (auth.timestamp !== undefined && auth.timestamp !== "") {
    const timestamp = Number(auth.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
      throw Error("Hawk时间戳必须为正整数秒");
    options.timestamp = timestamp;
  }
  if (body !== undefined && auth.payloadHash !== "disabled")
    options.payload = body;
  return Hawk.client.header(target.href, method, options);
}
