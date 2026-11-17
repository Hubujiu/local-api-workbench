# Hawk and EdgeGrid request signing

## Hawk
Uses pinned Mozilla hawk9.0.2. SHA256 is the default; SHA1 is supported for protocol compatibility. Signs the actual URL/Host and optional serialized payload hash, with explicit id/key plus nonce/timestamp/ext/app/dlg. Empty nonce/timestamp generate per-request values. No network clock sync or account login occurs. Server-Authorization response validation is not implemented.
Postman Hawk import translates authId/authKey/extraData/delegation and preserves includePayloadHash. The nonstandard Postman user extension is rejected.

Independent fixtures match Mozilla's documented GET and POST/payload MACs. A real local server authenticates the outgoing MAC and payload, rather than merely checking a prefix.

## EdgeGrid
A small Node-crypto protocol implementation follows Akamai's canonical fields and is tested against the official Python SDK's fixed JSON signature. It does not load .edgerc, environment credentials or Akamai's network client.
Only POST includes the content hash. Hashing defaults to the first131072bytes, optionally configured within1–8MiB; this never truncates the actual transmitted body. Header names are ordered, case-insensitive and whitespace-normalized. Tokens reject header separators/control characters. Explicit baseURL may override the signed host as in Postman's authorizer; it does not change the network destination.
Nonce/timestamp default to fresh values. Requests use EG1-HMAC-SHA256; no automatic account login or redirect reauthorization is provided.

Both support their explicit authentication editors and Postman import. cURL generation rejects these signed types rather than dropping authentication. Prefer HTTPS. Local fixtures contain public/example credentials only.

Sources:
- https://github.com/mozilla/hawk/blob/main/API.md
- https://github.com/postmanlabs/postman-runtime/blob/9c2d10d4733aed92cf3a5d14279b03661effdbe2/lib/authorizer/hawk.js
- https://github.com/akamai/AkamaiOPEN-edgegrid-python/blob/42640cbf8386736a90a1b8791bbe93d523b8256a/akamai/edgegrid/edgegrid.py
- https://github.com/akamai/AkamaiOPEN-edgegrid-python/blob/42640cbf8386736a90a1b8791bbe93d523b8256a/akamai/edgegrid/test/testdata.json
- https://github.com/postmanlabs/postman-runtime/blob/9c2d10d4733aed92cf3a5d14279b03661effdbe2/lib/authorizer/edgegrid.js
