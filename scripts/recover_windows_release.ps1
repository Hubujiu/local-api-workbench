param([Parameter(Mandatory)][string]$Media, [Parameter(Mandatory)][string]$Verification)
$ErrorActionPreference = 'Stop'
$Media = (Resolve-Path -LiteralPath $Media).ProviderPath
$published = Get-Content -LiteralPath $Verification -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $Media).Hash -ne $published.sha256 -or $published.manifestSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Published MSI digest mismatch' }
$signature = Get-AuthenticodeSignature -LiteralPath $Media
if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate -or $signature.SignerCertificate.Thumbprint -ne $published.publisher) { throw 'Published, trusted, timestamped signer required' }
. (Join-Path $PSScriptRoot 'read_release_msi_identity.ps1')
. (Join-Path $PSScriptRoot 'windows_msi_registration.ps1')
. (Join-Path $PSScriptRoot 'windows_advertised_recovery.ps1')
$identity = Read-ReleaseMsiIdentity $Media $published.version
$logs = [IO.Directory]::CreateDirectory((Join-Path $env:LOCALAPPDATA ('LocalAPI-RecoveryLogs-' + [guid]::NewGuid()))).FullName
Restore-AdvertisedProduct -Media $Media -Sha256 $published.sha256 -ManifestSha $published.manifestSha256 -Version $published.version -ProductCode $identity.code -UpgradeCode 'E61ED3E9-BFC1-56E6-9B89-6454D39122AE' -Directory 'LocalAPI-Workbench' -Evidence $logs
