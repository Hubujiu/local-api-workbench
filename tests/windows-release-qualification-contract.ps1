$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Reuse all token, missing evidence, privacy, OS and policy negative fixtures.
. (Join-Path $PSScriptRoot 'windows-standard-user-contract.ps1')
. (Join-Path $PSScriptRoot '../scripts/windows_release_qualification.ps1')
$qualified=New-SignedReleaseQualification (New-Receipt)
if ($qualified.schema -cne 'localapi-windows-standard-user-qualification-v1' -or -not $qualified.preflightPassed) { throw 'Qualification schema mismatch' }
foreach ($change in $changes) {
    $receipt=New-Receipt; & $change $receipt
    $rejected=$false
    try { New-SignedReleaseQualification $receipt | Out-Null } catch { $rejected=$true }
    if (-not $rejected) { throw 'Unsafe signed qualification accepted' }
}
foreach ($architecture in @('Arm64','X86',$null)) {
    $receipt=New-Receipt; $receipt.os.nativeArchitecture=$architecture
    $rejected=$false
    try { New-SignedReleaseQualification $receipt | Out-Null } catch { $rejected=$true }
    if (-not $rejected) { throw 'Non-native x64 signed qualification accepted' }
}
$receipt=New-Receipt; $receipt.errors=@('SECRET_HOST SECRET_ACCOUNT');$receipt.observationComplete=$false
try { New-SignedReleaseQualification $receipt | Out-Null; throw 'Unexpected qualification' }
catch { if ($_.Exception.Message -match 'SECRET_' -or $_.Exception.Message -eq 'Unexpected qualification') { throw 'Qualification privacy/fail-closed violation' } }
$json=$qualified|ConvertTo-Json -Compress
foreach($private in @('S-1-','SECRET_','userSid','groups','hostedRunner','signedLifecyclePassed')) {
    if ($json.Contains($private)) { throw 'Qualification leaked identity or claimed lifecycle success' }
}
$source=Get-Content (Join-Path $PSScriptRoot '../scripts/accept_windows_release.ps1') -Raw
if ($source.IndexOf('New-SignedReleaseQualification') -gt $source.IndexOf('$target =')) { throw 'Qualification must precede all installation work' }
if ($source.LastIndexOf('New-SignedReleaseQualification') -lt $source.IndexOf("'final-uninstall'")) { throw 'Completion requires requalification after all lifecycle assertions' }
if ($source -match 'IsInRole') { throw 'Signed gate trusts filtered-admin role shortcut' }
Write-Output 'Signed qualification negatives, sanitization and lifecycle ordering passed; native acceptance NOT run'
