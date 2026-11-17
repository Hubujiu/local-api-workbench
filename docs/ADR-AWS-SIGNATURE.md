# AWS Signature V4

Uses pinned @smithy/signature-v4 5.7.4, the official Smithy signer, with a Node SHA256/HMAC adapter. The signer receives only explicitly provided credentials, service and region. No environment/provider-chain/profile/metadata-service discovery or automatic AWS login runs.

The final wire URL/query and serialized payload are signed. Duplicate query values are retained; payload SHA256 is recomputed, and temporary session tokens are supported. S3 uses its no-extra-path-escaping rule. User-supplied signingDate is a test option; normal requests use current time.

This is request signing only, not SigV4a, streaming chunk signatures, presigned URL generation or automatic role/credential refresh. cURL export fails explicitly until equivalent signing export exists. Postman awsv4 import retains explicit fields.

Validation uses published Smithy fixed-date request and session-token signatures, binary payload/duplicate-query checks, and actual local HTTP/browser requests. No AWS account or live cloud resource is contacted.

Sources:

- https://github.com/smithy-lang/smithy-typescript/tree/main/packages/signature-v4
- https://raw.githubusercontent.com/smithy-lang/smithy-typescript/main/packages/signature-v4/src/SignatureV4.spec.ts
- https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html

## Repeated ordinary headers

The AWS canonical request guidance specifies trimming boundary whitespace,
collapsing sequential whitespace and joining multi-value headers with commas:
https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html

Repeated enabled ordinary request rows now retain their order and produce one
normalized comma-joined wire field for SigV4. The exact merged field is both
signed and sent, including HTTP/2, avoiding a transport-specific comma/space
rewrite after signing. Stored request rows remain unchanged. Single-valued
headers retain the prior wire handling. The authentication panel explicitly
explains the merge; this is not a promise of separate repeated raw wire lines.

Framing/authentication singleton protections remain. Repeated Cookie/Set-Cookie
are rejected rather than applying comma-list semantics to cookies. Repeated
x-amz-date, x-amz-security-token and x-amz-content-sha256 are also rejected before
traffic; the signer still owns its generated date/token/payload-hash values.
EdgeGrid repeated headers remain unverified and rejected. No credential provider,
network access, certificate policy or execution limit is broadened.

Fixed tests use an independent HMAC derivation from actual received HTTP/1 and
HTTP/2 headers/payload, without calling the production signer for verification.
They check ordered whitespace normalization, disabled-row omission, signed
payload hash and unchanged source requests. Existing published Smithy vectors
are unchanged. Browser CI edits two duplicate rows, sends them and checks the
actual fixture's echoed merged field, then removes the temporary rows. No AWS
account or public resource is contacted.

Screenshot review found that the first AWS browser fixture reused a tab with a
response-specific asynchronous post-script from an earlier scenario. The wire
header and signature checks succeeded but the overall script outcome was failed.
The authentication fixture now saves, clears and later restores those unrelated
scripts, and explicitly requires a passed outcome with no error in addition to
its wire-header assertions. This isolates the intended acceptance case rather
than suppressing an application error or relaxing script failure behavior.
