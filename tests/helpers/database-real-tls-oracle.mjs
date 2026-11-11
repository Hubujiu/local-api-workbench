// Inspect diagnostics only in memory. Never print driver errors, configs, PEM,
// URLs, passwords, or HTTP response bodies, including on failed assertions.
function diagnostics(error) {
  const parts = [];
  const seen = new Set();
  for (
    let item = error;
    item && !seen.has(item) && seen.size < 5;
    item = item.cause
  ) {
    seen.add(item);
    parts.push(String(item.code || ""), String(item.message || ""));
  }
  return parts.join(" ").slice(0, 16384);
}
export function rejectionClass(error, expected, type, policy) {
  const text = diagnostics(error);
  if (
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|超时|timed?\s*out/i.test(
      text,
    )
  )
    return false;
  if (expected === "trust")
    return /SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|CERT_UNTRUSTED|self[- ]signed certificate|unable to verify.*certificate|unable to get.*issuer certificate/i.test(
      text,
    );
  if (expected === "hostname")
    return /ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match|IP.*not in.*cert|certificate.*(?:hostname|host name).*mismatch/i.test(
      text,
    );
  if (expected === "auth")
    return /28P01|ER_ACCESS_DENIED_ERROR|WRONGPASS|password authentication failed|access denied|invalid username-password|invalid password/i.test(
      text,
    );
  if (expected !== "plaintext") return false;
  // SQL policy errors are protocol-level refusals. EOF/reset is NOT evidence.
  if (type === "postgres")
    return (
      policy?.ssl === true &&
      policy?.hostnosslReject === true &&
      error?.code === "28000" &&
      /pg_hba.conf rejects connection|no pg_hba.conf entry/i.test(text) &&
      /no encryption|SSL off/i.test(text)
    );
  if (type === "mysql")
    return (
      policy?.requireSecureTransport === true &&
      error?.code === "ER_SECURE_TRANSPORT_REQUIRED" &&
      error?.errno === 3159
    );
  // Redis emits no SQL-style error on a TLS socket receiving plaintext. Its
  // close is only supporting evidence after live CONFIG GET proves port=0 and
  // tls-port=6379; a healthy authenticated TLS read is checked by the caller.
  if (type === "redis")
    return (
      policy?.port === 0 &&
      policy?.tlsPort === 6379 &&
      /ECONNRESET|EPIPE|socket.*closed|connection.*closed|连接.*关闭|unexpected.*end/i.test(
        text,
      )
    );
  return false;
}
