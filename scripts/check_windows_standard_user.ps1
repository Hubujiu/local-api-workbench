$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows_standard_user.ps1')
ConvertTo-WindowsStandardUserEvidence (Read-WindowsStandardUserReceipt) | ConvertTo-Json -Depth 8 -Compress
