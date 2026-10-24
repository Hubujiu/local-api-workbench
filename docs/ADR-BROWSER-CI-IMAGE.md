# Reproducible browser CI dependencies

## Problem

Browser jobs can consume their ten-minute budget installing Ubuntu browser
dependencies before any application test executes. The URI-rewrite helper did
not establish a reliable fix: an observed job reported no changed source files
but still downloaded packages from the Azure Ubuntu mirror.

## Decision

Run the existing browser job in Microsoft's official Playwright Noble image,
pinned to version 1.64.1 and its OCI index digest. Install the matching npm
Playwright package separately, as required by the image. Node remains version 24. The image includes browser binaries and system libraries, so this job no
longer runs apt or downloads browsers during each test run.

Keep the HTTP/2 cURL integration suite, complete UI smoke suite, evidence
artifacts, read-only repository permissions and ten-minute job limit. Do not
add privileged containers, capabilities, security-profile overrides or host
IPC. Allocate container-local shared memory rather than sharing host IPC.
Browser launch flags are unchanged. This image is used only for the existing
trusted local application test fixtures, not for browsing arbitrary websites.

The official registry returned the pinned digest for the named version. A
configuration test checks image/package version alignment and retention of
the verification gates. Only a completed real browser CI run establishes that
the image is suitable; the configuration test alone does not prove that.

Reference: https://playwright.dev/docs/docker
