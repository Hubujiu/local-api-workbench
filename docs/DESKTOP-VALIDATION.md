# Native desktop validation

The desktop CI matrix now builds on Windows, macOS and Ubuntu22.04, then launches the packaged executable through the same observable smoke scenario:
- real local HTTP/Mock response;
- isolated QuickJS script output;
- namespaced XML/XPath extraction using packaged dependencies;
- project persistence and read-only SQLite fixture.

A green Node core job is not a substitute for a green desktop job. Each package has a platform/architecture/head/checksum manifest. Non-Windows downloads use tar.gz to preserve executable bits and framework symlinks.

macOS currently uses an ad-hoc build signature for CI only. This is not an Apple Developer ID signature or notarization, and no production distribution approval is claimed. Linux keeps sandboxing enabled and runs its UI under Xvfb; the workflow does not disable kernel or browser security controls.

Windows artifact names now include the platform consistently: LocalAPI-Windows-portable, LocalAPI-macOS-portable and LocalAPI-Linux-portable. Supported architecture is the actual runner architecture recorded in each manifest, not every architecture offered by Electron.

Current status: implementation added, first native Mac/Linux CI result pending. Do not mark cross-platform desktop parity complete until those actual jobs pass.
