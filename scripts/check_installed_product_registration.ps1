param([Parameter(Mandatory=$true)][string]$Plan, [Parameter(Mandatory=$true)][ValidateSet('absent','old','new','after-failure','restore-old')][string]$Expected, [string]$Evidence)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows_msi_registration.ps1')
$inputPlan = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
if ($Expected -eq 'restore-old') {
    . (Join-Path $PSScriptRoot 'windows_advertised_recovery.ps1')
    $item = $inputPlan.packages[0]
    $root = Split-Path -Parent $Plan
    $receipt = Get-Content -LiteralPath (Join-Path $root $item.receipt.file) -Raw | ConvertFrom-Json
    $backup = Restore-AdvertisedProduct -Media (Join-Path $root $item.msi.file) -Sha256 $item.msi.sha256 -ManifestSha $receipt.manifestSha256 -Version $item.version -ProductCode $receipt.productCode -UpgradeCode $receipt.upgradeCode -Directory $inputPlan.directory -Evidence $Evidence
    ConvertTo-Json -InputObject @{backup=$backup} -Compress
    exit
}
$receipts = @()
for ($i = 0; $i -lt 2; $i++) {
    $item = $inputPlan.packages[$i]
    $receipt = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $Plan) $item.receipt.file) -Raw | ConvertFrom-Json
    $oldAfterFailure = $Expected -eq 'after-failure' -and $i -eq 0
    $present = $oldAfterFailure -or ($Expected -eq 'old' -and $i -eq 0) -or ($Expected -eq 'new' -and $i -eq 1)
    $observed = Read-MsiProductRegistration $receipt.productCode
    Assert-MsiRegistrationReceipt $observed $item.version $present -AllowAdvertised:$oldAfterFailure
    $receipts += $observed
}
ConvertTo-Json -Depth 8 -InputObject $receipts -Compress
