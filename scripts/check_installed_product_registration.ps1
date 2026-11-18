param([Parameter(Mandatory=$true)][string]$Plan, [Parameter(Mandatory=$true)][ValidateSet('absent','old','new')][string]$Expected)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows_msi_registration.ps1')
$inputPlan = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
$receipts = @()
for ($i = 0; $i -lt 2; $i++) {
    $item = $inputPlan.packages[$i]
    $receipt = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $Plan) $item.receipt.file) -Raw | ConvertFrom-Json
    $present = ($Expected -eq 'old' -and $i -eq 0) -or ($Expected -eq 'new' -and $i -eq 1)
    $receipts += Assert-MsiProductRegistration $receipt.productCode $item.version $present
}
ConvertTo-Json -Depth 8 -InputObject $receipts -Compress
