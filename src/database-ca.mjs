import { X509Certificate } from "node:crypto";

export function databaseCertificates(ca, message) {
  const invalid = () => Error(message);
  if (
    ca !== undefined &&
    (typeof ca !== "string" || Buffer.byteLength(ca) > 65536)
  )
    throw invalid();
  // The existing editor sends an empty CA field for default trust/no TLS.
  if (ca === undefined || ca === "") return [];
  const certificates =
    /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\t \r\n]+)-----END CERTIFICATE-----/g;
  const whitespace = /^[\t \r\n]*$/;
  let cursor = 0;
  const result = [];
  for (const match of ca.matchAll(certificates)) {
    if (!whitespace.test(ca.slice(cursor, match.index))) throw invalid();
    const encoded = match[1].replace(/[\t \r\n]/g, "");
    const der = Buffer.from(encoded, "base64");
    if (!encoded || der.toString("base64") !== encoded) throw invalid();
    try {
      // OpenSSL can silently ignore junk PEM blocks and trailing DER bytes.
      // Parse each certificate independently and require the complete bytes.
      if (!new X509Certificate(der).raw.equals(der)) throw invalid();
    } catch {
      throw invalid();
    }
    cursor = match.index + match[0].length;
    result.push(match[0]);
  }
  if (!result.length || !whitespace.test(ca.slice(cursor))) throw invalid();
  return result;
}
