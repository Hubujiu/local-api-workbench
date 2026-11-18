$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/windows_msi_registration.ps1')
function Receipt([int]$StateError=0, [string]$State='5', [int]$VersionError=0, [string]$Version='0.1.0', [int]$ManagedError=1605, [int]$MachineError=1605) {
    return @{ contexts=@(
        @{context=1; stateError=$ManagedError; state=$null; versionError=$null; version=$null},
        @{context=2; stateError=$StateError; state=$State; versionError=$VersionError; version=$Version},
        @{context=4; stateError=$MachineError; state=$null; versionError=$null; version=$null}
    ) }
}
Assert-MsiRegistrationReceipt (Receipt) '0.1.0' $true
Assert-MsiRegistrationReceipt (Receipt -StateError 1605) '0.1.0' $false
$cases = @(
    @{ value=(Receipt -State '1'); expected=$true },
    @{ value=(Receipt -StateError 5); expected=$true },
    @{ value=(Receipt -VersionError 1608); expected=$true },
    @{ value=(Receipt -Version '0.2.0'); expected=$true },
    @{ value=(Receipt -MachineError 0); expected=$true },
    @{ value=(Receipt -ManagedError 0); expected=$true },
    @{ value=(Receipt); expected=$false },
    @{ value=(Receipt -StateError 5); expected=$false },
    @{ value=(Receipt -StateError 1608); expected=$false },
    @{ value=@{ contexts=@() }; expected=$false },
    @{ value=@{ contexts=@(@{context=2},@{context=2},@{context=4}) }; expected=$false }
)
foreach ($case in $cases) {
    $refused = $false
    try { Assert-MsiRegistrationReceipt $case.value '0.1.0' $case.expected } catch { $refused = $true }
    if (-not $refused) { throw 'Invalid registration observation was accepted' }
}
Write-Output 'MSI registration contract: 13 cases passed; no native product query performed'
