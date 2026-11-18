import { X509Certificate } from "node:crypto";
import { types } from "node:util";

const invalid = () => {
  throw Object.assign(Error("ORACLE_READ_TRUST_INVALID"), {
    code: "ORACLE_READ_TRUST_INVALID",
  });
};

// Operator option, never part of the user SQL/connection schema or persisted data.
export function validateOracleReadTrust(input, trust) {
  if (trust === undefined) return undefined;
  if (
    !trust ||
    types.isProxy(trust) ||
    Object.getPrototypeOf(trust) !== Object.prototype
  )
    invalid();
  const fields = ["host", "port", "database", "serverDN", "ca"];
  const keys = Reflect.ownKeys(trust);
  if (keys.length !== fields.length) invalid();
  const out = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(trust, key);
    if (!fields.includes(key) || !Object.hasOwn(d, "value")) invalid();
    out[key] = d.value;
  }
  for (const key of ["host", "database", "serverDN"])
    if (typeof out[key] !== "string" || out[key] !== input.connection[key])
      invalid();
  if (out.port !== (input.connection.port ?? 2484)) invalid();
  if (
    typeof out.ca !== "string" ||
    Buffer.byteLength(out.ca) > 16384 ||
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(
      out.ca,
    )
  )
    invalid();
  try {
    const certificate = new X509Certificate(out.ca);
    const now = Date.now();
    if (
      !certificate.ca ||
      !certificate.checkIssued(certificate) ||
      !certificate.verify(certificate.publicKey) ||
      !(
        certificate.validFromDate.getTime() <= now &&
        certificate.validToDate.getTime() > now
      )
    )
      invalid();
    out.ca = certificate.toString();
  } catch {
    invalid();
  }
  return out;
}
