$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/windows_standard_user.ps1')
function New-Receipt {
    return @{ observationComplete=$true; errors=@(); os=@{caption='Microsoft Windows 11 Pro';version='10.0.26100';build=26100;productType=1};uac=@{kind='DWord';enableLUA=1};
        token=@{tokenType=1;elevationType=1;elevated=0;hasRestrictions=0;integritySid='S-1-16-8192';sessionId=1;userSid='S-1-5-21-111-222-333-1001';groups=@(@{sid='S-1-5-4';attributes=7},@{sid='S-1-5-32-545';attributes=7})};
        localAccount=@{sid='S-1-5-21-111-222-333-1001';enabled=$true};administratorMemberSids=@('S-1-5-21-111-222-333-500') }
}
Assert-Windows11StandardUserReceipt (New-Receipt)
$changes=@(
    {$args[0].observationComplete=$false}, {$args[0].errors=@('query failed')}, {$args[0].os=$null},
    {$args[0].os.caption='Microsoft Windows Server 2025 Datacenter';$args[0].os.productType=3},
    {$args[0].os.caption='Microsoft Windows 10 Pro';$args[0].os.build=19045;$args[0].os.version='10.0.19045'},
    {$args[0].os.version='10.0.22000'}, {$args[0].uac.enableLUA=0}, {$args[0].uac.enableLUA=$null}, {$args[0].uac.kind='String'},
    {$args[0].token.elevationType=2}, {$args[0].token.elevationType=3}, {$args[0].token.elevated=1}, {$args[0].token.hasRestrictions=1},
    {$args[0].token.tokenType=2}, {$args[0].token.integritySid='S-1-16-12288'}, {$args[0].token.sessionId=0},
    {$args[0].token.userSid='S-1-5-18'}, {$args[0].localAccount.sid='other'}, {$args[0].localAccount.enabled=$false},
    {$args[0].administratorMemberSids=@($args[0].token.userSid)}, {$args[0].administratorMemberSids=$null},
    {$args[0].token.groups+=@{sid='S-1-5-32-544';attributes=7}},
    {$args[0].token.groups+=@{sid='S-1-5-32-544';attributes=16}},
    {$args[0].token.groups+=@{sid='S-1-5-6';attributes=7}}, {$args[0].token.groups+=@{sid='S-1-5-3';attributes=7}},
    {$args[0].token.groups=@()}, {$args[0].token.groups[0].attributes=16}, {$args[0].token.groups[0].attributes=$null},
    {$args[0].token.elevationType=$null}, {$args[0].token.hasRestrictions=$null}
)
foreach($change in $changes) {
    $receipt=New-Receipt; & $change $receipt
    $rejected=$false
    try { Assert-Windows11StandardUserReceipt $receipt } catch { $rejected=$true }
    if(-not $rejected) { throw "Unsafe/missing observation accepted: $change" }
}
Write-Output "Standard-user preflight: $($changes.Count+1) mocked cases passed; native API never queried"
$good=New-Receipt
$good['hostedRunner']=$false
$public=ConvertTo-WindowsStandardUserEvidence $good
if(-not $public.preflightPassed -or $public.standardUserTesting -cne 'pending') { throw 'Preflight falsely claims full acceptance' }
$json=$public | ConvertTo-Json -Depth 8 -Compress
foreach($private in @($good.token.userSid,$good.administratorMemberSids[0],'tokenGroupSids','administratorMemberSids','S-1-5-32-545','"groups"')) {
    if($json.Contains($private)) { throw 'Private account/group evidence leaked' }
}
$admin=New-Receipt; $admin['hostedRunner']=$true
$admin.token.groups+=@{sid='S-1-5-32-544';attributes=16}
$filtered=ConvertTo-WindowsStandardUserEvidence $admin
if($filtered.preflightPassed -or -not $filtered.token.administratorSidDenyOnly -or -not $filtered.hostedRunner) { throw 'Filtered hosted administrator misclassified' }
Write-Output 'Public evidence redaction and pending-acceptance cases passed'
$denied=New-Receipt; $denied['hostedRunner']=$false
$denied.observationComplete=$false; $denied.errors=@('CimException'); $denied.administratorMemberSids=$null
$unknown=ConvertTo-WindowsStandardUserEvidence $denied
if($unknown.preflightPassed -or $null -ne $unknown.token.accountInAdministrators) { throw 'Missing membership evidence treated as known absence' }
Write-Output 'Missing-membership evidence remains unknown; all 34 mocked cases passed'
$privateError='CIM failed for SECRET_HOST and Get-LocalUser SECRET_ACCOUNT S-1-5-21-999-888-777-1001'
$unsafe=New-Receipt; $unsafe['hostedRunner']=$false; $unsafe.observationComplete=$false; $unsafe.errors=@($privateError)
$sanitized=ConvertTo-WindowsStandardUserEvidence $unsafe
$sanitizedJson=$sanitized | ConvertTo-Json -Depth 8 -Compress
if($sanitizedJson.Contains('SECRET_') -or $sanitizedJson.Contains($privateError) -or $sanitized.queryErrors[0] -cne 'NATIVE_OBSERVATION_UNAVAILABLE') { throw 'Raw upstream exception text leaked' }
$malformed=New-Receipt; $malformed['hostedRunner']=$false; $malformed.Remove('token')
$fallback=ConvertTo-WindowsStandardUserEvidence $malformed
if($fallback.preflightPassed -or $fallback.rejection -cne 'Windows 11 standard-user requirements not verified') { throw 'Malformed assertion did not use fixed fallback' }
Write-Output 'Raw exception injection and malformed assertion sanitization cases passed'
