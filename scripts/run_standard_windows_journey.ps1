param(
  [Parameter(Mandatory)][string]$Plan,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$PlanSha,
  [Parameter(Mandatory)][string]$Evidence,
  [switch]$Rollback,
  [switch]$Child
)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -and -not $Child) { throw 'Disposable GitHub-hosted Windows required' }
if ($Child) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Standard Windows account required' }
  $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
  $env:TEMP = $Evidence
  $env:TMP = $Evidence
  @{ standardUserAcceptance=$true; isAdministrator=$false; accountSid=$identity.User.Value; os=[Environment]::OSVersion.VersionString } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Evidence 'standard-context.json')
  $arguments = @('tests/desktop-installed-product-journey.mjs','--plan',$Plan,'--expected-plan-sha256',$PlanSha,'--execute-in-disposable-windows')
  if ($Rollback) { $arguments += '--exercise-product-rollback' }
  & node @arguments
  exit $LASTEXITCODE
}
$name = 'localapi' + [guid]::NewGuid().ToString('N').Substring(0,10)
$password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA9!') -AsPlainText -Force
$account = New-LocalUser -Name $name -Password $password -Description 'Disposable workbench lifecycle test'
try {
  $users = Get-LocalGroup -SID 'S-1-5-32-545'
  if (-not (Get-LocalGroupMember $users | Where-Object SID -eq $account.SID)) { Add-LocalGroupMember -Group $users -Member $account }
  New-Item -Type Directory -Path $Evidence -ErrorAction Stop | Out-Null
  foreach ($directory in @((Split-Path $Plan), $PWD.Path)) {
    & icacls $directory /grant ("*" + $account.SID.Value + ':(OI)(CI)RX') | Out-Null
    if ($LASTEXITCODE) { throw 'Cannot grant fixture read access' }
  }
  & icacls $Evidence /grant ("*" + $account.SID.Value + ':(OI)(CI)M') | Out-Null
  if ($LASTEXITCODE) { throw 'Cannot grant evidence write access' }
  $credential = [PSCredential]::new(("$env:COMPUTERNAME\" + $name),$password)
  $arguments = @('-NoProfile','-NonInteractive','-File',('"' + $PSCommandPath + '"'),'-Child',
    '-Plan',('"' + $Plan + '"'),'-PlanSha',$PlanSha,'-Evidence',('"' + $Evidence + '"'))
  if ($Rollback) { $arguments += '-Rollback' }
  $process = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList $arguments -Credential $credential -LoadUserProfile -Wait -PassThru -WindowStyle Hidden -WorkingDirectory $PWD.Path
  if ($process.ExitCode -ne 0) { throw "Standard-user installed journey failed ($($process.ExitCode))" }
} finally { Remove-LocalUser -SID $account.SID }
