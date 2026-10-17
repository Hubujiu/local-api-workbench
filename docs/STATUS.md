# Delivery candidate checkpoint — 2026-10-17 13:48 UTC

Private repository: https://github.com/Hubujiu/local-api-workbench  
Persistent draft PR: https://github.com/Hubujiu/local-api-workbench/pull/1  
Main unchanged: 5af2f63913e097efd6fb3325103bd5fd2ee0f6a1. No deployment.

## Last verified remote candidate
03b426bea4eed8c2f8a8318357436d7c5b6718c7 passed all seven jobs in run 39036849008, including the packaged Windows executable, browser videos/screenshots, three-platform core, real database fixtures and dependency audit.

## Current candidate changes
- Adopt verified root/desktop lockfiles and npm ci, production-only desktop dependencies.
- Recover provably orphaned disk locks without overriding a live or unknown owner.
- Preserve current configuration separately from background history revisions.
- Clear stale response display on imports/duplicate/close/delete; add UI regression.
- Bash cURL auth/body/quoting and environment resolution, explicit unsupported binary/certificate errors.
- Clean delivery matrix and known limitations.

Current local suite: 63 passed, zero failed/skipped; syntax and strict formatting pass. This candidate still requires its own exact-head CI and artifact verification.

## Historical issue
Old run 39036358462 has a hung Windows test and failed an earlier dependency audit. The owner was asked once to cancel it because the connector cannot cancel runs. This old run is not green. Updated mysql2/yaml and bounded desktop cleanup passed later run 39036849008. New jobs have ten-minute timeout and concurrency cancellation.

## Scope and trust
See DELIVERY.md for implemented capabilities, fixed test mapping and limitations. Public screenshot/document parity is not a certificate of undocumented proprietary behavior or pixel-perfect identity. Root implemented the task without delegation or saved cloud coding environments.
