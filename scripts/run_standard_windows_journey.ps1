param(
  [Parameter(Mandatory)][string]$Plan,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$PlanSha,
  [Parameter(Mandatory)][string]$Evidence,
  [string]$Node,
  [switch]$Rollback,
  [switch]$Child
)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -and -not $Child) { throw 'Disposable GitHub-hosted Windows required' }
if ($Child) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Standard Windows account required' }
  # Start-Process loads this account's registry hive but can inherit the runner's
  # environment. Resolve the fresh profile by its logged-in SID before expanding paths.
  $profileKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($identity.User.Value)"
  $env:USERPROFILE = (Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath).ProfileImagePath
  if (-not [IO.Path]::IsPathFullyQualified($env:USERPROFILE) -or -not [IO.Directory]::Exists($env:USERPROFILE)) { throw 'Standard account profile was not loaded' }
  $env:USERDOMAIN, $env:USERNAME = $identity.Name -split '\\', 2
  $env:HOMEDRIVE = [IO.Path]::GetPathRoot($env:USERPROFILE).TrimEnd('\')
  $env:HOMEPATH = $env:USERPROFILE.Substring($env:HOMEDRIVE.Length)
  $env:APPDATA = Join-Path $env:USERPROFILE 'AppData\Roaming'
  $local = Join-Path $env:USERPROFILE 'AppData\Local'
  [IO.Directory]::CreateDirectory($env:APPDATA) | Out-Null
  [IO.Directory]::CreateDirectory($local) | Out-Null
  $resolvedLocal = & $Node -p "require('node:fs').realpathSync.native(process.argv[1])" $local
  if ($LASTEXITCODE -ne 0 -or -not $resolvedLocal) { throw 'Local user profile could not be verified' }
  $env:LOCALAPPDATA = $resolvedLocal.Trim()
  $env:TEMP = $Evidence
  $env:TMP = $Evidence
  $context = @{ standardUserAcceptance=$false; isAdministrator=$false; accountSid=$identity.User.Value; userProfile=$env:USERPROFILE; localAppData=$env:LOCALAPPDATA; os=[Environment]::OSVersion.VersionString; node=(& $Node -v) }
  $record = Join-Path $Evidence 'standard-context.json'
  $context | ConvertTo-Json | Set-Content -LiteralPath $record
  $arguments = @('tests/desktop-installed-product-journey.mjs','--plan',$Plan,'--expected-plan-sha256',$PlanSha,'--execute-in-disposable-windows')
  if ($Rollback) { $arguments += '--exercise-product-rollback' }
  & $Node @arguments
  $code = $LASTEXITCODE
  $context.standardUserAcceptance = $code -eq 0
  $context | ConvertTo-Json | Set-Content -LiteralPath $record
  exit $code
}
$name = 'localapi' + [guid]::NewGuid().ToString('N').Substring(0,10)
$password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA9!') -AsPlainText -Force
$account = New-LocalUser -Name $name -Password $password -Description 'Disposable workbench lifecycle test'
try {
  $scratch = (New-Item -Type Directory -Path (Join-Path $env:SystemDrive ('LocalAPIJourney-' + [guid]::NewGuid()))).FullName
  $bundle = Join-Path $scratch 'bundle'
  Copy-Item -LiteralPath (Split-Path $Plan) -Destination $bundle -Recurse
  $Plan = Join-Path $bundle 'product-plan.json'
  $childEvidence = (New-Item -Type Directory -Path (Join-Path $scratch 'evidence')).FullName
  $users = Get-LocalGroup -SID 'S-1-5-32-545'
  if (-not (Get-LocalGroupMember $users | Where-Object SID -eq $account.SID)) { Add-LocalGroupMember -Group $users -Member $account }
  New-Item -Type Directory -Path $Evidence -ErrorAction Stop | Out-Null
  foreach ($directory in @($scratch, $PWD.Path)) {
    & icacls $directory /grant ("*" + $account.SID.Value + ':(OI)(CI)RX') | Out-Null
    if ($LASTEXITCODE) { throw 'Cannot grant fixture read access' }
  }
  & icacls $childEvidence /grant ("*" + $account.SID.Value + ':(OI)(CI)M') | Out-Null
  if ($LASTEXITCODE) { throw 'Cannot grant evidence write access' }
  $credential = [PSCredential]::new(("$env:COMPUTERNAME\" + $name),$password)
  $nodePath = (& node -p 'process.execPath').Trim()
  if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($nodePath)) { throw 'Cannot locate the selected Node runtime' }
  $arguments = @('-NoProfile','-NonInteractive','-File',('"' + $PSCommandPath + '"'),'-Child',
    '-Plan',('"' + $Plan + '"'),'-PlanSha',$PlanSha,'-Evidence',('"' + $childEvidence + '"'),
    '-Node',('"' + $nodePath + '"'))
  if ($Rollback) { $arguments += '-Rollback' }
  $process = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList $arguments -Credential $credential -LoadUserProfile -Wait -PassThru -WindowStyle Hidden -WorkingDirectory $PWD.Path -RedirectStandardOutput (Join-Path $childEvidence 'child-stdout.log') -RedirectStandardError (Join-Path $childEvidence 'child-stderr.log')
  if ($process.ExitCode -ne 0) { throw "Standard-user installed journey failed ($($process.ExitCode))" }
} finally {
  if ($childEvidence -and (Test-Path -LiteralPath $childEvidence)) {
    foreach ($entry in Get-ChildItem -LiteralPath $childEvidence) {
      if ($entry.Name -like 'installed-product-journey-*') {
        $artifacts = Join-Path $entry.FullName 'evidence'
        if (Test-Path -LiteralPath $artifacts) {
          $dest = New-Item -ItemType Directory -Path (Join-Path $Evidence $entry.Name) -Force
          Copy-Item -LiteralPath $artifacts -Destination $dest.FullName -Recurse
        }
      } elseif ($entry.Name -in @('standard-context.json','child-stdout.log','child-stderr.log')) {
        Copy-Item -LiteralPath $entry.FullName -Destination $Evidence
        if ($entry.Extension -eq '.log') { Get-Content -LiteralPath $entry.FullName -Tail 35 }
      }
    }
  }
  Remove-LocalUser -SID $account.SID
}
