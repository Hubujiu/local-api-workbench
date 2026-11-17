# Official-converter fixture provenance

apipost-converter-0.1.89.json is the unedited result of the official swagger2apipost0.1.89 npm converter, run locally against apipost-converter-input.json on2026-10-18. The input is our own synthetic Swagger fixture and contains no real service, account or secret. The converter was installed only in a temporary research directory; its legacy dependencies are not shipped or installed by CI.

The fixture intentionally retains the converter's actual scheme-less URL and response sample, so the adapter is tested against real output rather than a hand-shaped expected schema. The local product explicitly warns before sending a URL for which HTTPS had to be assumed.

Reference: https://www.npmjs.com/package/swagger2apipost
Repository declared by package: https://github.com/Apipost-Team/swagger2apipost
