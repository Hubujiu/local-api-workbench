"""Generate a compile-only NSIS first-install candidate from an explicit verified payload.
No compiler invocation, installer execution, cleanup, registration or downloads.
"""
import argparse
import hashlib
import json
from pathlib import Path
from stage_windows_payload import identity, windows_names
from verify_portable_download import inventory_directory, require


def quoted(value):
    return '"' + str(value).replace('$', '$$').replace('"', '$\\"') + '"'


def prepare(payload, manifest, output, head, version, manifest_sha256):
    payload, manifest, output = Path(payload).resolve(), Path(manifest).resolve(), Path(output).resolve()
    require(manifest == payload / 'build-manifest.json', 'Explicit manifest must belong to payload')
    require(payload != output and payload not in output.parents and output not in payload.parents, 'Disjoint build output required')
    require(manifest.stat().st_size <= 32 * 1024 * 1024, 'Manifest too large')
    digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
    require(digest == manifest_sha256, 'Expected manifest digest mismatch')
    inventory = inventory_directory(payload)
    evidence = inventory.verify(head, 'win32')
    windows_names(payload)
    require(all('$' not in name for name in inventory.entries), 'Dollar-bearing payload paths unsupported by installer candidate')
    identity(payload, version, 'x64')
    require(not output.exists(), 'Fresh build output required')
    lines = [
        'Unicode true', 'RequestExecutionLevel user', 'SilentInstall normal',
        'Name "Local API Workbench first-install candidate"',
        'OutFile ' + quoted(output / 'LocalAPI-first-install-UNSIGNED.exe'),
        'SetCompressor /SOLID lzma', 'CRCCheck force', 'ShowInstDetails show',
        '!include "FileFunc.nsh"', '!include "LogicLib.nsh"',
        'Var FixedTarget', 'Var PendingTarget', 'Var Ancestor', 'Page components', 'Page instfiles',
        'Function .onInit', '  IfSilent refuse 0', '  SetShellVarContext current',
        '  ReadEnvStr $0 LOCAL_API_DESKTOP_DATA', '  StrCmp $0 "" +2', '  Goto refuse',
        '  StrCpy $0 $LOCALAPPDATA 2 1', '  StrCmp $0 ":\\" +2', '  Goto refuse',
        '  StrCpy $2 $LOCALAPPDATA 3',
        "  System::Call 'kernel32::GetDriveTypeW(w r2) i .r0'",
        '  IntCmp $0 3 +2', '  Goto refuse',
        '  StrCpy $FixedTarget "$LOCALAPPDATA\\LocalAPI-FirstInstall-Candidate"',
        '  StrCpy $PendingTarget "$FixedTarget.pending"', '  StrCpy $INSTDIR $PendingTarget', '  Return',
        'refuse:', '  SetErrorLevel 2', '  Quit', 'FunctionEnd',
        'Function CheckAncestors', '  StrCpy $Ancestor $LOCALAPPDATA',
        'ancestor_loop:',
        '  StrCpy $2 $Ancestor',
        "  System::Call 'kernel32::GetFileAttributesW(w r2) i .r0'",
        '  IntCmp $0 -1 unsafe', '  IntOp $1 $0 & 0x400',
        '  IntCmp $1 0 +2', '  Goto unsafe',
        '  IntOp $1 $0 & 0x10', '  IntCmp $1 0 unsafe',
        '  StrCpy $3 $LOCALAPPDATA 3', '  StrCmp $Ancestor $3 ancestors_ok',
        '  ${GetParent} "$Ancestor" $1',
        '  StrCpy $2 $LOCALAPPDATA 2', '  StrCmp $1 $2 0 +2', '  StrCpy $1 $3', '  StrCmp $1 "" ancestors_ok',
        '  StrCmp $1 $Ancestor ancestors_ok', '  StrCpy $Ancestor $1', '  Goto ancestor_loop',
        'unsafe:', '  MessageBox MB_OK|MB_ICONSTOP "Unsafe installation parent. Publication refused; pending files may remain. Do not run them."',
        '  SetErrorLevel 3', '  Quit', 'ancestors_ok:', 'FunctionEnd',
        'Function RequireMissing',
        "  System::Call 'kernel32::GetFileAttributesW(w r2) i .r0 ?e'",
        '  Pop $1', '  IntCmp $0 -1 missing_attributes missing_refused missing_refused',
        'missing_attributes:', '  IntCmp $1 2 missing_ok missing_refused missing_refused',
        'missing_refused:',
        '  MessageBox MB_OK|MB_ICONSTOP "Final or pending path exists or cannot be safely inspected. Publication refused; pending files may remain. Do not run them."',
        '  SetErrorLevel 4', '  Quit', 'missing_ok:', 'FunctionEnd',
        'Section "First install only (unsigned candidate; no upgrade/uninstall)"',
        '  SectionIn RO', '  SetShellVarContext current',
        '  StrCpy $FixedTarget "$LOCALAPPDATA\\LocalAPI-FirstInstall-Candidate"',
        '  StrCpy $PendingTarget "$FixedTarget.pending"', '  StrCpy $INSTDIR $PendingTarget', '  Call CheckAncestors',
        '  StrCpy $2 $FixedTarget', '  Call RequireMissing',
        '  StrCpy $2 $PendingTarget', '  Call RequireMissing',
        "  System::Call 'kernel32::CreateDirectoryW(w r2, p 0) i .r0'",
        '  IntCmp $0 0 refused', '  SetOverwrite off',
    ]
    for name, (kind, _) in sorted(inventory.entries.items()):
        if not name or kind != 'file':
            continue
        parent, leaf = name.rsplit('/', 1) if '/' in name else ('', name)
        destination = '$INSTDIR' + ('\\' + parent.replace('/', '\\') if parent else '')
        # Paths from verified Windows inventory; quote literals while preserving only our $INSTDIR.
        lines += ['  ClearErrors', '  SetOutPath ' + quoted(destination).replace('$$INSTDIR', '$INSTDIR', 1),
                  '  IfErrors failed',
                  '  IfFileExists ' + quoted(destination + '\\' + leaf).replace('$$INSTDIR', '$INSTDIR', 1) + ' failed',
                  '  File ' + quoted('/oname=' + leaf) + ' ' + quoted(payload / name),
                  '  IfErrors failed']
    lines += ['  Call CheckAncestors', '  StrCpy $2 $LOCALAPPDATA',
              "  System::Call 'kernel32::SetCurrentDirectoryW(w r2) i .r0'",
              '  IntCmp $0 0 failed',
              '  Call CheckAncestors', '  StrCpy $2 $FixedTarget', '  Call RequireMissing',
              '  StrCpy $2 $PendingTarget',
              "  System::Call 'kernel32::GetFileAttributesW(w r2) i .r0'",
              '  IntCmp $0 -1 failed', '  IntOp $1 $0 & 0x400', '  IntCmp $1 0 +2', '  Goto failed',
              '  IntOp $1 $0 & 0x10', '  IntCmp $1 0 failed',
              '  StrCpy $3 $FixedTarget',
              "  System::Call 'kernel32::MoveFileExW(w r2, w r3, i 0) i .r0'",
              '  IntCmp $0 0 failed', '  Goto finished', 'refused:',
              '  MessageBox MB_OK|MB_ICONSTOP "Target already exists or cannot be reserved. No upgrade or overwrite is allowed."',
              '  SetErrorLevel 4', '  Abort', 'failed:',
              '  MessageBox MB_OK|MB_ICONSTOP "Copy failed. Partial pending directory is retained; do not run it. No automatic cleanup or retry."',
              '  SetErrorLevel 5', '  Abort', 'finished:',
              '  DetailPrint "Payload copy and no-replace publication completed. This is unsigned; installation acceptance is still pending."',
              'SectionEnd']
    output.mkdir()
    (output / 'first-install.nsi').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    (output / 'build-input.json').write_text(json.dumps({**evidence, 'manifest': str(manifest),
        'manifestSha256': digest, 'candidateOnly': True, 'runtimeVerified': False}, indent=2) + '\n')
    return output / 'first-install.nsi'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['payload', 'manifest', 'output', 'head', 'version', 'manifest-sha256']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    print(prepare(args.payload, args.manifest, args.output, args.head, args.version, args.manifest_sha256))
