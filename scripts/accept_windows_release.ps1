param([Parameter(Mandatory)][string]$Media, [Parameter(Mandatory)][string]$ExpectedSha,
      [Parameter(Mandatory)][string]$ManifestSha, [string]$PreviousMedia)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($env:LOCALAPI_DISPOSABLE_RELEASE_VM -ne '1' -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Fresh disposable Windows standard-user VM required' }
$target = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'LocalAPI-Workbench'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Local API Workbench.lnk'
$Media = (Resolve-Path -LiteralPath $Media).Path
$out = (New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP ('release-check-' + [guid]::NewGuid()))).FullName
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $shortcut)) { throw 'Existing product refused' }
if ((Get-FileHash -LiteralPath $Media).Hash -ne $ExpectedSha) { throw 'Signed MSI digest changed' }
& "$PSScriptRoot/windows-release-signature.ps1" -File $Media
function Invoke-Msi([string]$verb, [string]$file, [string]$label) {
  $log = Join-Path $out ($label + '.log')
  $p = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList @($verb, ('"' + $file + '"'), '/qn', '/norestart','/l*v',('"' + $log + '"')) -PassThru -WindowStyle Hidden
  if (-not $p.WaitForExit(600000)) { throw "Windows Installer did not finish $label" }
  if ($p.ExitCode -ne 0) { throw "Windows Installer failed $label ($($p.ExitCode))" }
}
function Check-Installed {
  if ((Get-FileHash -LiteralPath (Join-Path $target 'build-manifest.json')).Hash -ne $ManifestSha) { throw 'Installed manifest mismatch' }
  & node --input-type=module -e "import {verifyPortableManifest} from './scripts/portable-integrity.mjs';await verifyPortableManifest(process.argv[1]);" $target
  if ($LASTEXITCODE) { throw 'Installed file inventory changed' }
  $exe = Join-Path $target 'LocalAPI.exe'
  & "$PSScriptRoot/windows-release-signature.ps1" -File $exe
  & "$PSScriptRoot/windows-release-signature.ps1" -File (Join-Path $target 'resources/app/src/vendor/dameng-native/workbench-dameng-read.exe')
  if (!(Test-Path -LiteralPath $shortcut) -or (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath -ne $exe) { throw 'Start menu shortcut mismatch' }
  & node tests/desktop-restart-journey.mjs --package-root $target
  if ($LASTEXITCODE) { throw 'Installed application restart journey failed' }
}
if ($PreviousMedia) {
  & "$PSScriptRoot/windows-release-signature.ps1" -File $PreviousMedia
  Invoke-Msi '/i' $PreviousMedia 'previous-install'
}
Invoke-Msi '/i' $Media 'install'
Check-Installed
Invoke-Msi '/x' $Media 'uninstall'
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $shortcut)) { throw 'Uninstall left owned files' }
Invoke-Msi '/i' $Media 'reinstall'
Check-Installed
Invoke-Msi '/x' $Media 'final-uninstall'
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $shortcut)) { throw 'Final uninstall left owned files' }
@{ head=$env:GITHUB_SHA; sha256=$ExpectedSha; manifestSha256=$ManifestSha; standardUser=$true;
   os=[Environment]::OSVersion.VersionString; publisher=$env:WORKBENCH_PUBLISHER_THUMBPRINT; previousReleaseUpgraded=[bool]$PreviousMedia } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'release-acceptance.json')
