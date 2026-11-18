[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$FixtureDirectory,
    [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
    [switch]$ExecuteInDisposableRunner
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $ExecuteInDisposableRunner) { throw 'Explicit disposable-runner execution switch required' }
if (-not $IsWindows) { throw 'Native Windows required' }
. (Join-Path $PSScriptRoot 'windows_msi_registration.ps1')
$fixture = (Resolve-Path -LiteralPath $FixtureDirectory).Path
$plan = Get-Content -LiteralPath (Join-Path $fixture 'native-plan.json') -Raw | ConvertFrom-Json
if ($plan.kind -ne 'localapi-inert-msi-lifecycle-v1' -or $plan.packages.Count -ne 2) { throw 'Not the generated inert fixture plan' }
$family = [guid]::Parse($plan.family).ToString()
if ($family -ne $plan.family -or $plan.directory -ne "LocalAPI-Lifecycle-Candidate-Fixture-$family") { throw 'Invalid fixture namespace' }
$target = Join-Path $env:LOCALAPPDATA $plan.directory
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
function Assert-NoReparse([string]$Path) {
    $node = [IO.Path]::GetFullPath($Path)
    while ($node) {
        if (Test-Path -LiteralPath $node) {
            $item = Get-Item -LiteralPath $node -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point refused' }
        }
        $parent = [IO.Directory]::GetParent($node)
        if ($null -eq $parent) { break }
        $node = $parent.FullName
    }
}
Assert-NoReparse $target
Assert-NoReparse $evidence
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $evidence)) { throw 'Fresh fixture target and evidence directory required' }
if ($evidence.StartsWith($target, [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence cannot be in installation directory' }
$old = $plan.packages[0]; $new = $plan.packages[1]
if ($old.version -ne '0.1.0' -or $new.version -ne '0.2.0') { throw 'Unexpected fixture versions' }
foreach ($p in $plan.packages) {
    $expected = "$($p.version)/build/LocalAPI-lifecycle-UNSIGNED.msi"
    if ($p.package -ne $expected) { throw 'Unexpected package path' }
    $path = Join-Path $fixture $p.package
    Assert-NoReparse $path
    if ((Get-Item -LiteralPath $path).Length -gt 1048576 -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $p.sha256) { throw 'Fixture MSI digest or size mismatch' }
    if (@($p.fileHashes.PSObject.Properties).Count -ne 7) { throw 'Only inert seven-file fixtures allowed' }
    Assert-MsiProductRegistration $p.productCode $p.version $false | Out-Null
}
New-Item -ItemType Directory -Path $evidence | Out-Null
$sentinel = Join-Path $evidence 'synthetic-project.json'
[IO.File]::WriteAllText($sentinel, '{"synthetic":"retain"}')
$sentinelHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
$steps = [Collections.Generic.List[object]]::new()
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$result = [ordered]@{ kind='native-inert-msi-lifecycle'; family=$family; nativeFixturePassed=$false; productAcceptance=$false; standardUserProcess=(-not $admin); iceValidated=$false; signatureVerified=$false; steps=$steps }
function Assert-Registered($Package, [bool]$Expected) {
    $receipt = Assert-MsiProductRegistration $Package.productCode $Package.version $Expected
    $steps.Add([ordered]@{ name='registration'; expectedInstalled=$Expected; receipt=$receipt })
}
function Invoke-Msi([string]$Label, [string]$Package, [bool]$Install, [int]$ExpectedExitCode) {
    Assert-NoReparse $target
    $verb = if ($Install) { '/i' } else { '/x' }
    $log = Join-Path $evidence "$Label.log"
    $args = "$verb `"$Package`" /qn /norestart REBOOT=ReallySuppress /L*v `"$log`""
    $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList $args -PassThru
    if (-not $process.WaitForExit(120000)) { throw 'MSI timeout; service may still run. No automatic retry or cleanup.' }
    $process.Refresh()
    $steps.Add([ordered]@{ name=$Label; exitCode=$process.ExitCode; log=$log })
    if ($process.ExitCode -ne $ExpectedExitCode) { throw "Unexpected MSI outcome in $Label : $($process.ExitCode)" }
    if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash) { throw 'Synthetic project changed' }
}
function Assert-Inventory($Package, [bool]$Foreign) {
    Assert-NoReparse $target
    $expected = @{}
    if ($null -ne $Package) { foreach ($property in $Package.fileHashes.PSObject.Properties) { $expected[$property.Name] = $property.Value } }
    if ($Foreign) { $expected['foreign-sentinel.txt'] = $script:foreignHash }
    $actual = @{}
    if (Test-Path -LiteralPath $target) {
        foreach ($f in Get-ChildItem -LiteralPath $target -Recurse -File -Force) {
            Assert-NoReparse $f.FullName
            $name = [IO.Path]::GetRelativePath($target, $f.FullName).Replace('\', '/')
            $actual[$name] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    if ($actual.Count -ne $expected.Count) { throw 'Installed inventory count differs' }
    foreach ($name in $expected.Keys) { if (-not $actual.ContainsKey($name) -or $actual[$name] -ne $expected[$name]) { throw "Installed inventory differs: $name" } }
}
function Invoke-ComMethod($Object, [string]$Name, [object[]]$Arguments) {
    return $Object.GetType().InvokeMember($Name, [Reflection.BindingFlags]::InvokeMethod, $null, $Object, $Arguments)
}
function New-FailingFixture([string]$Source, [string]$Destination) {
    Copy-Item -LiteralPath $Source -Destination $Destination
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $db = Invoke-ComMethod $installer 'OpenDatabase' @($Destination, 1)
    try {
        $lookup = Invoke-ComMethod $db 'OpenView' @("SELECT ``Name`` FROM ``_Tables`` WHERE ``Name`` = 'CustomAction'")
        $table = $null
        try {
            Invoke-ComMethod $lookup 'Execute' @() | Out-Null
            $table = Invoke-ComMethod $lookup 'Fetch' @()
            $exists = $null -ne $table
            Invoke-ComMethod $lookup 'Close' @() | Out-Null
        } finally {
            if ($null -ne $table) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($table) | Out-Null }
            [Runtime.InteropServices.Marshal]::FinalReleaseComObject($lookup) | Out-Null
        }
        $queries = [Collections.Generic.List[string]]::new()
        if (-not $exists) { $queries.Add('CREATE TABLE `CustomAction` (`Action` CHAR(72) NOT NULL, `Type` SHORT NOT NULL, `Source` CHAR(72), `Target` CHAR(255) LOCALIZABLE PRIMARY KEY `Action`)') }
        $queries.Add("INSERT INTO ``CustomAction`` (``Action``, ``Type``, ``Target``) VALUES ('FixtureFailure', 19, 'Deliberate fixture failure after old product removal')")
        $queries.Add("INSERT INTO ``InstallExecuteSequence`` (``Action``, ``Sequence``) VALUES ('FixtureFailure', 4001)")
        foreach ($query in $queries) {
            $view = Invoke-ComMethod $db 'OpenView' @($query)
            try { Invoke-ComMethod $view 'Execute' @() | Out-Null; Invoke-ComMethod $view 'Close' @() | Out-Null }
            finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) | Out-Null }
        }
        $summary = $db.GetType().InvokeMember('SummaryInformation', [Reflection.BindingFlags]::GetProperty, $null, $db, @(1))
        try {
            $summary.GetType().InvokeMember('Property', [Reflection.BindingFlags]::SetProperty, $null, $summary, @(9, ('{' + [guid]::NewGuid().ToString().ToUpperInvariant() + '}'))) | Out-Null
            Invoke-ComMethod $summary 'Persist' @() | Out-Null
        } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($summary) | Out-Null }
        Invoke-ComMethod $db 'Commit' @() | Out-Null
    } finally {
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($db) | Out-Null
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) | Out-Null
    }
}
try {
    $oldPath = Join-Path $fixture $old.package; $newPath = Join-Path $fixture $new.package
    $failedPackage = Join-Path $evidence 'deliberately-failing-fixture.msi'
    New-FailingFixture $newPath $failedPackage
    New-Item -ItemType Directory -Path $target | Out-Null
    [IO.File]::WriteAllText((Join-Path $target 'foreign-sentinel.txt'), 'retain foreign fixture')
    $script:foreignHash = (Get-FileHash -LiteralPath (Join-Path $target 'foreign-sentinel.txt') -Algorithm SHA256).Hash.ToLowerInvariant()
    Invoke-Msi 'reject-existing-directory' $oldPath $true 1603
    if ((Get-Content -LiteralPath (Join-Path $evidence 'reject-existing-directory.log') -Raw) -notmatch 'A fresh candidate directory is required') { throw 'Missing directory refusal evidence' }
    Assert-Registered $old $false; Assert-Inventory $null $true
    Move-Item -LiteralPath $target -Destination "$target.retained-before"
    Invoke-Msi 'install-old' $oldPath $true 0
    Assert-Registered $old $true; Assert-Inventory $old $false
    [IO.File]::WriteAllText((Join-Path $target 'foreign-sentinel.txt'), 'retain foreign fixture')
    Invoke-Msi 'failed-upgrade-rollback' $failedPackage $true 1603
    Assert-Registered $old $true; Assert-Registered $new $false; Assert-Inventory $old $true
    $failureLog = Get-Content -LiteralPath (Join-Path $evidence 'failed-upgrade-rollback.log') -Raw
    if ($failureLog -notmatch '(?m)^Action ended [^\r\n]+: RemoveExistingProducts\. Return value 1\.' -or $failureLog -notmatch '(?m)^Action ended [^\r\n]+: FixtureFailure\. Return value 3\.' -or $failureLog -notmatch 'Rollback') { throw 'Missing transaction/rollback log evidence' }
    Invoke-Msi 'upgrade' $newPath $true 0
    Assert-Registered $old $false; Assert-Registered $new $true; Assert-Inventory $new $true
    Invoke-Msi 'reject-downgrade' $oldPath $true 1603
    if ((Get-Content -LiteralPath (Join-Path $evidence 'reject-downgrade.log') -Raw) -notmatch 'Same or newer version is already installed') { throw 'Missing downgrade refusal evidence' }
    Assert-Registered $old $false; Assert-Registered $new $true; Assert-Inventory $new $true
    Invoke-Msi 'uninstall' $newPath $false 0
    Assert-Registered $new $false; Assert-Inventory $null $true
    Move-Item -LiteralPath $target -Destination "$target.retained-after"
    Invoke-Msi 'reinstall' $newPath $true 0
    Assert-Registered $new $true; Assert-Inventory $new $false
    Invoke-Msi 'final-uninstall' $newPath $false 0
    Assert-Registered $new $false; Assert-Inventory $null $false
    $result.nativeFixturePassed = $true
} catch {
    $result['error'] = $_.Exception.Message
    throw
} finally {
    $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidence 'native-result.json') -Encoding utf8
}
