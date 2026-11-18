# Shared by signed release recovery and the disposable Windows acceptance run.
function Restore-AdvertisedProduct {
  param([string]$Media, [string]$Sha256, [string]$ManifestSha, [string]$Version, [guid]$ProductCode,
        [guid]$UpgradeCode, [string]$Directory, [string]$Evidence)
  if ($Directory -cne 'LocalAPI-Workbench' -and $Directory -cnotmatch '^LocalAPI-Q-[0-9a-f-]{36}$') { throw 'Unknown product directory' }
  $accountRoot = (Resolve-Path -LiteralPath $env:LOCALAPPDATA).ProviderPath
  $target = [IO.Path]::GetFullPath((Join-Path $accountRoot $Directory))
  $saved = [IO.Path]::GetFullPath((Join-Path $accountRoot ('LocalAPI-R-' + [guid]::NewGuid().ToString('N').Substring(0,12))))
  if ([IO.Path]::GetDirectoryName($target) -ne $accountRoot -or [IO.Path]::GetDirectoryName($saved) -ne $accountRoot) { throw 'Unexpected recovery location' }
  for ($item = Get-Item -LiteralPath $target; $null -ne $item; $item = $item.Parent) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Aliased application path' }
  }
  $mediaPath = (Resolve-Path -LiteralPath $Media).ProviderPath
  if ($mediaPath.StartsWith($target + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Recovery media must be outside the installation' }
  if ((Get-FileHash -LiteralPath $mediaPath).Hash -ne $Sha256) { throw 'Original MSI digest mismatch' }
  $old = Read-MsiProductRegistration $ProductCode
  Assert-MsiRegistrationReceipt $old $Version $true -AllowAdvertised
  if (@($old.contexts | Where-Object context -eq 2)[0].state -ne '1') { throw 'Only advertised installations require this recovery' }
  $family = @([LocalApiMsiRegistration.Native]::RelatedProducts($UpgradeCode.ToString('B').ToUpperInvariant()))
  # A rolled-back advertisement can lose its upgrade-family index. The product
  # itself must have the exact advertised registration checked above.
  foreach ($related in $family) {
    if ([guid]$related -ne $ProductCode) { throw 'Another product is registered in the recovery family' }
  }
  $manifest = Join-Path $target 'build-manifest.json'
  if ((Get-FileHash -LiteralPath $manifest).Hash -ne $ManifestSha -or (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version -cne $Version) { throw 'Restored files and original MSI identity differ' }
  # A sibling rename keeps program and user-added files together even if MSI fails.
  [IO.Directory]::Move($target, $saved)
  [Console]::Error.WriteLine("Recovery copy: $saved")
  foreach ($phase in @('unregister','install')) {
    if ((Get-FileHash -LiteralPath $mediaPath).Hash -ne $Sha256) { throw 'Original MSI changed' }
    $verb = if ($phase -eq 'unregister') { '/x' } else { '/i' }
    $log = Join-Path $Evidence ("recover-" + $phase + ".log")
    $installer = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList "$verb ""$mediaPath"" /qn /norestart REBOOT=ReallySuppress /L*v ""$log""" -WindowStyle Hidden -PassThru
    if (-not $installer.WaitForExit(600000)) { throw "MSI recovery $phase did not finish. Inspect $log and $saved." }
    if ($installer.ExitCode -ne 0) { throw "MSI recovery $phase returned $($installer.ExitCode). See $log. Files retained at $saved." }
    [void](Assert-MsiProductRegistration $ProductCode $Version ($phase -eq 'install'))
  }
  if ((Get-FileHash -LiteralPath (Join-Path $target 'build-manifest.json')).Hash -ne $ManifestSha) { throw "Recovered application manifest mismatch. Files retained at $saved." }
  return $saved
}
