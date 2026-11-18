# Opt-in installed product upgrade journey

This is a separate, **not yet natively executed** product harness. The inert MSI
transaction test remains the rollback/failure oracle; passing it does not mean
this application journey passed. No workflow automatically executes this harness.

## Prerequisites and trust

Use a disposable Windows runner/VM, never a personal Windows installation. Install
Node 24+, PowerShell 7 (`pwsh.exe`) and the repository's locked Playwright dependency
there. No browser download is needed: Playwright launches the installed Electron.
Do not run arbitrary downloaded MSI packages. Independently verify build provenance,
review the source, and supply trusted MSI **and build-input receipt** SHA-256 values.
Unsigned packages are explicitly expected only in that disposable environment.

Build two real, unpacked Windows product packages with
`prepare_windows_lifecycle_msi.py` and its compile mode. Both must share one freshly
generated UUID v4 `--fixture-family`, and the newer product must have a genuinely
higher `package.json` version consistent with its manifest and MSI. Do not merely
relabel identical release metadata. The generator verifies the package's inventory
before authoring. Its isolated namespace avoids the historical installer product.
Keep each build's extracted payload for bundle verification.

Bundle the two build directories (on the authoring machine):

```sh
python scripts/prepare_installed_product_journey.py \
  --old /verified/old-build --new /verified/new-build \
  --old-digest OLD_MSI_SHA256 --new-digest NEW_MSI_SHA256 \
  --old-receipt-digest OLD_BUILD_INPUT_SHA256 \
  --new-receipt-digest NEW_BUILD_INPUT_SHA256 \
  --output /fresh/product-bundle
```

Transfer the resulting bundle to the disposable runner. Pin its reported
`planSha256` independently of the transferred file, then run from the reviewed
repository checkout:

```powershell
node tests/desktop-installed-product-journey.mjs --plan C:\fixture\product-plan.json --expected-plan-sha256 PLAN_SHA256 --execute-in-disposable-windows
```

## What the implementation asserts

- Plan/package/receipt hashes, independent version ordering, shared isolated
  upgrade family and distinct product codes. Refuse existing target, aliases,
  junctions, symlinks, wrong OS, or missing explicit opt-in.
- Use supported native MSI API to require both versions absent before installation,
  exact current-user unmanaged installed version after installation/upgrade,
  superseded version absent, and all queried contexts absent after uninstall.
- Hash every installed program file before launch. Verify the live Electron
  process path, app path, actual app version, and synthetic user-data path.
- Execute the existing UI restart journey with a synthetic HTTP peer and SQLite
  fixture. Replace its restart with a real old-to-new MSI upgrade. Verify persisted
  requests, environment/database settings, original execution history and backup
  restore through the existing UI assertions. Require fresh process/session token,
  reject the prior token, and prohibit replaying traffic during upgrade/reinstall.
- Save complete native project exports/history, uninstall, retain byte-identical
  synthetic profile plus foreign program-directory sentinel, reinstall, and
  compare complete exports/history again. Final uninstall removes all owned files;
  empty directories are allowed. MSI operations cannot change the profile bytes.

The evidence directory is printed before installation. It retains MSI logs,
registration receipts, screenshots/traces, exported synthetic projects, result JSON,
and synthetic profile. Traces contain test-only session tokens; do not publish them
as real user data. The harness never recursively deletes an installed directory.
It renames the retained foreign-sentinel directory before reinstall. If anything
fails, it stops without retrying MSI, uninstalling uncertain state, or guessing at
cleanup; owned test Electron processes are stopped and errors recorded. An MSI
120-second timeout leaves service state explicitly uncertain for runner disposal.

## Limits / acceptance still outstanding

No native product execution is claimed by local contract tests. A real pair of
verified Windows product builds with distinct actual versions is required; a
single current 0.1.0 package cannot establish a genuine version upgrade. No hosted
product job is wired yet. Code signing, ICE validation, standard-user-token
acceptance, locked-file/concurrent installer races, data migration compatibility,
and product-level injected failure recovery remain separate gates. This harness
never sets signature/ICE success. Native rollback is covered only by the separate
inert transaction harness until a product-specific failure scenario is implemented.

## Hosted opt-in derivative

`windows-product-journey.yml` provides three disposable jobs: Windows builds the
new portable from the exact same-repository PR head; Linux verifies the pinned old
artifacts and compiles a fresh same-family MSI pair; Windows runs this harness.
It never publishes releases/tags/packages and has read-only repository credentials.
The baseline is fixed in `packaging/windows-msi/windows-baseline-lock.json`: source
`f59b11ac3dc96c567db155dd871ef08ba445937c`, run `44130790449`, portable artifact
`14350955078`, independent metadata artifact `14349438597`, all pinned SHA-256.
Expired/unavailable or mismatching baseline artifacts fail closed, never fall back
to another release. New payload integrity is pinned to the producing job's manifest
hash; bundle integrity is pinned to the Linux job's plan hash independently of the
transferred artifact. Downloaded MSI code never executes in the authoring job.

Prerequisites: the PR must include the source-bound desktop version fix from #276,
and a **committed test-only 0.1.1** version in root and desktop package/lock metadata.
The workflow refuses 0.1.0 or inconsistent metadata. It does not stamp versions or
claim an uncommitted tree matches a commit. Incorporate actual newer source changes;
a version-only bump does not establish meaningful product compatibility coverage.
For a same-repository PR, explicitly apply the `run-windows-product-journey` label.
Fork PRs never run this workflow. Manual dispatch is also supported once the workflow
is available for dispatch. This gate is separate from the tiny inert rollback gate.

Playwright is pinned by the independent tooling lock; local native runners must run
`npm ci --ignore-scripts --prefix packaging/windows-msi/journey-tools` first. No
browser downloads are required. GitHub-hosted Windows may run with an administrator
token: `product-runner-context.json` records the token classification and explicitly
sets standard-user acceptance false. Evidence artifacts are retained for three days.
A hosted successful run would establish only the assertions in this journey, not
signature, ICE, injected product rollback, or standard-user acceptance.
