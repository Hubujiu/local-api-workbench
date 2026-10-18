# Bounded script libraries

Reference research read (did not execute or install) the official apipost-runtime2.0.5 npm distribution, which exposes CryptoJS/Chai and numerous host capabilities. Its legacy VM/dependency stack is not imported wholesale.

Pinned CryptoJS4.2.0 and Chai6.3.0 are bundled as pure JavaScript inside each independent QuickJS VM. Build-only packages are audited by the full root npm audit and reproducibly rebuilt in CI; the packaged runtime includes the generated bundle and original license notices.

- CryptoJS is available as a global or require("crypto-js"); Chai as chai/require("chai"), with pm.expect/apt.expect and pm.test/apt.test.
- require is an allowlist for these two in-VM libraries. fs, network, worker_threads, child_process and Node crypto modules remain inaccessible.
- A single host primitive supplies at most65536secure random bytes per call. Integer typed arrays can consume it; the host function does not expose Node objects.
- Chai's plugin event API receives a minimal in-VM Event/EventTarget implementation, not a DOM or browser.
- Trusted bundle initialization has a1second interrupt budget. User-defined functions and user code share the original250ms wall-clock budget, with16MiB VM memory and the existing2second outer worker deadline.
- Expensive crypto operations can hit these limits; no unlimited work or host process execution is added.
- CryptoJS is discontinued upstream. It is included for compatibility with existing API scripts, not recommended for new cryptographic application design. Legacy MD5/SHA1/DES APIs do not make those algorithms suitable for modern password storage or signatures.

Validation includes fixed SHA256/HMAC/AES vectors, salted encryption/decryption, Chai deep/property/failing assertions, randomness quotas, blocked host module names and constructor-escape checks. Three native desktop packages execute a real CryptoJS/Chai script to prove the prebuilt asset is included.

Sources:
- https://www.npmjs.com/package/apipost-runtime
- https://cryptojs.gitbook.io/docs
- https://www.chaijs.com/api/bdd/
