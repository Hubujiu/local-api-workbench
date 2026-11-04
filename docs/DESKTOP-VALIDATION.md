# Native desktop validation

## Current audited candidate: 2026-11-04

This document refers to integration commit [`f11e4bbcb9d2b707a35893693ab6c8852a858847`](https://github.com/Hubujiu/local-api-workbench/commit/f11e4bbcb9d2b707a35893693ab6c8852a858847), tree `16d200c52772e4017ca8cfff778c0ecdb3bb3d3e`, and successful push run [41774839917](https://github.com/Hubujiu/local-api-workbench/actions/runs/41774839917) (attempt 1). It does not assert that the branch containing this document, a feature PR, or a later docs-only commit contains the same application tree. A green Node core job or an older desktop run cannot substitute for this exact candidate.

The three desktop jobs checked out that commit, used the same `BUILD_HEAD`, built production-only packages, ran packaged Electron smoke and shutdown scenarios, verified the complete staging manifest, then uploaded portable artifacts. The separate production-only official SDK stdio smoke uses CI Node against an application copy outside the checkout; it is not proof of MCP startup inside Electron's embedded runtime.

Actual downloaded ZIPs were audited read-only after upload. Their SHA256 values match GitHub's artifact digests; metadata, outer and packaged manifests match byte-for-byte. The complete package file hashes and symlink graphs match the manifests: Windows 9866 files/0 links, macOS 10056/19, Linux 9855/5. All 429 copied application source files per package were compared with the exact tree: macOS/Linux match raw bytes; 390 Windows files differ only by CRLF checkout endings, with all remaining files byte-identical. Executable headers independently confirm Windows x64, macOS arm64 and Linux x64; the macOS/Linux executable modes are 0755. No downloaded executable was launched during this audit.

Exact artifact links, ZIP and manifest hashes, expiration times and upgrade instructions are in [the current delivery section](DELIVERY.md#当前包下载与校验). These Actions artifacts have a 7-day retention period, expiring on 2026-11-11 around 04:44 UTC. They are portable candidates, not permanent release assets.

## What the desktop jobs cover

- Packaged local HTTP/Mock and isolated QuickJS script execution, XML/XPath and packaged utility libraries.
- Persistence, authentication fixtures, SQLite read/explicit-write paths and timeout recovery under the existing budgets.
- A separate shutdown smoke covers owned TCP/WebSocket/SSE sessions, cancelled exit, confirmed persistence, restart without replay, peer-project isolation and an explicit unconfirmed-save exit.
- Electron uses the packaged executable with temporary data. Linux runs under Xvfb; the workflow does not disable the application's sandbox or browser security controls.

The matrix is Windows, macOS and Ubuntu22.04 on the architectures recorded above, not every architecture offered by Electron or every supported OS release. It does not establish the original application's full GUI workflow, pixel parity, all external MCP clients or clean-machine acceptance on the user's target system. This delivery work does not expand frontend scope.

## Packaging and distribution boundaries

Windows requires the entire extracted directory, not only `LocalAPI.exe`. macOS/Linux use an inner tar.gz to preserve executable bits and framework symlinks. Before upgrading, back up projects, exit the old app and backend, verify those processes have stopped, and unpack to a separate directory. A second instance may only activate the existing window; that is not evidence that the new package started. Do not replace running files or point old and new processes at the same data directory. Prefer a separate data directory for first acceptance.

Manifest verification recomputes file SHA256 and symlink targets. It does not authenticate `head`/platform/architecture, compare executable modes or certify a publisher; those were separately checked for the downloaded candidate above. A manifest PASS alone is not proof of source identity, signing or complete compatibility.

macOS uses `codesign --sign -` for a CI ad-hoc signature only. It is not an Apple Developer ID signature or notarization. Windows production signing is also not complete. No production distribution approval, installer, store release or deployment is claimed. If the OS blocks the candidate, do not bypass its security warning. Formal signing/notarization and stable distribution need their own authorized process.

## Historical result, retained without reclassification

First native result: all three desktop jobs passed on9b9f60c / Actions39095503517. Windows core separately failed a path-separator unit assertion; the correction must pass a new full matrix before claiming the overall commit green. No notarized/signed public distribution is implied.

That early failure remains historical evidence; the current candidate's success does not retroactively mark it green or explain unrelated historical XML/runtime failures. See [retained failures and limits](DELIVERY.md#历史失败与证据边界).
