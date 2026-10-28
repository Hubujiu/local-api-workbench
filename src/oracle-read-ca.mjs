import { X509Certificate } from "node:crypto";

const MAX_CA_PEM_BYTES = 16 * 1024;
const invalidCA = () =>
  Error("Oracle WIP CA certificate is invalid or unsupported");

// Pure parsing only. No file lookup, driver option, TLS context, or trust-store
// mutation occurs here. The time seam is internal, never a connection field.
export function oracleReadCACertificate(value, { now = Date.now() } = {}) {
  if (arguments.length === 0) return undefined;
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > MAX_CA_PEM_BYTES ||
    /[^\x00-\x7f]/.test(value) ||
    typeof now !== "number" ||
    !Number.isFinite(now)
  )
    throw invalidCA();

  const lines = value.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (
    lines.length < 3 ||
    lines.shift() !== "-----BEGIN CERTIFICATE-----" ||
    lines.pop() !== "-----END CERTIFICATE-----" ||
    lines.some((line) => !/^[A-Za-z0-9+/]+={0,2}$/.test(line))
  )
    throw invalidCA();

  const base64 = lines.join("");
  const der = Buffer.from(base64, "base64");
  // Buffer decoding alone accepts ignored characters, omitted padding, and
  // nonzero unused bits. Re-encoding requires one canonical base64 payload.
  if (!der.length || der.toString("base64") !== base64) throw invalidCA();
  try {
    const certificate = new X509Certificate(der);
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (
      !certificate.raw.equals(der) ||
      certificate.ca !== true ||
      !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) ||
      validFrom > now ||
      validTo < now
    )
      throw invalidCA();
    // Comparing raw DER above also rejects data following the first parsed
    // certificate. The canonical output is independent of input line wrapping.
    const canonical = certificate.toString();
    if (Buffer.byteLength(canonical) > MAX_CA_PEM_BYTES) throw invalidCA();
    return canonical;
  } catch {
    // Parser diagnostics must not echo caller-provided material.
    throw invalidCA();
  }
}
