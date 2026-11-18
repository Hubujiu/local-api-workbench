# Windows MSI lifecycle candidate (not a release)

This implementation adds native Windows Installer **major upgrade, uninstall and
transactional failure rollback**, rather than another before/after-only verifier.
It is separate from the historical NSIS first-install candidate. No automatic import
of that installation, existing profile or project data is supported.

## Implemented package behavior

- Per-user x64, embedded cabinet, fixed `%LOCALAPPDATA%\LocalAPI-Lifecycle-Candidate`
  namespace, no installer-time internet dependency, no auto-launch or updater.
- Stable `UpgradeCode` for the candidate family, version-specific `ProductCode`, and
  stable component identity by relative application path. Version is canonical MSI
  major.minor.build; a changed application build must bump one of those fields.
- `FindRelatedProducts` selects strictly older versions for removal. Same or newer
  versions are detection-only; downgrade and same-version replacement are refused.
- `RemoveExistingProducts` is **immediately after InstallInitialize**, before script
  actions. Removing the old product is therefore inside Windows Installer's rollback
  transaction. This is authoring evidence until the native failure case actually runs.
- Native File/Component removal owns only packaged application files and each
  component's HKCU registry keypath. No recursive directory deletion, wildcard removal,
  custom action, profile/project path, service or startup registration is authored.
  Uninstall removes registered files, not arbitrary foreign children; empty directories
  may remain. Modifying an installer-owned file does not make that file foreign.
- AppSearch/DrLocator refuses an existing directory on first install. Repair/modify
  are not offered; explicit native uninstall is allowed. RollbackDisabled (including policy) and explicit DISABLEROLLBACK
  are refused. These are not certified defenses against hostile same-user races,
  reparse aliases, MSI transforms or command-line property tampering.

The generator verifies pinned payload inventory, platform, app identity and version,
then exports and checks actual compiled tables, component GUIDs/HKCU ownership,
upgrade selection, sequence ordering and cabinet bytes. A failed build retains
UNVERIFIED output, never renames it to the candidate artifact.

## Build

`packaging/windows-msi/debian-toolchain-lock.json` pins the official Debian trixie
wixl/msitools packages and extra library bytes used here. Tool packages are extracted
into a private directory, not installed on the developer host. System libraries are
not claimed hermetically pinned. Compile source via:

```sh
LD_LIBRARY_PATH=<verified-tools>/usr/lib/x86_64-linux-gnu \
python scripts/prepare_windows_lifecycle_msi.py \
  --payload <verified-payload> --output <fresh-output> \
  --head <full-head> --version 0.1.0 --manifest-sha256 <independent-manifest-digest> \
  --tools <verified-tools>/usr/bin
```

No package is executed by the authoring or Linux test pipeline. The output remains
unsigned and blocked from installation on the user's personal workstation.

## Repeatable disposable native runner

`.github/workflows/windows-installer-lifecycle.yml` is **manual dispatch only**. Its
Linux build job creates two tiny, inert application fixtures in a fresh UUID-scoped
family; the fake `.exe` is text, not executable code. It uploads only those fixtures.
The Windows hosted job uses the OS Windows Installer and records:

1. Existing foreign directory refusal.
2. First install, exact file inventory and product registration.
3. Deliberately failed major upgrade, original product restored with exact old bytes.
4. Successful upgrade, new bytes and registration, old registration removed.
5. Downgrade refusal with no changed bytes.
6. Native uninstall preserving a foreign file and external synthetic project.
7. Same-version reinstall after uninstall, then final native uninstall.

Only the **test harness** mutates a copy of the inert fixture to add a Type 19 failure
action after InstallFiles. Production candidate authoring forbids all CustomAction
rows. The runner checks rollback logs as well as old registration and bytes. It never
launches the application. Failure/timeout keeps logs and package state, does not
blindly retry or force cleanup; a timed-out Windows Installer service may still run.
Foreign-directory sentinels are retained by rename, not recursively removed.

Hosted Windows runners may have elevated tokens. The JSON records this and does not
turn a hosted fixture pass into standard-user acceptance. No local account creation,
security-setting changes, personal Windows session or paid VM is requested by this
workflow. Dispatch is not performed by adding this source file.

## Remaining gates

Native Windows results are **not available in this local implementation turn**.
Linux compilation and table checks do not establish Windows behavior. Before personal
or production installation, obtain native fixture results, ICE validation, full real
payload standard-user installation/upgrade/uninstall, running-program/locked-file
behavior, same-name foreign collision and reparse/concurrent replacement checks,
code signing/SmartScreen and application data compatibility. MSI rollback concerns
only installer changes, not data migrations performed when an application later runs.
Do not describe this candidate or a green generic CI as final product delivery.

## Primary specifications

- https://learn.microsoft.com/en-us/windows/win32/msi/removeexistingproducts-action
- https://learn.microsoft.com/en-us/windows/win32/msi/rollback-installation
- https://learn.microsoft.com/en-us/windows/win32/msi/upgrade-table
- https://learn.microsoft.com/en-us/windows/win32/msi/productversion
- https://learn.microsoft.com/en-us/windows/win32/msi/ice38
