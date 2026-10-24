# OAuth1 request signing

Official capability reference: https://v7-wiki.apipost.cn/docs/11/ lists OAuth1, Hawk, AWS, NTLM beta and EdgeGrid as well as Basic/Bearer/Digest. This is a supplemental historical online-product reference, not proof that every type exists in the current offline build.

This pass implements existing-credential OAuth1 request signing using HMAC-SHA1 or HMAC-SHA256. It does not implement automated OAuth1 browser grants, RSA/PLAINTEXT, Hawk, AWS, NTLM or EdgeGrid.

- Sign the final method/URL/query and serialized x-www-form-urlencoded body; preserve duplicate ordinary parameters and empty values.
- RFC5849 percent-encoding, byte order and Host/base-URI rules. Generated protocol fields use the Authorization header; conflicting OAuth fields in Query/Body fail explicitly.
- Nonce/timestamp are regenerated unless explicitly supplied for testing. Use HTTPS; signatures do not encrypt request data.
- Postman OAuth1 imports retain relevant fields. cURL export fails explicitly instead of silently producing an unsigned request.
- Fixed reference: RFC5849 section1.2 protected-photo signature and section3.4.1.3.2 normalization. A local HTTP fixture checks the signed final outgoing request; no user credentials or third-party accounts are used.
- Reference: https://www.rfc-editor.org/rfc/rfc5849.html
