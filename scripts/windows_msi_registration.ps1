# Query Windows Installer's supported current-user API, not a guessed ARP registry path.
if (-not ('LocalApiMsiRegistration.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace LocalApiMsiRegistration {
    public sealed class PropertyResult {
        public uint ErrorCode { get; set; }
        public string Value { get; set; }
    }
    public static class Native {
        [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
        private static extern uint MsiEnumRelatedProductsW(string upgradeCode, uint reserved, uint index, StringBuilder product);
        public static string[] RelatedProducts(string family) {
            var codes = new System.Collections.Generic.List<string>();
            for (uint i = 0; ; i++) {
                var code = new StringBuilder(39);
                uint rc = MsiEnumRelatedProductsW(family, 0, i, code);
                if (rc == 259) return codes.ToArray();
                if (rc != 0) throw new InvalidOperationException("Cannot enumerate MSI product family: " + rc);
                codes.Add(code.ToString());
            }
        }
        [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
        private static extern uint MsiGetProductInfoExW(string productCode, string userSid,
            uint context, string property, StringBuilder value, ref uint length);
        public static PropertyResult QueryCurrentUser(string productCode, uint context, string property) {
            var value = new StringBuilder(1024);
            uint length = (uint)value.Capacity;
            // NULL is the current user for user contexts and is required for machine context.
            uint error = MsiGetProductInfoExW(productCode, null, context, property, value, ref length);
            return new PropertyResult { ErrorCode=error, Value=error == 0 ? value.ToString() : null };
        }
    }
}
'@
}
function Read-MsiProductRegistration([string]$ProductCode) {
    if (-not $IsWindows) { throw 'Native Windows registration query required' }
    $code = '{' + [guid]::Parse($ProductCode).ToString().ToUpperInvariant() + '}'
    $contexts = @(
        foreach ($context in @(1, 2, 4)) {
            $state = [LocalApiMsiRegistration.Native]::QueryCurrentUser($code, $context, 'State')
            $version = $null
            if ($state.ErrorCode -eq 0 -and $context -eq 2) {
                $version = [LocalApiMsiRegistration.Native]::QueryCurrentUser($code, $context, 'VersionString')
            }
            [ordered]@{ context=$context; stateError=[int]$state.ErrorCode; state=$state.Value;
                versionError=if ($null -ne $version) { [int]$version.ErrorCode } else { $null };
                version=if ($null -ne $version) { $version.Value } else { $null } }
        }
    )
    return [ordered]@{ productCode=$code; queryScope='current-user-and-machine'; currentUserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; contexts=$contexts }
}
function Assert-MsiRegistrationReceipt($Receipt, [string]$Version, [bool]$Expected, [switch]$AllowAdvertised) {
    $contexts = @($Receipt.contexts)
    if ($contexts.Count -ne 3 -or (@($contexts | ForEach-Object { $_.context } | Sort-Object) -join ',') -ne '1,2,4') { throw 'Incomplete MSI context observation' }
    foreach ($entry in $contexts) {
        if ($entry.context -eq 2 -and $Expected) {
            if ($AllowAdvertised -and $entry.stateError -eq 0 -and $entry.state -eq '1' -and
                (($entry.versionError -eq 1608 -and -not $entry.version) -or ($entry.versionError -eq 0 -and $entry.version -eq $Version))) { continue }
            if ($entry.stateError -ne 0 -or $entry.state -ne '5' -or $entry.versionError -ne 0 -or $entry.version -ne $Version) {
                throw "Expected current-user unmanaged installed product $Version; observed $($entry | ConvertTo-Json -Compress)"
            }
        } elseif ($entry.stateError -ne 1605) {
            # Only ERROR_UNKNOWN_PRODUCT proves absence. Access/errors and advertised products fail.
            throw "Unexpected MSI registration/query result in context $($entry.context): $($entry | ConvertTo-Json -Compress)"
        }
    }
}
function Assert-MsiProductRegistration([string]$ProductCode, [string]$Version, [bool]$Expected) {
    $receipt = Read-MsiProductRegistration $ProductCode
    Assert-MsiRegistrationReceipt $receipt $Version $Expected
    return $receipt
}
