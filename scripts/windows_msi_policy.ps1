# Observe only HKLM's native 64-bit Installer policy view. Never write policy.
function New-MsiPolicyObservation([string]$State, $Kind=$null, $Value=$null) {
    return [ordered]@{ registryView='Registry64'; state=$State; kind=$Kind; value=$Value }
}
function Read-MsiPolicyKey($Key) {
    try {
        # A successfully opened base hive with a missing subkey/value is ABSENT,
        # not explicit DWORD 0. An exception is UNAVAILABLE, never absence.
        if ($null -eq $Key) { return New-MsiPolicyObservation 'absent' }
        if ('DisableMSI' -notin @($Key.GetValueNames())) { return New-MsiPolicyObservation 'absent' }
        if ($Key.GetValueKind('DisableMSI').ToString() -cne 'DWord') { return New-MsiPolicyObservation 'malformed' }
        $value = $Key.GetValue('DisableMSI', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($value -isnot [int] -or $value -notin @(0,1,2)) { return New-MsiPolicyObservation 'malformed' }
        return New-MsiPolicyObservation 'present' 'DWord' $value
    } catch { return New-MsiPolicyObservation 'unavailable' }
}
function Read-WindowsMsiPolicy {
    $base = $null; $key = $null
    try {
        # Registry64 silently maps to Registry32 on a 32-bit OS; reject that case.
        if (-not $IsWindows -or -not [Environment]::Is64BitOperatingSystem) { return New-MsiPolicyObservation 'unavailable' }
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
        $key = $base.OpenSubKey('SOFTWARE\Policies\Microsoft\Windows\Installer', $false)
        return Read-MsiPolicyKey $key
    } catch { return New-MsiPolicyObservation 'unavailable' }
    finally { if ($null -ne $key) { $key.Dispose() }; if ($null -ne $base) { $base.Dispose() } }
}
function Get-MsiPolicyDecision($Observation) {
    try {
        if ($Observation.registryView -cne 'Registry64') { return 'unavailable' }
        if ($Observation.state -ceq 'absent' -and $null -eq $Observation.kind -and $null -eq $Observation.value) { return 'no-explicit-override' }
        if ($Observation.state -ceq 'present' -and $Observation.kind -ceq 'DWord' -and $Observation.value -is [int]) {
            switch ($Observation.value) {
                0 { return 'explicit-zero' }
                1 { return 'blocks-unmanaged-install' }
                2 { return 'blocks-all-install' }
            }
        }
        return 'unavailable'
    } catch { return 'unavailable' }
}
function Assert-MsiPolicyForStandardUser($Observation) {
    if ((Get-MsiPolicyDecision $Observation) -notin @('no-explicit-override','explicit-zero')) {
        throw 'Installer machine policy blocks this test or could not be safely observed'
    }
}
function ConvertTo-MsiPolicyEvidence($Observation) {
    $decision = Get-MsiPolicyDecision $Observation
    # Only whitelisted states/integers are public, never raw registry/error strings.
    $result = [ordered]@{ registryView='Registry64'; state='unavailable'; kind=$null; value=$null; decision=$decision; effectivePolicyVerified=$false }
    if ($decision -eq 'no-explicit-override') { $result.state='absent' }
    elseif ($decision -in @('explicit-zero','blocks-unmanaged-install','blocks-all-install')) { $result.state='present'; $result.kind='DWord'; $result.value=[int]$Observation.value }
    elseif ($Observation -is [Collections.IDictionary] -and $Observation.Contains('state') -and $Observation['state'] -ceq 'malformed') { $result.state='malformed' }
    return $result
}
