param([Parameter(Mandatory)][string]$Media, [Parameter(Mandatory)][string]$ExpectedSha,
      [Parameter(Mandatory)][string]$ManifestSha, [string]$PreviousMedia, [string]$PreviousVersion, [string]$PreviousVerification, [string]$PreviousReceiptSha, [string]$PreviousMediaSha, [string]$PreviousHead)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows_release_predecessor.ps1')
Assert-PreviousArguments $PSBoundParameters
if ($env:LOCALAPI_DISPOSABLE_RELEASE_VM -ne '1') { throw 'Fresh disposable Windows standard-user VM required' }
. (Join-Path $PSScriptRoot 'windows_release_qualification.ps1')
$qualification = New-SignedReleaseQualification (Read-WindowsStandardUserReceipt)
$target = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'LocalAPI-Workbench'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Local API Workbench.lnk'
$Media = (Resolve-Path -LiteralPath $Media).Path
$out = (New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP ('release-check-' + [guid]::NewGuid()))).FullName
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $shortcut)) { throw 'Existing product refused' }
if ((Get-FileHash -LiteralPath $Media).Hash -ne $ExpectedSha) { throw 'Signed MSI digest changed' }
& "$PSScriptRoot/windows-release-signature.ps1" -File $Media
. "$PSScriptRoot/read_release_msi_identity.ps1"
. "$PSScriptRoot/windows_msi_registration.ps1"
$current = Read-ReleaseMsiIdentity $Media $env:VERSION
$profiles = [System.Collections.Generic.List[string]]::new()
function Test-ProjectFiles {
  foreach ($record in $profiles) {
    & node tests/helpers/release-profile-receipt.mjs $record
    if ($LASTEXITCODE) { throw 'Saved project or history changed during install lifecycle' }
  }
}
function Save-JourneyProfile([string]$label) {
  $record = Join-Path $out ($label + '-projects.json')
  & node tests/desktop-restart-journey.mjs --package-root $target --retain-profile-receipt $record
  if ($LASTEXITCODE) { throw "Installed application restart journey failed at $label" }
  $profiles.Add($record)
}
function Confirm-Registration($identity, [bool]$present) {
  Assert-MsiProductRegistration $identity.code $identity.version $present | Out-Null
}
function Invoke-Msi([string]$verb, [string]$file, [string]$label) {
  Test-ProjectFiles
  $log = Join-Path $out ($label + '.log')
  $p = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList @($verb, ('"' + $file + '"'), '/qn', '/norestart','/l*v',('"' + $log + '"')) -PassThru -WindowStyle Hidden
  if (-not $p.WaitForExit(600000)) { throw "Windows Installer did not finish $label" }
  if ($p.ExitCode -ne 0) { throw "Windows Installer failed $label ($($p.ExitCode))" }
  Test-ProjectFiles
}
function Check-Installed {
  if ((Get-FileHash -LiteralPath (Join-Path $target 'build-manifest.json')).Hash -ne $ManifestSha) { throw 'Installed manifest mismatch' }
  & node --input-type=module -e "import {verifyPortableManifest} from './scripts/portable-integrity.mjs';await verifyPortableManifest(process.argv[1]);" $target
  if ($LASTEXITCODE) { throw 'Installed file inventory changed' }
  $exe = Join-Path $target 'LocalAPI.exe'
  & "$PSScriptRoot/windows-release-signature.ps1" -File $exe
  & "$PSScriptRoot/windows-release-signature.ps1" -File (Join-Path $target 'resources/app/src/vendor/dameng-native/workbench-dameng-read.exe')
  if (!(Test-Path -LiteralPath $shortcut) -or (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath -ne $exe) { throw 'Start menu shortcut mismatch' }
  Confirm-Registration $current $true
}
Confirm-Registration $current $false
$predecessorEvidence=$null
if ($PreviousMedia) {
  . (Join-Path $PSScriptRoot 'windows_release_predecessor.ps1')
  $published = Read-PinnedReleaseReceipt $PreviousVerification $PreviousReceiptSha
  $previousPublisher = Get-PreviousPublisher $PreviousVersion $published.publisher $env:WORKBENCH_PUBLISHER_THUMBPRINT $env:WORKBENCH_PUBLISHER_ROTATION
  Assert-ReleaseReceipt $published $PreviousVersion $PreviousMediaSha $previousPublisher
  if ($PreviousHead -notmatch '^[a-f0-9]{40}$' -or $published.head -cne $PreviousHead -or (Get-FileHash -LiteralPath $PreviousMedia).Hash -ine $PreviousMediaSha) { throw 'Predecessor release identity or media digest mismatch' }
  & "$PSScriptRoot/windows-release-signature.ps1" -File $PreviousMedia -ExpectedPublisher $previousPublisher
  $predecessorEvidence=@{version=$PreviousVersion;head=$PreviousHead;sha256=$PreviousMediaSha;receiptSha256=$PreviousReceiptSha;publisher=$previousPublisher;rotationAuthorized=($previousPublisher -ine $env:WORKBENCH_PUBLISHER_THUMBPRINT)}
  $previous = Read-ReleaseMsiIdentity $PreviousMedia $PreviousVersion
  if ($previous.code -eq $current.code -or [version]$previous.version -ge [version]$current.version) { throw 'Upgrade requires an older, distinct product in the same family' }
  Confirm-Registration $previous $false
  Invoke-Msi '/i' $PreviousMedia 'previous-install'
  Confirm-Registration $previous $true
  Save-JourneyProfile 'previous'
}
Invoke-Msi '/i' $Media 'install'
if ($PreviousMedia) { Confirm-Registration $previous $false }
Check-Installed
Save-JourneyProfile 'installed'
Invoke-Msi '/x' $Media 'uninstall'
Confirm-Registration $current $false
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $shortcut)) { throw 'Uninstall left owned files' }
Invoke-Msi '/i' $Media 'reinstall'
Check-Installed
Save-JourneyProfile 'reinstalled'
Invoke-Msi '/x' $Media 'final-uninstall'
Confirm-Registration $current $false
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $shortcut)) { throw 'Final uninstall left owned files' }
# Recheck in this process only AFTER every signed lifecycle assertion completed.
$qualification = New-SignedReleaseQualification (Read-WindowsStandardUserReceipt)
@{ schema='localapi-signed-windows-release-acceptance-v2'; qualification=$qualification; signedLifecyclePassed=$true; head=$env:GITHUB_SHA; sha256=$ExpectedSha; manifestSha256=$ManifestSha; standardUser=$true;
   os='Windows 11 native x64'; publisher=$env:WORKBENCH_PUBLISHER_THUMBPRINT; previousReleaseUpgraded=[bool]$PreviousMedia; previousReleaseEvidence=$predecessorEvidence;
   projectFilesPreserved=$true; registrationVerified=$true } |
  ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $out 'release-acceptance.json')
