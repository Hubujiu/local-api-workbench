# Keep browser CI within its existing budget

Hosted-runner downloads from azure.archive.ubuntu.com repeatedly stalled during
Playwright dependency installation. One attempt completed UI_SMOKE_PASS and the
evidence upload but was still cancelled at the ten-minute job deadline; a retry
stalled in repository downloads. This is an infrastructure failure, not a pass.

The browser job uses the canonical HTTPS Ubuntu archive for exact Azure Ubuntu
URI entries in the ephemeral runner's deb822 ubuntu.sources file. Suites,
components, Signed-By/keyrings, package verification, third-party sources and
security-update suites are unchanged. No verification bypass, repository trust
expansion, alternate signing key, test removal or timeout increase is introduced.
The script refuses standalone execution outside GitHub Actions. Its pure rewrite
function is tested against preserved signatures/comments and lookalike domains.

Reference for the Ubuntu sources-file format and package workflow:
https://ubuntu.com/server/docs/how-to/software/package-management/
