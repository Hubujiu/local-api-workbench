# Receipt contents bind artifacts, never establish publisher trust by themselves.
function Assert-ReleaseReceiptShape($Receipt) {
    if ($null -eq $Receipt -or $Receipt.GetType() -ne [System.Management.Automation.PSCustomObject]) { throw 'Single receipt object required' }
    foreach ($key in @('schema','version','sha256','publisher','manifestSha256','head')) {
        if ($Receipt.$key -isnot [string]) { throw 'Receipt string fields required' }
    }
    if ($Receipt.schema -cnotin @('localapi-signed-windows-release-acceptance-v1','localapi-signed-windows-release-acceptance-v2') -or $Receipt.signedLifecyclePassed -isnot [bool] -or $Receipt.signedLifecyclePassed -cne $true) { throw 'Recognized completed signed lifecycle receipt required' }
}
function Assert-PreviousArguments($Arguments) {
    $names=@('PreviousMedia','PreviousVersion','PreviousVerification','PreviousReceiptSha','PreviousMediaSha','PreviousHead')
    $present=@($names | Where-Object { $Arguments.ContainsKey($_) })
    if ($present.Count -eq 0) { return }
    if ($present.Count -ne $names.Count) { throw 'All predecessor pins required together' }
    foreach($name in $names) { if ($Arguments[$name] -isnot [string] -or [string]::IsNullOrWhiteSpace($Arguments[$name])) { throw 'Nonempty predecessor pins required' } }
}
function Assert-ReleaseReceipt($Receipt, [string]$Version, [string]$MediaSha, [string]$Publisher) {
    Assert-ReleaseReceiptShape $Receipt
    if ($Version -notmatch '^\d+\.\d+\.\d+$' -or $MediaSha -notmatch '^[a-fA-F0-9]{64}$' -or $Publisher -notmatch '^[a-fA-F0-9]{40}$') { throw 'Explicit version, media digest and publisher pins required' }
    if ($Receipt.version -cne $Version -or $Receipt.sha256 -ine $MediaSha -or $Receipt.publisher -ine $Publisher -or $Receipt.manifestSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $Receipt.head -notmatch '^[a-f0-9]{40}$') { throw 'Published receipt does not match independent pins' }
}
function Get-PreviousPublisher([string]$Version, [string]$ReceiptPublisher, [string]$CurrentPublisher, [string]$Rotation) {
    if ($CurrentPublisher -notmatch '^[a-fA-F0-9]{40}$' -or $ReceiptPublisher -notmatch '^[a-fA-F0-9]{40}$') { throw 'Publisher pins required' }
    if ($ReceiptPublisher -ieq $CurrentPublisher) { return $CurrentPublisher }
    try {
        $approval = $Rotation | ConvertFrom-Json -NoEnumerate -ErrorAction Stop
        if ($null -eq $approval -or $approval.GetType() -ne [System.Management.Automation.PSCustomObject]) { throw 'Single rotation object required' }
        foreach ($key in @('schema','previousVersion','previousPublisher','currentPublisher')) { if ($approval.$key -isnot [string]) { throw 'Rotation strings required' } }
        if (@($approval.PSObject.Properties).Count -ne 4 -or $approval.schema -cne 'localapi-publisher-rotation-v1' -or $approval.previousVersion -cne $Version -or $approval.previousPublisher -ine $ReceiptPublisher -or $approval.currentPublisher -ine $CurrentPublisher) { throw 'Mismatch' }
    } catch { throw 'Explicit version-bound publisher rotation authorization required' }
    return $ReceiptPublisher
}
function Read-PinnedReleaseReceipt([string]$File, [string]$Sha256) {
    if ((Get-Item -LiteralPath $File).Length -gt 1048576) { throw 'Published receipt size limit exceeded' }
    if ($Sha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ine $Sha256) { throw 'Published receipt digest mismatch' }
    $receipt = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json -NoEnumerate -ErrorAction Stop
    Assert-ReleaseReceiptShape $receipt
    return $receipt
}
function Assert-PinnedAuthenticode($Signature, [string]$Publisher) {
    if ($Publisher -notmatch '^[a-fA-F0-9]{40}$' -or $Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Thumbprint -ine $Publisher -or -not $Signature.TimeStamperCertificate) { throw 'Publisher, trust chain or timestamp mismatch' }
}
