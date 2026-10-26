// Identity, not serialized response fields, carries transport authority. Neither
// imported records nor sandbox-created response objects can mint this evidence.
const evidenceByResponse = new WeakMap();
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
  evidenceByResponse.set(response, evidence);
  return response;
}

export function readResponseHeaderEvidence(response) {
  return evidenceByResponse.get(response) || incomplete;
}
