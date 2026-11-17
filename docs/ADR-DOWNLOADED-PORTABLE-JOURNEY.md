# Downloaded portable launch acceptance

The existing desktop job runs the packaged executable before upload. The downloaded-portable job verifies bytes and candidate identity after download, but those checks alone do not prove that the downloaded distribution launches. This change adds the missing execution boundary; it does not build another package.

## Flow

1. Download only this workflow run's successful platform artifact.
2. Retain the existing complete inventory, manifest, exact head and hash verification.
3. Materialize into a new, job-owned directory. Linux/macOS tar entries are bounded and individually copied, not extracted with an unrestricted archive API. Write regular files before safe links, preserve ordinary executable modes, reject special permissions and an existing destination, then verify the materialized tree again. Windows copies the already downloaded directory, rejects reparse points and verifies the copy.
4. Launch the materialized executable with the existing Playwright Electron restart journey, once for clean shutdown/restart and once for crash recovery. The runner uses an explicit absolute package root; it cannot fall back to the build directory when that root is supplied.
5. Preserve screenshots/traces as a separate downloaded-portable journey artifact, including on failure. Success markers are emitted only after the complete existing journey, exit receipts and no-replay assertions pass.

The fixture uses isolated temporary application data and a loopback peer. The download is quiescent, and its destination parent is controlled by the job. This is not protection against a hostile concurrent filesystem writer. Hash manifests establish transfer consistency, not publisher authenticity; the input is the artifact of this authorized build.

No production behavior, resource budget, deadline or assertion is relaxed. The ten-minute download-job bound is unchanged. Source dependencies are test-harness dependencies only: no desktop rebuild or Electron install occurs in this job, and the program under test is solely the downloaded executable. This does not verify OS signing, notarization, installers, an external release channel or all customer machine configurations.

Local unit and fixture tests are separate from actual platform execution. All three new download execution paths require the exact-head CI result before being called accepted. Earlier failed or canceled CI is retained and is not changed by a later pass.
