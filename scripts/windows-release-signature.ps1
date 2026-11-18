param(
  [Parameter(Mandatory)][string]$File,
  [string]$ExpectedPublisher,
  [switch]$Sign
)
$ErrorActionPreference = 'Stop'
$File = (Resolve-Path -LiteralPath $File).Path
if ($Sign -and $ExpectedPublisher) { throw 'Signing cannot override configured publisher' }
$publisher = if ($ExpectedPublisher) { $ExpectedPublisher } else { $env:WORKBENCH_PUBLISHER_THUMBPRINT }
if ($publisher -notmatch '^[0-9a-fA-F]{40}$') { throw 'Expected publisher certificate thumbprint required' }
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$sdk = Get-ChildItem -LiteralPath $kits -Directory | Where-Object Name -Match '^10\.0\.\d+\.\d+$' | Sort-Object { [version]$_.Name } -Descending
$signTool = $sdk | ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $signTool) { throw 'Windows SDK signtool is required' }
if ($Sign) {
  if ($env:WORKBENCH_TIMESTAMP_URL -notmatch '^https?://[^\s]+$') { throw 'Configured timestamp service required' }
  & $signTool sign /sha1 $publisher /fd SHA256 /tr $env:WORKBENCH_TIMESTAMP_URL /td SHA256 $File
  if ($LASTEXITCODE) { throw 'Signing failed' }
}
& $signTool verify /pa /v /all $File
if ($LASTEXITCODE) { throw 'Authenticode verification failed' }
$auth = Get-AuthenticodeSignature -LiteralPath $File
. (Join-Path $PSScriptRoot 'windows_release_predecessor.ps1')
Assert-PinnedAuthenticode $auth $publisher
