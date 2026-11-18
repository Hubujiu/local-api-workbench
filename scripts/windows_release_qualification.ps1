# Read-only qualification in the SAME PowerShell process that runs signed lifecycle acceptance.
. (Join-Path $PSScriptRoot 'windows_standard_user.ps1')
function New-SignedReleaseQualification($Observation) {
    try { Assert-Windows11StandardUserReceipt $Observation }
    catch { throw 'Signed release requires verified interactive Windows 11 native x64 non-Administrator qualification' }
    # Fixed public schema only. Never include account/SID/group lists, host names or raw exceptions.
    return [ordered]@{ schema='localapi-windows-standard-user-qualification-v1';
        preflightPassed=$true; windows11Client=$true; nativeX64=$true; uacEnabled=$true;
        genuineNonAdministrator=$true; interactiveToken=$true; installerPolicyObserved=$true }
}
