$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/windows_msi_policy.ps1')
function Fake-Key($Names, $Kind, $Value, [bool]$Fail=$false) {
    $key=[pscustomobject]@{Names=$Names;Kind=$Kind;Value=$Value;Fail=$Fail}
    $key | Add-Member ScriptMethod GetValueNames { if($this.Fail){throw 'PRIVATE_HOST PRIVATE_ACCOUNT'}; return $this.Names }
    $key | Add-Member ScriptMethod GetValueKind {param($name); return $this.Kind}
    $key | Add-Member ScriptMethod GetValue {param($name,$fallback,$options); return $this.Value}
    return $key
}
$cases=@(
    @{key=$null;state='absent';decision='no-explicit-override'},
    @{key=(Fake-Key @('Other') 'DWord' 1);state='absent';decision='no-explicit-override'},
    @{key=(Fake-Key @('DisableMSI') 'DWord' 0);state='present';decision='explicit-zero'},
    @{key=(Fake-Key @('DisableMSI') 'DWord' 1);state='present';decision='blocks-unmanaged-install'},
    @{key=(Fake-Key @('DisableMSI') 'DWord' 2);state='present';decision='blocks-all-install'},
    @{key=(Fake-Key @('DisableMSI') 'String' '0');state='malformed';decision='unavailable'},
    @{key=(Fake-Key @('DisableMSI') 'DWord' 3);state='malformed';decision='unavailable'},
    @{key=(Fake-Key @('DisableMSI') 'DWord' $null);state='malformed';decision='unavailable'},
    @{key=(Fake-Key @('DisableMSI') 'DWord' 0 $true);state='unavailable';decision='unavailable'}
)
foreach($case in $cases) {
    $observed=Read-MsiPolicyKey $case.key
    if($observed.state -cne $case.state -or (Get-MsiPolicyDecision $observed) -cne $case.decision){throw 'Incorrect policy observation/decision'}
    $allowed=$true; try { Assert-MsiPolicyForStandardUser $observed } catch {$allowed=$false}
    if($allowed -ne ($case.decision -in @('no-explicit-override','explicit-zero'))){throw 'Policy rejection mismatch'}
    $public=ConvertTo-MsiPolicyEvidence $observed
    if($public.effectivePolicyVerified -ne $false -or ($public|ConvertTo-Json -Compress).Contains('PRIVATE_')){throw 'Leaked data or false effective-policy claim'}
    if($case.state -eq 'absent' -and $null -ne $public.value){throw 'Absent incorrectly coerced to zero'}
}
foreach($malformed in @($null,@{},@{registryView='Registry32';state='present';kind='DWord';value=0},@{registryView='Registry64';state='present';kind='DWord';value='0'},@{registryView='Registry64';state='absent';kind=$null;value=0})) {
    if((Get-MsiPolicyDecision $malformed) -cne 'unavailable'){throw 'Malformed policy allowed'}
}
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../scripts/windows_msi_policy.ps1') -Raw
if($source -notmatch 'RegistryView\]::Registry64' -or $source -notmatch 'OpenSubKey\([^\r\n]+\$false\)'){throw 'Native64/read-only contract missing'}
if($source -match '\.(SetValue|DeleteValue|CreateSubKey|DeleteSubKey)\('){throw 'Policy writes forbidden'}
Write-Output 'MSI policy: 14 mocked cases plus native64/read-only source contract passed; registry not queried'
