// An editor projection, not a transport serializer: the definition URL is
// always the effective URL already used by the HTTP runtime and code/export.
export function literalQueryEffectiveURL(
  effectiveURL,
  rows,
  includeDisabled = false,
) {
  const hash = effectiveURL.indexOf("#");
  const base = hash < 0 ? effectiveURL : effectiveURL.slice(0, hash);
  const fragment = hash < 0 ? "" : effectiveURL.slice(hash);
  const at = base.indexOf("?");
  const prefix = at < 0 ? base : base.slice(0, at);
  const enabled = rows.filter(({ enabled }) => enabled || includeDisabled);
  return (
    prefix +
    (enabled.length ? "?" + enabled.map(({ token }) => token).join("&") : "") +
    fragment
  );
}
