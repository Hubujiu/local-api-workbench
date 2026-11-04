// Postman OAuth1 import conversion, isolated for dependency-free contract tests.
export function importPostmanOAuth1(attributes) {
  const values = Object.fromEntries(
    (attributes || []).map((item) => [item.key, item.value]),
  );
  return {
    type: "oauth1",
    ...Object.fromEntries(
      [
        "consumerKey",
        "consumerSecret",
        "accessToken",
        "tokenSecret",
        "signatureMethod",
        "privateKey",
        "privateKeyPassphrase",
        "nonce",
        "timestamp",
        "realm",
        "version",
        "callback",
        "verifier",
      ]
        .filter((key) => values[key] !== undefined)
        .map((key) => [key, values[key]]),
    ),
  };
}
