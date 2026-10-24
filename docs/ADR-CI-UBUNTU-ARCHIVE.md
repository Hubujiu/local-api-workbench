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

The first narrowly scoped deb822 rewrite reported no changes while APT continued
using Azure. The helper now also recognizes legacy deb/deb-src source entries and
mirror+file URL-list files. It scans only the standard APT source/mirror directories,
preserves comments and source options, logs changed filenames without dumping
source contents, and refuses unrecognized remaining active Azure entries. This
addresses a no-op configuration path, rather than treating a successful helper
exit as evidence that the download route changed.
