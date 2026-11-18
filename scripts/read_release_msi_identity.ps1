function Read-ReleaseMsiIdentity([string]$Media, [string]$ExpectedVersion) {
  $installer = New-Object -ComObject WindowsInstaller.Installer
  $database = $installer.OpenDatabase($Media, 0)
  $properties = @{}
  foreach ($property in @('ProductCode', 'UpgradeCode', 'ProductVersion')) {
    $view = $database.OpenView("SELECT Value FROM Property WHERE Property = '$property'")
    try {
      [void]$view.Execute()
      $row = $view.Fetch()
      if (-not $row) { throw "Missing MSI property $property" }
      $properties[$property] = $row.StringData(1)
    } finally { [void]$view.Close() }
  }
  if ([guid]$properties.UpgradeCode -ne [guid]'E61ED3E9-BFC1-56E6-9B89-6454D39122AE' -or
      $properties.ProductVersion -cne $ExpectedVersion) { throw 'Release MSI family or version mismatch' }
  return @{ code=([guid]$properties.ProductCode).ToString('B'); version=$properties.ProductVersion }
}
