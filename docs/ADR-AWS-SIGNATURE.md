# AWS Signature V4

Uses pinned @smithy/signature-v4 5.7.4, the official Smithy signer, with a Node SHA256/HMAC adapter. The signer receives only explicitly provided credentials, service and region. No environment/provider-chain/profile/metadata-service discovery or automatic AWS login runs.

The final wire URL/query and serialized payload are signed. Duplicate query values are retained; payload SHA256 is recomputed, and temporary session tokens are supported. S3 uses its no-extra-path-escaping rule. User-supplied signingDate is a test option; normal requests use current time.

This is request signing only, not SigV4a, streaming chunk signatures, presigned URL generation or automatic role/credential refresh. cURL export fails explicitly until equivalent signing export exists. Postman awsv4 import retains explicit fields.

Validation uses published Smithy fixed-date request and session-token signatures, binary payload/duplicate-query checks, and actual local HTTP/browser requests. No AWS account or live cloud resource is contacted.

Sources:
- https://github.com/smithy-lang/smithy-typescript/tree/main/packages/signature-v4
- https://raw.githubusercontent.com/smithy-lang/smithy-typescript/main/packages/signature-v4/src/SignatureV4.spec.ts
- https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html
