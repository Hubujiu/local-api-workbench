import { nativeCookieName } from "./native-cookie-name.mjs";
// Identity, not serialized response fields, carries transport authority. Neither
// imported records nor sandbox-created response objects can mint this evidence.
const evidenceByResponse = new WeakMap();
const cookieEvidenceByResponse = new WeakMap();
export const HTTP1_HEADER_PAIR_LIMIT = 1000;
export const NATIVE_HEADER_PAIR_LIMIT = 256;
const incomplete = Object.freeze({ complete: false });

export function captureResponseHeaderEvidence(response, rawHeaders, protocol) {
  let evidence = incomplete;
  if (
    ["1.0", "1.1", "2.0"].includes(protocol) &&
    Array.isArray(rawHeaders) &&
    Object.getPrototypeOf(rawHeaders) === Array.prototype
  ) {
    const length = Object.getOwnPropertyDescriptor(rawHeaders, "length")?.value;
    // HTTP/1 truncates at its public parser cap. Never accept a saturated prefix;
    // the smaller independent native cap also rejects every oversize prefix.
    if (
      Number.isInteger(length) &&
      length % 2 === 0 &&
      length <= NATIVE_HEADER_PAIR_LIMIT * 2 &&
      (protocol === "2.0" || length < HTTP1_HEADER_PAIR_LIMIT * 2) &&
      Reflect.ownKeys(rawHeaders).length === length + 1
    ) {
      const counts = Object.create(null);
      let valid = true,
        bytes = 0;
      for (let at = 0; at < length; at += 2) {
        const name = Object.getOwnPropertyDescriptor(rawHeaders, at),
          value = Object.getOwnPropertyDescriptor(rawHeaders, at + 1);
        if (
          !name?.enumerable ||
          !value?.enumerable ||
          !Object.hasOwn(name, "value") ||
          !Object.hasOwn(value, "value") ||
          typeof name.value !== "string" ||
          typeof value.value !== "string"
        ) {
          valid = false;
          break;
        }
        if (protocol === "2.0" && name.value === ":status") continue;
        if (
          !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name.value) ||
          (bytes += Buffer.byteLength(name.value)) > 65536
        ) {
          valid = false;
          break;
        }
        const key = name.value.toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
      }
      if (valid)
        evidence = Object.freeze({
          complete: true,
          pairs: length / 2,
          counts: Object.freeze(counts),
        });
    }
  }
  // Cookie completeness is separate: unsupported cookies must not downgrade
  // existing Header evidence or change the public compatibility parser.
  let cookieEvidence = incomplete;
  if (evidence.complete) {
    const values = Object.create(null);
    let bytes = 0,
      valid = true;
    for (let at = 0; at < rawHeaders.length; at += 2) {
      if (rawHeaders[at].toLowerCase() !== "set-cookie") continue;
      const line = rawHeaders[at + 1];
      if (!line.isWellFormed() || (bytes += Buffer.byteLength(line)) > 65536) {
        valid = false;
        break;
      }
      const pair = line.split(";", 1)[0],
        equals = pair.indexOf("=");
      const name = pair.slice(0, equals),
        value = pair.slice(equals + 1);
      if (
        equals < 1 ||
        !nativeCookieName(name) ||
        !value ||
        value.trim() !== value ||
        Object.hasOwn(values, name)
      ) {
        valid = false;
        break;
      }
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {}
      values[name] = decoded;
    }
    if (valid)
      cookieEvidence = Object.freeze({
        complete: true,
        values: Object.freeze(values),
      });
  }
  cookieEvidenceByResponse.set(response, cookieEvidence);
  evidenceByResponse.set(response, evidence);
  return response;
}

export function readResponseHeaderEvidence(response) {
  return evidenceByResponse.get(response) || incomplete;
}

export function readResponseCookieEvidence(response) {
  return cookieEvidenceByResponse.get(response) || incomplete;
}
