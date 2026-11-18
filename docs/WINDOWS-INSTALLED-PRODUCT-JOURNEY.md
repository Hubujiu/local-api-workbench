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

## Read-only Windows 11 standard-user preflight (native testing pending)

Hosted Windows administrator results are not Windows 11 standard-user acceptance.
On a **separately prepared disposable Windows 11 VM**, already logged in through an
interactive enabled ordinary local account outside Administrators, the manual gate is:

```powershell
node tests/desktop-installed-product-journey.mjs --plan C:\fixture\product-plan.json --expected-plan-sha256 PIN --execute-in-disposable-windows --require-standard-user
```

The optional `--exercise-product-rollback` flag can be added when the plan includes
the pinned rollback fixture. Without `--require-standard-user`, existing behavior
is unchanged and standard-user acceptance remains pending/false. This flag does not
create an account, provision a VM, change permissions/group membership/UAC, filter
an administrator token, sign a package, or configure a personal computer.

Before any product/MSI execution, the read-only helper checks OS caption/version/build
and **ProductType = 1**, thereby rejecting Windows Server even when its build number
is newer. It requires Windows 11, the UAC `EnableLUA` DWORD set to 1, a primary
non-elevated/unrestricted medium-integrity token with no linked elevated token,
a nonzero interactive session and enabled INTERACTIVE SID, an enabled matching local
account, and no administrator membership. Native token groups are inspected with
all raw attributes: the Administrators SID is rejected even when deny-only. Batch
and service logons, incomplete observations, and denied local-membership/CIM/native
queries fail closed. UAC is observed only; no setting is changed or reboot attempted.

Raw account/group observations stay in memory. Public preflight evidence contains
only the required OS/UAC facts, token/elevation classification, administrator-SID
presence/deny-only attributes, and a redacted user identity. It contains neither
account/machine names nor the full group-SID list. Public query failures use only the fixed `NATIVE_OBSERVATION_UNAVAILABLE` category;
assertion rejection uses a fixed fallback, never raw CIM/Get-LocalUser/native
exception text or malformed-observation error messages that could expose names.

`standardUserPreflightPassed` is separate from `standardUserAcceptance`. Passing
preflight alone leaves acceptance pending. Only that same opt-in journey completing
all native assertions and clean application shutdown can set full acceptance true;
cleanup failure clears it. Mocked portable tests do not constitute native testing.
No genuine Windows 11 standard-user run has yet been performed for this addition.

API references: [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation),
[TOKEN_GROUPS attributes](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_groups),
[TOKEN_ELEVATION_TYPE](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_elevation_type),
and [Win32_OperatingSystem](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem).

This redaction applies to the **new preflight receipt only**. Existing lifecycle
receipts, screenshots/traces, and MSI verbose logs can still contain local paths or
registration SIDs. Keep raw evidence from any future real machine private and share
only a separately redacted summary. This change does not rewrite prior evidence.

### Read-only Installer-policy early check

The optional standard-user preflight also reads
`HKLM\SOFTWARE\Policies\Microsoft\Windows\Installer\DisableMSI` using
`RegistryKey.OpenBaseKey(LocalMachine, Registry64)` and `OpenSubKey(..., false)`.
It requires a 64-bit OS, avoiding the documented fallback of Registry64 to the
32-bit view on a 32-bit OS. It never writes, clears, or overrides the policy.

The evidence distinguishes these states without exposing registry/error text:

- Explicit DWORD `1`: blocks unmanaged/non-elevated per-user installation; reject.
- Explicit DWORD `2`: disables installation; reject.
- Explicit DWORD `0`: no block from this setting, but not full policy/installation acceptance.
- Successfully observed missing key/value: `absent`, value **null**, decision
  `no-explicit-override`. This is not coerced to zero and does not prove an effective
  policy. Only the independently verified Windows 11 client gate can continue.
- Inaccessible/failed query, wrong registry view, wrong type or unsupported value:
  unavailable/malformed and fail closed. An error is never treated as absence.

The real run `44247162204`, job `134611730623`, source
`0594223a4b67a5e4232e6446fd6b21b354083aa5`, failed first install with 1625 on a
GitHub-hosted **Windows Server 2025** image. Verified evidence artifact `14403015275`
SHA-256 `13a73fb563fa7b660f871900872c489ec06eee7fc2f8c989728e17b55e1b3a01`
records effective `DisableMsi=1` and rejection of non-assigned applications for
non-admin users. It separately says the unsigned MSI is permitted by Software
Restriction Policy at the unrestricted level, and the MSI needs no elevation.
That is a policy refusal, not an observed signature/trust or installation-scope
failure. The log alone does not prove whether the registry explicitly held 1 or
Windows Installer supplied a Server default. Build 26100 alone does not prove
Windows 11. This addition does not promote that Server route to client acceptance.

No install is retried with elevation, `AlwaysInstallElevated`, a changed policy,
a different MSI scope, or a trust bypass. Other policy layers can still reject an
MSI after this limited preflight. Native standard-user client testing remains
pending and must use a suitable disposable Windows 11 environment with its existing
security settings intact, not a personal PC. Raw historical logs remain private.

References: [DisableMSI semantics](https://learn.microsoft.com/en-us/windows/win32/msi/disablemsi),
[explicit registry views](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.registrykey.openbasekey),
and [Registry64 fallback](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.registryview).

The strict product preflight also requires native OS architecture `X64` from
`RuntimeInformation.OSArchitecture`, not the process architecture or an environment
variable. ARM64 Windows running an emulated x64 process is not native x64 acceptance;
ARM64, x86 and missing architecture evidence are rejected. The collector requires
.NET 7 or newer, where Windows emulation-aware reporting is supported. This check
is read-only.
See [native OS architecture semantics](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.runtimeinformation.osarchitecture).
