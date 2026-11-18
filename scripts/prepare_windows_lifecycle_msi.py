"""Build isolated MSI lifecycle candidates; never execute Windows code."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import uuid
import xml.etree.ElementTree as ET

from stage_windows_payload import identity, windows_names
from verify_portable_download import inventory_directory, require

NS = 'http://schemas.microsoft.com/wix/2006/wi'
FAMILY = uuid.UUID('18f3029b-3037-4b75-bb85-2037e7c8a364')
APP_DIR = 'LocalAPI-Lifecycle-Candidate'
ET.register_namespace('', NS)


def guid(value):
    return str(uuid.uuid5(FAMILY, value)).upper()


def identifier(prefix, value):
    return prefix + hashlib.sha256(value.encode()).hexdigest()[:30]


def element(parent, tag, **attributes):
    return ET.SubElement(parent, '{' + NS + '}' + tag, attributes)


def prepare(payload, output, head, version, manifest_sha256, fixture_family=None, *, release=False):
    payload, output = Path(payload).resolve(), Path(output).resolve()
    require(payload != output and payload not in output.parents and output not in payload.parents, 'Disjoint output required')
    require(not output.exists(), 'Fresh output required')
    require(re.fullmatch('[0-9a-f]{40}', head) is not None, 'Full head required')
    require(re.fullmatch('[0-9a-f]{64}', manifest_sha256) is not None, 'Full manifest digest required')
    require(re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version) is not None, 'Canonical numeric MSI version required')
    major, minor, build = map(int, version.split('.'))
    require(major <= 255 and minor <= 255 and build <= 65535, 'MSI version out of range')
    require(not (release and fixture_family is not None), 'Release and fixture families are exclusive')
    family = 'release' if release else 'candidate'
    if fixture_family is not None:
        require(str(uuid.UUID(fixture_family)) == fixture_family, 'Canonical fixture family required')
        family = 'fixture:' + fixture_family
    inv = inventory_directory(payload, fail_on_walk_error=True)
    require(inv.manifest is not None and hashlib.sha256(inv.manifest).hexdigest() == manifest_sha256, 'Manifest digest mismatch')
    evidence = inv.verify(head, 'win32'); identity(payload, version, 'x64'); windows_names(payload, inventory=inv)
    require(not inv.links(), 'MSI links forbidden')
    require(all('|' not in name for name in inv.entries), 'MSI filename separator forbidden')
    # Leave room for the longest file in the full package under a standard user's profile.
    directory = ('LocalAPI-Workbench' if release else APP_DIR) if fixture_family is None else 'LocalAPI-Q-' + fixture_family
    product_code = guid(family + ':product:' + version)
    upgrade_code = guid(family + ':upgrade')
    root = ET.Element('{' + NS + '}Wix')
    product = element(root, 'Product', Id=product_code, Name='Local API Workbench' if release else 'Local API Workbench lifecycle candidate', Language='1033',
                      Version=version, Manufacturer='Local API Workbench', UpgradeCode=upgrade_code)
    element(product, 'Package', InstallerVersion='500', Compressed='yes', InstallScope='perUser')
    element(product, 'Media', Id='1', Cabinet='payload.cab', EmbedCab='yes')
    for prop, value in [('ARPNOMODIFY', '1'), ('ARPNOREPAIR', '1')]:
        element(product, 'Property', Id=prop, Value=value)
    guards = {'NOT ALLUSERS': 'Per-user installation only.',
              'NOT Installed OR REMOVE="ALL"': 'Repair and modify are not supported.',
              'Installed OR NOT SAMEORNEWERPRODUCTS': 'Same or newer version is already installed.',
              'Installed OR OLDERPRODUCTS OR NOT EXISTINGCANDIDATE': 'A fresh installation directory is required.',
              'NOT RollbackDisabled AND NOT DISABLEROLLBACK': 'Rollback must not be disabled.'}
    for condition, message in guards.items(): element(product, 'Condition', Message=message).text = condition
    upgrade = element(product, 'Upgrade', Id=upgrade_code)
    element(upgrade, 'UpgradeVersion', Minimum='0.0.0', IncludeMinimum='yes', Maximum=version,
            IncludeMaximum='no', OnlyDetect='no', Property='OLDERPRODUCTS')
    element(upgrade, 'UpgradeVersion', Minimum=version, IncludeMinimum='yes', OnlyDetect='yes', Property='SAMEORNEWERPRODUCTS')
    sequence = element(product, 'InstallExecuteSequence')
    element(sequence, 'RemoveExistingProducts', After='InstallInitialize')
    target = element(product, 'Directory', Id='TARGETDIR', Name='SourceDir')
    if release:
        element(target, 'Directory', Id='ProgramMenuFolder')
    local = element(target, 'Directory', Id='LocalAppDataFolder')
    app = element(local, 'Directory', Id='CandidateRoot', Name=directory)
    dirs = {'': app}
    for name, (kind, _) in sorted(inv.entries.items(), key=lambda x: (x[0].count('/'), x[0])):
        if not name or kind != 'directory': continue
        parent, _, leaf = name.rpartition('/')
        dirs[name] = element(dirs[parent], 'Directory', Id=identifier('D', name), Name=leaf)
    feature = element(product, 'Feature', Id='ApplicationFiles', Title='Application files only', Level='1')
    for name in sorted(inv.hashes):
        parent, _, leaf = name.rpartition('/')
        cid = identifier('C', name)
        component = element(dirs[parent], 'Component', Id=cid, Guid=guid(family + ':component:' + name), Win64='yes')
        element(component, 'File', Id=identifier('F', name), Name=leaf, Source=str(payload / name))
        if release and name == 'LocalAPI.exe':
            element(component, 'Shortcut', Id='WorkbenchStart', Directory='ProgramMenuFolder', Target='[#' + identifier('F', name) + ']',
                    Name='Local API Workbench', WorkingDirectory='CandidateRoot')
        element(component, 'RegistryValue', Id=identifier('R', name), Root='HKCU',
                Key=registry_key(upgrade_code, release),
                Name=cid, Type='integer', Value='1', KeyPath='yes')
        element(feature, 'ComponentRef', Id=cid)
    output.mkdir(); ET.indent(root)
    ET.ElementTree(root).write(output / 'candidate.wxs', encoding='utf-8', xml_declaration=True)
    receipt = {**evidence, 'version': version, 'manifestSha256': manifest_sha256, 'productCode': product_code,
               'upgradeCode': upgrade_code, 'directory': directory, 'fixtureFamily': fixture_family,
               'fileHashes': dict(sorted(inv.hashes.items())), 'fileSizes': {n: (payload / n).stat().st_size for n in inv.hashes},
               'directories': sorted(n for n, (kind, _) in inv.entries.items() if kind == 'directory'),
               'nativeLifecycleVerified': False, 'signatureVerified': False}
    if release: receipt['releaseFamily'] = True
    (output / 'build-input.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def registry_key(upgrade_code, release):
    return ('Software\\LocalAPI\\Workbench\\' if release else 'Software\\LocalAPI\\LifecycleCandidate\\') + upgrade_code


def export_table(tool, msi, table):
    lines = subprocess.check_output([str(tool), 'export', str(msi), table], text=True).splitlines()
    require(len(lines) >= 3, 'Invalid table export')
    return lines[:3], [line.split('\t') for line in lines[3:] if line]


def import_table(tool, msi, path, headers, rows):
    path.write_bytes(('\r\n'.join([*headers, *['\t'.join(map(str, row)) for row in rows]]) + '\r\n').encode())
    subprocess.run([str(tool), str(msi), '-i', str(path)], check=True, capture_output=True)


def validate(receipt, tables):
    properties = dict(tables['Property'])
    require(properties['ProductCode'] == '{' + receipt['productCode'] + '}', 'Product identity changed')
    require(properties['UpgradeCode'] == '{' + receipt['upgradeCode'] + '}', 'Upgrade identity changed')
    require(properties['ProductVersion'] == receipt['version'], 'Version changed')
    require('ALLUSERS' not in properties, 'Machine installation forbidden')
    for name in ['CustomAction', 'RemoveFile', 'RemoveRegistry']:
        require(not tables.get(name), 'Unexpected side effects: ' + name)
    require(len(tables['File']) == len(receipt['fileHashes']), 'Payload count mismatch')
    file_names = {identifier('F', n): n for n in receipt['fileHashes']}
    require(len({r[0] for r in tables['File']}) == len(file_names), 'Repeated file identity')
    for row in tables['File']:
        require(row[0] in file_names, 'Unknown file identity')
        name = file_names[row[0]]
        require(row[1:7] == [identifier('C', name), name.rsplit('/', 1)[-1], str(receipt['fileSizes'][name]), '', '', '512'], 'File metadata changed')
    release = receipt.get('releaseFamily') is True
    family = ('release' if release else 'candidate') if receipt['fixtureFamily'] is None else 'fixture:' + receipt['fixtureFamily']
    if release:
        require(properties['ProductName'] == 'Local API Workbench' and receipt['fixtureFamily'] is None, 'Release identity changed')
    components, registry, directories = [], [], []
    for name in receipt['fileHashes']:
        parent = name.rpartition('/')[0]; cid = identifier('C', name); rid = identifier('R', name)
        components.append([cid, '{' + guid(family + ':component:' + name) + '}', identifier('D', parent) if parent else 'CandidateRoot', '260', '', rid])
        registry.append([rid, '1', registry_key(receipt['upgradeCode'], release), cid, '#1', cid])
    require(sorted(tables['Component']) == sorted(components), 'Component identity changed')
    require(sorted(tables['Registry']) == sorted(registry), 'Registry ownership changed')
    for name in receipt['directories']:
        if not name: continue
        parent, _, leaf = name.rpartition('/')
        directories.append([identifier('D', name), identifier('D', parent) if parent else 'CandidateRoot', leaf])
    directories += [['CandidateRoot', 'LocalAppDataFolder', receipt['directory']], ['LocalAppDataFolder', 'TARGETDIR', '.'], ['TARGETDIR', '', 'SourceDir']]
    if release:
        directories.append(['ProgramMenuFolder', 'TARGETDIR', '.'])
        shortcuts = tables.get('Shortcut', [])
        require(len(shortcuts) == 1 and shortcuts[0][:5] == ['WorkbenchStart', 'ProgramMenuFolder',
                'Local API Workbench', identifier('C', 'LocalAPI.exe'), '[#' + identifier('F', 'LocalAPI.exe') + ']'],
                'Start menu target changed')
    require(sorted(tables['Directory']) == sorted(directories), 'Directory layout changed')
    require(tables['AppSearch'] == [['EXISTINGCANDIDATE', 'ExistingCandidate']], 'AppSearch changed')
    require(tables['DrLocator'] == [['ExistingCandidate', '', '[LocalAppDataFolder]' + receipt['directory'], '0']], 'Directory search changed')
    require(properties.get('SecureCustomProperties') == 'OLDERPRODUCTS;SAMEORNEWERPRODUCTS', 'Upgrade properties not secured')
    require({row[0] for row in tables['LaunchCondition']} == {
        'NOT ALLUSERS', 'NOT Installed OR REMOVE="ALL"',
        'Installed OR NOT SAMEORNEWERPRODUCTS', 'Installed OR OLDERPRODUCTS OR NOT EXISTINGCANDIDATE',
        'NOT RollbackDisabled AND NOT DISABLEROLLBACK'}, 'Lifecycle guards changed')
    upgrades = {r[-1]: r for r in tables['Upgrade']}
    require(set(upgrades) == {'OLDERPRODUCTS', 'SAMEORNEWERPRODUCTS'}, 'Unexpected upgrade selection')
    require(upgrades['OLDERPRODUCTS'] == ['{' + receipt['upgradeCode'] + '}', '0.0.0', receipt['version'], '', '256', '', 'OLDERPRODUCTS'], 'Old product selection changed')
    require(upgrades['SAMEORNEWERPRODUCTS'] == ['{' + receipt['upgradeCode'] + '}', receipt['version'], '', '', '258', '', 'SAMEORNEWERPRODUCTS'], 'Downgrade guard changed')
    for table in ['InstallExecuteSequence', 'InstallUISequence']:
        require(all(r[1] == '' for r in tables[table]), 'Unexpected conditional standard action')
        seq = {r[0]: int(r[2]) for r in tables[table]}
        require('DisableRollback' not in seq and 'ForceReboot' not in seq, 'Unexpected recovery/reboot action')
        require(seq['FindRelatedProducts'] < seq['LaunchConditions'] and seq['AppSearch'] < seq['LaunchConditions'], 'Detection must precede guard')
    seq = {r[0]: int(r[2]) for r in tables['InstallExecuteSequence']}
    require(seq['RemoveExistingProducts'] == seq['InstallInitialize'] + 1, 'Upgrade removal must be inside rollback transaction')
    require(seq['RemoveExistingProducts'] < seq['ProcessComponents'] < seq['InstallFinalize'], 'Upgrade removal ordering changed')


def compile_msi(output, tools):
    output, tools = Path(output).resolve(), Path(tools).resolve()
    receipt = json.loads((output / 'build-input.json').read_text())
    msi = output / 'LocalAPI-lifecycle-UNVERIFIED.msi'
    final = output / ('LocalAPI-' + receipt['version'] + '-windows-x64.msi' if receipt.get('releaseFamily') else 'LocalAPI-lifecycle-UNSIGNED.msi')
    require(not msi.exists() and not final.exists(), 'No package overwrite')
    result = subprocess.run([str(tools / 'wixl'), '-a', 'x64', '-o', str(msi), str(output / 'candidate.wxs')], check=True, capture_output=True, text=True)
    require(not result.stderr.strip(), 'Compiler diagnostics require review: ' + result.stderr)
    import_table(tools / 'msibuild', msi, output / 'AppSearch.idt', ['Property\tSignature_', 's72\ts72', 'AppSearch\tProperty\tSignature_'], [['EXISTINGCANDIDATE', 'ExistingCandidate']])
    import_table(tools / 'msibuild', msi, output / 'DrLocator.idt', ['Signature_\tParent\tPath\tDepth', 's72\tS72\tS255\tI2', 'DrLocator\tSignature_\tParent\tPath'], [['ExistingCandidate', '', '[LocalAppDataFolder]' + receipt['directory'], 0]])
    import_table(tools / 'msibuild', msi, output / 'Signature.idt', ['Signature\tFileName\tMinVersion\tMaxVersion\tMinSize\tMaxSize\tMinDate\tMaxDate\tLanguages', 's72\ts255\tS20\tS20\tI4\tI4\tI4\tI4\tS255', 'Signature\tSignature'], [])
    for table in ['InstallExecuteSequence', 'InstallUISequence']:
        headers, rows = export_table(tools / 'msiinfo', msi, table)
        require(not any(r[0] == 'AppSearch' for r in rows), 'Unexpected authored AppSearch')
        rows.append(['AppSearch', '', '50'])
        import_table(tools / 'msibuild', msi, output / (table + '.idt'), headers, rows)
    present = subprocess.check_output([str(tools / 'msiinfo'), 'tables', str(msi)], text=True).splitlines()
    tables = {n: export_table(tools / 'msiinfo', msi, n)[1] for n in ['Property', 'Directory', 'File', 'Component', 'Registry', 'Upgrade', 'LaunchCondition', 'InstallExecuteSequence', 'InstallUISequence', 'CustomAction', 'RemoveFile', 'RemoveRegistry', 'Shortcut', 'AppSearch', 'DrLocator'] if n in present}
    validate(receipt, tables)
    summary = subprocess.check_output([str(tools / 'msiinfo'), 'suminfo', str(msi)], text=True)
    require('Source: 10 (a)' in summary and 'Template: x64;1033' in summary, 'Unexpected privileges or architecture')
    extracted = output / 'extracted'; extracted.mkdir()
    subprocess.run([str(tools / 'msiextract'), '-C', str(extracted), str(msi)], check=True, capture_output=True)
    require(set(p.name for p in extracted.iterdir()) == {receipt['directory']}, 'Unexpected extraction root')
    require(inventory_directory(extracted / receipt['directory']).hashes == receipt['fileHashes'], 'Cabinet differs')
    evidence = {'msiSha256': hashlib.sha256(msi.read_bytes()).hexdigest(), 'tables': tables, 'summary': summary, 'nativeLifecycleVerified': False}
    (output / 'compiled-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    msi.rename(final)
    return final


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['payload', 'output', 'head', 'version', 'manifest-sha256']: parser.add_argument('--' + name, required=True)
    parser.add_argument('--tools'); parser.add_argument('--fixture-family'); parser.add_argument('--release', action='store_true')
    args = parser.parse_args()
    result = prepare(args.payload, args.output, args.head, args.version, args.manifest_sha256, args.fixture_family, release=args.release)
    if args.tools: result['msi'] = str(compile_msi(args.output, args.tools))
    print(json.dumps(result, indent=2))


if __name__ == '__main__': main()
