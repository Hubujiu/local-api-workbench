# OAuth1 RSA-SHA1 compatibility

This adds explicit legacy-service compatibility, not a recommendation for new authentication systems. The default remains HMAC-SHA1. RSA uses RFC5849 section3.4.3: SHA-1 with RSASSA-PKCS1-v1_5, the existing normalized OAuth base string, and base64-encoded signature in Authorization.

- Only a manually supplied inline RSA private PEM or an explicitly resolved variable is accepted, maximum32KiB. No key path, OS keychain, credential discovery, token acquisition or public-key registration is performed.
- PKCS1/PKCS8 and encrypted PKCS8 PEM are accepted through Node crypto, with optional privateKeyPassphrase. Non-RSA and RSA-PSS-only keys fail. Parsing/signing errors are generic and do not expose key data.
- Consumer/token shared secrets are not included in RSA signing. Private key/password never enter the Authorization header. As with existing credentials, saving the request/step persists its fields in local project files; UI warns not to commit real credentials to Git. This is not encrypted secret storage.
- Main and step authentication editors expose the same fields; Postman OAuth1 import preserves explicitly provided privateKey/privateKeyPassphrase. cURL remains rejected for dynamic OAuth signatures.
- Tests use only the already-public localhost fixture key. A committed golden signature was computed with OpenSSL3.5.7 separately from the implementation; a real HTTP fixture verifies the received normalized query/form signature, plus encrypted/wrong-key/size cases. Browser testing exercises selection, PEM entry and actual request execution.

Reference: https://www.rfc-editor.org/rfc/rfc5849#section-3.4.3
