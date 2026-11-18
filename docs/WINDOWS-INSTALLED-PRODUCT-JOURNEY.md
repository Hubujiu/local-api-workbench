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
420-second timeout leaves service state explicitly uncertain for runner disposal.

## Limits / acceptance still outstanding

No native product execution is claimed by local contract tests. A real pair of
verified Windows product builds with distinct actual versions is required; a
single current 0.1.0 package cannot establish a genuine version upgrade. No hosted
product job is wired yet. Code signing, ICE validation, standard-user-token
acceptance, locked-file/concurrent installer races, data migration compatibility,
and product-level injected failure recovery remain separate gates. This harness
never sets signature/ICE success. Native rollback acceptance remains proven only for the separate inert transaction
harness until the optional full-product rollback scenario below passes natively.

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

### First hosted product run and bounded timing correction

Run `44230439530`, native job `134559218749`, failed the old 120-second
harness deadline during upgrade, not a verified MSI error. Its SHA-256-verified
evidence artifact `14395148631` (`3d6fca933847b06abc98db9f78fb4c8e11e03b21243e741bf5b9c08070f224bb`)
shows the first real 18,144-file install completed in about 96 seconds. The
upgrade's nested old-product removal lasted about 85 seconds, successfully
finished `RemoveExistingProducts` at 03:45:18Z, and began new `InstallFinalize`
at 03:45:27Z. The harness expired at 03:45:33Z while file-copy operations continued
through the captured log's 03:45:35Z endpoint. Upgrade completion was not observed.

Each full-product MSI operation now has a fixed seven-minute wall-clock deadline
within a bounded native job limit. It is not extended by log activity.
The receipt records start/end/elapsed time, operation, exit status or uncertain
timeout, and log byte count. All registration, payload/profile/hash, GUI and export
assertions remain unchanged. Timeout still aborts without retry, kill, uninstall,
or cleanup of uncertain MSI service state. This correction requires a new clean
hosted run; it does not turn the failed run into acceptance.

## Optional real-product rollback probe (not yet natively verified)

The default MSI generator and two normal installers do not contain a failure action.
Old plans and default product runs remain compatible and do not execute this probe.
To opt in on a same-repository PR, keep `run-windows-product-journey` and additionally
apply `run-windows-product-rollback`. For manual dispatch choose `exercise_rollback`.
The Linux job then creates a separately named **TEST-ONLY-ROLLBACK-FAILURE.msi** under
`faults/`; only the native runner's explicit `--exercise-product-rollback` argument
permits its execution. A requested rollback test with no pinned fault fixture fails
before installation. Do not distribute the test-only MSI as a product installer.

For a locally prepared trusted bundle, the equivalent authoring command is:

```sh
python scripts/prepare_product_rollback_fixture.py \
  --bundle /verified/product-bundle --build /verified/new-build \
  --msi-sha256 NEW_MSI_SHA256 --receipt-sha256 NEW_BUILD_INPUT_SHA256 \
  --tools /verified/msitools/bin --create-test-only-rollback-fixture
```

Use its **new** plan SHA-256 when launching the runner with the extra rollback flag.
This operation augments the test bundle only. It requires the new MSI/build receipt
already be pinned in that bundle and requires an isolated UUIDv4 installation family.
It rechecks the full extracted product inventory and source receipt, clones the MSI,
adds precisely one conditional Type-19 error action at sequence 4001 after native
`RemoveExistingProducts` and `InstallFiles` scheduling, and assigns a different
PackageCode so the failing MSI cannot stand in for the normal new package's cache
identity. The condition is `OLDERPRODUCTS`; the source MSI has no custom actions.
Every other table is compared with the source, every cabinet stream must be
byte-identical, other summary properties must be unchanged, and the original normal
MSI must still have its independent digest. The resulting clone and verification
receipt receive separate SHA-256 pins in the optional `rollbackFixture` plan field.

At the existing UI restart boundary, the old real app already contains synthetic
projects and execution history. The runner saves their complete exports, cleanly
closes the app, attempts the failing upgrade, and requires exit 1603 plus ordered
log evidence: successful old-product removal, the specific intentional action
failing, then actual `Executing op: RollbackInfo` (not merely `DisableRollback=0`).
It then requires old-version registration, new-version absence, every old program
file restored, foreign sentinel retained, and byte-identical synthetic profile.
It launches the **old actual Electron executable** again, checks its live identity,
reads complete exports/history, compares them with the pre-failure snapshot, records
a screenshot, and prohibits traffic replay. Only after those checks and clean old-app
exit does it attempt the ordinary successful upgrade with the untouched new MSI.

A test timeout or unexpected error stops the sequence without guessing at cleanup
or proceeding to the success path. The seven-minute per-MSI bound remains unchanged. The native job allows 40 minutes
for five ordinary MSI operations or 55 minutes with the sixth rollback operation,
leaving setup/GUI time beyond the aggregate operation deadlines. `productRollbackVerified` stays false until all rollback checks
pass; local authoring/contract tests do not set it. This scenario tests rollback of
an installer failure after owned-file removal, **not** a failure after a new app has
run data migrations. Real native execution of this optional full-product scenario
is still required, as are signing, ICE, and genuine standard-user acceptance.
