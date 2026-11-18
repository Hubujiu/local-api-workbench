. (Join-Path $PSScriptRoot 'windows_msi_policy.ps1')
# Read-only observation. Never creates accounts, filters tokens, or changes OS policy.
if (-not ('LocalApiStandardUser.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
namespace LocalApiStandardUser {
    public sealed class Group { public string sid; public uint attributes; }
    public sealed class Token {
        public string userSid, integritySid;
        public int tokenType, elevationType, elevated, hasRestrictions, sessionId;
        public Group[] groups;
    }
    public static class Native {
        [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
        [StructLayout(LayoutKind.Sequential)] struct GroupsHead { public uint Count; public SidAttributes First; }
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int length, out int needed);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        static IntPtr Query(IntPtr token, int kind) { int length; return Query(token,kind,out length); }
        static IntPtr Query(IntPtr token, int kind, out int length) {
            int size;
            if (GetTokenInformation(token,kind,IntPtr.Zero,0,out size) || Marshal.GetLastWin32Error()!=122 || size<4 || size>1048576)
                throw new InvalidOperationException("Invalid token query size");
            int allocated=size;
            IntPtr buffer=Marshal.AllocHGlobal(size);
            if (!GetTokenInformation(token,kind,buffer,size,out size)) {
                int error=Marshal.GetLastWin32Error(); Marshal.FreeHGlobal(buffer); throw new Win32Exception(error);
            }
            if(size<4 || size>allocated) { Marshal.FreeHGlobal(buffer); throw new InvalidOperationException("Invalid token result size"); }
            length=size;
            return buffer;
        }
        static int Integer(IntPtr token,int kind) { IntPtr b=Query(token,kind); try{return Marshal.ReadInt32(b);}finally{Marshal.FreeHGlobal(b);} }
        static string Sid(IntPtr token,int kind) { IntPtr b=Query(token,kind); try{return new SecurityIdentifier(Marshal.ReadIntPtr(b)).Value;}finally{Marshal.FreeHGlobal(b);} }
        public static Token Read() {
            IntPtr token;
            // Pseudo handle -1 is this process; TOKEN_QUERY is read-only.
            if (!OpenProcessToken(new IntPtr(-1),8,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                var value=new Token {userSid=Sid(token,1), tokenType=Integer(token,8),sessionId=Integer(token,12),
                    elevationType=Integer(token,18),elevated=Integer(token,20),hasRestrictions=Integer(token,21),integritySid=Sid(token,25)};
                int length;
                IntPtr buffer=Query(token,2,out length);
                try {
                    int count=Marshal.ReadInt32(buffer), offset=Marshal.OffsetOf<GroupsHead>("First").ToInt32(), stride=Marshal.SizeOf<SidAttributes>();
                    if(count<1 || count>4096 || (long)offset+(long)count*stride>length) throw new InvalidOperationException("Invalid token group count");
                    value.groups=new Group[count];
                    for(int i=0;i<count;i++) {
                        var group=Marshal.PtrToStructure<SidAttributes>(IntPtr.Add(buffer,offset+i*stride));
                        // Keep EVERY group and raw attributes, including SE_GROUP_USE_FOR_DENY_ONLY.
                        value.groups[i]=new Group {sid=new SecurityIdentifier(group.Sid).Value,attributes=group.Attributes};
                    }
                } finally {Marshal.FreeHGlobal(buffer);}
                return value;
            } finally {CloseHandle(token);}
        }
    }
}
'@
}
function Assert-Windows11StandardUserReceipt($Receipt) {
    if ($Receipt.observationComplete -cne $true -or @($Receipt.errors).Count -ne 0) { throw 'Complete native observation required' }
    $os = $Receipt.os; $token = $Receipt.token
    if ($null -eq $os -or $os.productType -ne 1 -or $os.caption -notmatch '\bWindows 11\b' -or $os.version -notmatch '^10\.0\.\d+$' -or $os.build -lt 22000 -or ([version]$os.version).Build -ne $os.build) { throw 'Verified Windows 11 workstation required, not hosted Windows Server' }
    if ($os.nativeArchitecture -cne 'X64') { throw 'Native x64 Windows required; emulated or unknown OS architecture refused' }
    Assert-MsiPolicyForStandardUser $Receipt.installerPolicy
    if ($Receipt.uac.kind -cne 'DWord' -or $Receipt.uac.enableLUA -ne 1) { throw 'UAC EnableLUA DWORD 1 required' }
    if ($token.tokenType -ne 1 -or $token.elevationType -ne 1 -or $token.elevated -ne 0 -or $token.hasRestrictions -ne 0 -or $token.integritySid -cne 'S-1-16-8192') { throw 'Primary medium-integrity standard token required; elevated/filtered/restricted administrator refused' }
    if ($token.sessionId -lt 1 -or $token.userSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or $token.userSid -match '-50[01]$') { throw 'Ordinary interactive account required' }
    if ($Receipt.localAccount.sid -cne $token.userSid -or $Receipt.localAccount.enabled -cne $true -or $null -eq $Receipt.administratorMemberSids) { throw 'Enabled genuine local account and complete membership observation required' }
    $groups = @($token.groups)
    if ($groups.Count -lt 1) { throw 'Native token groups missing' }
    foreach ($group in $groups) {
        if ($null -eq $group.attributes -or $group.sid -notmatch '^S-1-\d+(?:-\d+)+$') { throw 'Incomplete native token group' }
        if ($group.sid -in @('S-1-5-32-544','S-1-5-3','S-1-5-6')) { throw 'Administrator (including deny-only), batch, or service token refused' }
    }
    if ($token.userSid -in $Receipt.administratorMemberSids) { throw 'Account belongs to Administrators' }
    $interactive = @($groups | Where-Object { $_.sid -eq 'S-1-5-4' -and ($_.attributes -band 4) -ne 0 -and ($_.attributes -band 16) -eq 0 })
    if ($interactive.Count -ne 1) { throw 'Enabled native INTERACTIVE group required' }
}
function Read-WindowsStandardUserReceipt {
    $receipt = [ordered]@{ observationComplete=$false; errors=@(); os=$null; uac=$null; token=$null; installerPolicy=$null; localAccount=$null; administratorMemberSids=$null;
        hostedRunner=($env:GITHUB_ACTIONS -eq 'true'); standardUserTesting='pending' }
    try {
        if (-not $IsWindows) { throw 'Native Windows required' }
        # OSArchitecture handles Windows emulation correctly starting with .NET 7.
        if ([Environment]::Version.Major -lt 7) { throw 'Modern native architecture observation unavailable' }
        $receipt.installerPolicy = Read-WindowsMsiPolicy
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        if (@($os).Count -ne 1) { throw 'Ambiguous OS observation' }
        $receipt.os = @{ caption=$os.Caption; version=$os.Version; build=[int]$os.BuildNumber; productType=[int]$os.ProductType; nativeArchitecture=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
        $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System', $false)
        if ($null -eq $key) { throw 'UAC policy unavailable' }
        try { $receipt.uac = @{ enableLUA=$key.GetValue('EnableLUA',$null); kind=$key.GetValueKind('EnableLUA').ToString() } } finally { $key.Dispose() }
        $receipt.token = [LocalApiStandardUser.Native]::Read()
        $user = Get-LocalUser -SID $receipt.token.userSid -ErrorAction Stop
        $receipt.localAccount = @{ sid=$user.SID.Value; enabled=$user.Enabled }
        $receipt.administratorMemberSids = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { $_.SID.Value })
        $receipt.observationComplete = ($receipt.installerPolicy.state -ne 'unavailable')
        if (-not $receipt.observationComplete) { $receipt.errors = @('InstallerPolicyUnavailable') }
    } catch { $receipt.errors = @($_.Exception.GetType().Name) }
    return $receipt
}

function ConvertTo-WindowsStandardUserEvidence($observed) {
    try {
    $passed = $false; $rejection = $null
    try { Assert-Windows11StandardUserReceipt $observed; $passed = $true }
    catch { $rejection = 'Windows 11 standard-user requirements not verified' }
    # Whitelist public evidence. Raw SID/account/group observations stay only in memory.
    $token = $observed.token
    $adminGroups = @(); $interactive = @()
    if ($null -ne $token) {
        $adminGroups = @($token.groups | Where-Object { $_.sid -eq 'S-1-5-32-544' })
        $interactive = @($token.groups | Where-Object { $_.sid -eq 'S-1-5-4' -and ($_.attributes -band 4) -ne 0 -and ($_.attributes -band 16) -eq 0 })
    }
    $public = [ordered]@{
        preflightPassed=$passed; standardUserTesting='pending'; observationComplete=$observed.observationComplete;
        rejection=$rejection; queryErrors=@(if (@($observed.errors).Count -eq 0 -and $observed.observationComplete -ceq $true) { } else { 'NATIVE_OBSERVATION_UNAVAILABLE' }); os=$observed.os; uac=$observed.uac;
        hostedRunner=$observed.hostedRunner; installerPolicy=(ConvertTo-MsiPolicyEvidence $observed.installerPolicy);
        token=if ($null -eq $token) { $null } else { [ordered]@{
            userIdentity='redacted-local-account'; tokenType=$token.tokenType; elevationType=$token.elevationType;
            elevated=$token.elevated; hasRestrictions=$token.hasRestrictions; integritySid=$token.integritySid;
            interactiveSession=($token.sessionId -gt 0); interactiveGroupEnabled=($interactive.Count -eq 1);
            administratorSidPresent=($adminGroups.Count -gt 0);
            administratorGroupAttributes=@($adminGroups | ForEach-Object { $_.attributes });
            administratorSidDenyOnly=(@($adminGroups | Where-Object { ($_.attributes -band 16) -ne 0 }).Count -gt 0);
            localAccountMatchesToken=($null -ne $observed.localAccount -and $observed.localAccount.sid -ceq $token.userSid);
            localAccountEnabled=($null -ne $observed.localAccount -and $observed.localAccount.enabled -ceq $true);
            accountInAdministrators=if ($null -eq $observed.administratorMemberSids) { $null } else { $token.userSid -in $observed.administratorMemberSids }
        } }
    }
    return $public
    } catch {
        # Even malformed observations/formatting failures must not reveal exception text.
        return [ordered]@{ preflightPassed=$false; standardUserTesting='pending'; observationComplete=$false;
            rejection='Windows 11 standard-user requirements not verified'; queryErrors=@('NATIVE_OBSERVATION_UNAVAILABLE');
            os=$null; uac=$null; token=$null; hostedRunner=$null; installerPolicy=(ConvertTo-MsiPolicyEvidence $null) }
    }
}
