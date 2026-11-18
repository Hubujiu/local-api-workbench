$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/windows_release_predecessor.ps1')
$current='A'*40; $old='B'*40
$receipt=@{schema='localapi-signed-windows-release-acceptance-v2';signedLifecyclePassed=$true;version='0.1.0';publisher=$old;sha256=('a'*64);manifestSha256=('b'*64);head=('c'*40)}
$rotation=@{schema='localapi-publisher-rotation-v1';previousVersion='0.1.0';previousPublisher=$old;currentPublisher=$current}
if ((Get-PreviousPublisher '0.1.0' $current $current '') -ne $current) { throw 'Same publisher rejected' }
if ((Get-PreviousPublisher '0.1.0' $old $current ($rotation|ConvertTo-Json)) -ne $old) { throw 'Exact authorized rotation rejected' }
function Reject($Test) { $failed=$false;try { & $Test | Out-Null }catch{$failed=$true};if(-not $failed){throw "Unsafe predecessor accepted: $Test"} }
foreach($bad in @('', '{}','[]','not json')) { Reject { Get-PreviousPublisher '0.1.0' $old $current $bad } }
foreach($key in @('schema','previousVersion','previousPublisher','currentPublisher')) {
  $bad=$rotation.Clone();$bad[$key]='wrong';Reject { Get-PreviousPublisher '0.1.0' $old $current ($bad|ConvertTo-Json) }
}
$bad=$rotation.Clone();$bad.extra=$true;Reject { Get-PreviousPublisher '0.1.0' $old $current ($bad|ConvertTo-Json) }
Assert-ReleaseReceipt ([pscustomobject]$receipt) '0.1.0' ('a'*64) $old
foreach($key in @('version','sha256','publisher','manifestSha256','head')) {
  $bad=$receipt.Clone();$bad[$key]='wrong';Reject { Assert-ReleaseReceipt ([pscustomobject]$bad) '0.1.0' ('a'*64) $old }
}
# A self-asserted receipt cannot authorize a different certificate.
Reject { Get-PreviousPublisher $receipt.version $receipt.publisher $current '' }
$temp=Join-Path ([IO.Path]::GetTempPath()) ('publisher-test-'+[guid]::NewGuid())
try {
  [IO.File]::WriteAllText($temp,($receipt|ConvertTo-Json))
  $sha=(Get-FileHash -LiteralPath $temp).Hash
  Read-PinnedReleaseReceipt $temp $sha | Out-Null
  Reject { Read-PinnedReleaseReceipt $temp ('0'*64) }
  [IO.File]::WriteAllText($temp,(' '*1048577))
  Reject { Read-PinnedReleaseReceipt $temp (Get-FileHash -LiteralPath $temp).Hash }
} finally { Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue }
$signature=Get-Content (Join-Path $PSScriptRoot '../scripts/windows-release-signature.ps1') -Raw
if (-not $signature.Contains('$Sign -and $ExpectedPublisher') -or -not $signature.Contains('verify /pa /v /all')) { throw 'Signing override or trust verification regressed' }
Write-Output 'Publisher rotation, pin, malformed receipt and signing-boundary mocks passed; no signatures or installations executed'

$signature=@{Status='Valid';SignerCertificate=@{Thumbprint=$old};TimeStamperCertificate=@{}}
# A non-null certificate object (rather than an empty hashtable) models the timestamp.
$signature.TimeStamperCertificate=[pscustomobject]@{Subject='timestamp'}
Assert-PinnedAuthenticode $signature $old
Reject { Assert-PinnedAuthenticode $signature $current }
$signature.Status='NotTrusted';Reject { Assert-PinnedAuthenticode $signature $old }
$signature.Status='Valid';$signature.TimeStamperCertificate=$null;Reject { Assert-PinnedAuthenticode $signature $old }
Write-Output 'Unexpected signer, untrusted signature and absent timestamp rejected'

foreach($schema in @('localapi-signed-windows-release-acceptance-v1','localapi-signed-windows-release-acceptance-v2')) {
  $good=$receipt.Clone();$good.schema=$schema;Assert-ReleaseReceipt ([pscustomobject]$good) '0.1.0' ('a'*64) $old
}
foreach($key in @('schema','version','sha256','publisher','manifestSha256','head','signedLifecyclePassed')) {
  $bad=$receipt.Clone();$bad[$key]=@($bad[$key]);Reject { Assert-ReleaseReceipt ([pscustomobject]$bad) '0.1.0' ('a'*64) $old }
}
$bad=$receipt.Clone();$bad.signedLifecyclePassed='true';Reject { Assert-ReleaseReceipt ([pscustomobject]$bad) '0.1.0' ('a'*64) $old }
Reject { Get-PreviousPublisher '0.1.0' $old $current ('['+($rotation|ConvertTo-Json)+']') }
foreach($key in @('schema','previousVersion','previousPublisher','currentPublisher')) {
  $bad=$rotation.Clone();$bad[$key]=@($bad[$key]);Reject { Get-PreviousPublisher '0.1.0' $old $current ($bad|ConvertTo-Json) }
}
Assert-PreviousArguments @{}
$all=@{PreviousMedia='a';PreviousVersion='b';PreviousVerification='c';PreviousReceiptSha='d';PreviousMediaSha='e';PreviousHead='f'}
Assert-PreviousArguments $all
foreach($key in @($all.Keys)) { $bad=$all.Clone();$bad.Remove($key);Reject { Assert-PreviousArguments $bad } }
Reject { Assert-PreviousArguments @{PreviousVersion='0.1.0'} }
try {
  [IO.File]::WriteAllText($temp,('['+($receipt|ConvertTo-Json)+']'))
  Reject { Read-PinnedReleaseReceipt $temp (Get-FileHash -LiteralPath $temp).Hash }
} finally { Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue }
Write-Output 'Single-object, strict-type/schema and partial predecessor argument negatives passed'
try {
  [IO.File]::WriteAllText($temp,'inert data; never a signing input')
  $blocked=$false
  try { & (Join-Path $PSScriptRoot '../scripts/windows-release-signature.ps1') -File $temp -Sign -ExpectedPublisher $old }
  catch { $blocked=($_.Exception.Message -ceq 'Signing cannot override configured publisher') }
  if (-not $blocked) { throw 'Sign override did not fail before SDK/signing access' }
} finally { Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue }
Write-Output 'Actual signing-entry override rejected before SDK discovery or signing'
