"""Opt-in TEST-ONLY fault clone; never changes either normal product installer."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import uuid
from prepare_installed_product_journey import checked_build, file_digest, no_alias
from prepare_windows_lifecycle_msi import export_table, import_table
from verify_portable_download import require

ACTION = 'ProductRollbackProbe'
MESSAGE = 'Deliberate full-product rollback probe after old product removal'


def output(tools, command, msi, *args):
    return subprocess.check_output([str(tools / 'msiinfo'), command, str(msi), *args], text=True)


def stream_digest(tools, msi, name):
    digest = hashlib.sha256()
    process = subprocess.Popen([str(tools / 'msiinfo'), 'extract', str(msi), name], stdout=subprocess.PIPE)
    with process.stdout as data:
        for chunk in iter(lambda: data.read(1024 * 1024), b''): digest.update(chunk)
    require(process.wait() == 0, 'MSI stream extraction failed')
    return digest.hexdigest()


def create_fault(build, msi_sha, receipt_sha, destination, tools):
    build, _, contract, _, _ = checked_build(build, msi_sha, receipt_sha)
    destination, tools = no_alias(destination), Path(tools).resolve()
    require(not destination.exists() and destination != build and destination not in build.parents and build not in destination.parents, 'Fresh disjoint fault output required')
    source = build / 'LocalAPI-lifecycle-UNSIGNED.msi'
    tables = output(tools, 'tables', source).splitlines()
    require('CustomAction' in tables, 'Expected reviewed authoring schema')
    original = {name: export_table(tools/'msiinfo', source, name) for name in tables if name != '_SummaryInformation'}
    require(original['CustomAction'][0][0].split('\t') == ['Action','Type','Source','Target','ExtendedType'], 'Reviewed CustomAction schema required')
    require(original['CustomAction'][1] == [], 'Only action-free source MSI is eligible')
    seq = original['InstallExecuteSequence'][1]
    times = {row[0]: int(row[2]) for row in seq}
    require(times['InstallInitialize'] < times['RemoveExistingProducts'] < times['InstallFiles'] == 4000 < times['InstallFinalize'], 'Reviewed transactional fault boundary required')
    require(all(row[0] != ACTION and row[2] != '4001' for row in seq), 'Fault sequence collision')
    destination.mkdir()
    fault = destination / 'LocalAPI-TEST-ONLY-ROLLBACK-FAILURE.msi'
    shutil.copyfile(source, fault)
    rows = [[ACTION, '19', '', MESSAGE, '']]
    import_table(tools/'msibuild', fault, destination/'CustomAction.idt', original['CustomAction'][0], rows)
    fault_seq = [*seq, [ACTION, 'OLDERPRODUCTS', '4001']]
    import_table(tools/'msibuild', fault, destination/'InstallExecuteSequence.idt', original['InstallExecuteSequence'][0], fault_seq)
    summary = output(tools, 'suminfo', source)
    values = dict(line.split(': ',1) for line in summary.splitlines() if ': ' in line)
    new_code = '{' + str(uuid.uuid4()).upper() + '}'
    subprocess.run([str(tools/'msibuild'), str(fault), '-s', values['Subject'], values['Author'], values['Template'], new_code], check=True)
    actual_summary = output(tools, 'suminfo', fault)
    actual_values = dict(line.split(': ',1) for line in actual_summary.splitlines() if ': ' in line)
    require(actual_values['Revision number (UUID)'] == new_code and new_code != values['Revision number (UUID)'], 'Distinct fault package cache identity required')
    require({k:v for k,v in actual_values.items() if k not in ['Revision number (UUID)','Last saved']} == {k:v for k,v in values.items() if k not in ['Revision number (UUID)','Last saved']}, 'Unexpected summary mutation')
    require(set(output(tools,'tables',fault).splitlines()) == set(tables), 'Table set changed')
    for name, (headers, contents) in original.items():
        expected = rows if name == 'CustomAction' else fault_seq if name == 'InstallExecuteSequence' else contents
        actual_headers, actual = export_table(tools/'msiinfo', fault, name)
        require(actual_headers == headers and sorted(actual) == sorted(expected), 'Unexpected fault table mutation: ' + name)
    streams = output(tools,'streams',source).splitlines()
    require(set(output(tools,'streams',fault).splitlines()) == set(streams), 'Stream set changed')
    cabinets = {}
    for name in streams:
        if name == '\x05SummaryInformation': continue
        value = stream_digest(tools, source, name)
        require(stream_digest(tools, fault, name) == value, 'Fault changed payload stream')
        cabinets[name] = value
    require(cabinets.keys() == {'payload.cab'}, 'Unexpected source payload streams')
    require(file_digest(source) == msi_sha, 'Normal source MSI changed')
    evidence = {'kind':'localapi-product-rollback-fixture-v1', 'sourceMsiSha256':msi_sha, 'sourceReceiptSha256':receipt_sha,
        'msiSha256':file_digest(fault), 'family':contract['fixtureFamily'], 'version':contract['version'], 'head':contract['head'],
        'productCode':contract['productCode'], 'originalPackageCode':values['Revision number (UUID)'], 'faultPackageCode':new_code,
        'cabinetSha256':cabinets['payload.cab'], 'allOtherTablesUnchanged':True, 'payloadUnchanged':True,
        'fault':{'action':ACTION,'type':19,'condition':'OLDERPRODUCTS','sequence':4001,'message':MESSAGE}, 'nativeRollbackVerified':False}
    (destination/'rollback-fixture.json').write_text(json.dumps(evidence,indent=2)+'\n')
    return evidence


def add_to_bundle(bundle_path, build, msi_sha, receipt_sha, tools):
    root = no_alias(bundle_path)
    plan_path = root/'product-plan.json'
    plan = json.loads(plan_path.read_text())
    require('rollbackFixture' not in plan and plan['packages'][1]['msi']['sha256'] == msi_sha and plan['packages'][1]['receipt']['sha256'] == receipt_sha, 'Bundle must pin the exact new source MSI and receipt')
    evidence = create_fault(build, msi_sha, receipt_sha, root/'faults', tools)
    require(evidence['family'] == plan['family'], 'Fault family differs')
    plan['rollbackFixture'] = {'kind':evidence['kind'], 'sourceMsiSha256':msi_sha,
        'msi':{'file':'faults/LocalAPI-TEST-ONLY-ROLLBACK-FAILURE.msi','sha256':evidence['msiSha256']},
        'receipt':{'file':'faults/rollback-fixture.json','sha256':file_digest(root/'faults/rollback-fixture.json')}}
    plan_path.write_text(json.dumps(plan,indent=2)+'\n')
    return file_digest(plan_path)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['bundle', 'build', 'msi-sha256', 'receipt-sha256', 'tools']: parser.add_argument('--' + name, required=True)
    parser.add_argument('--create-test-only-rollback-fixture', action='store_true')
    args = parser.parse_args()
    if not args.create_test_only_rollback_fixture: parser.error('Explicit --create-test-only-rollback-fixture required')
    print(json.dumps({'planSha256':add_to_bundle(args.bundle, args.build, args.msi_sha256, args.receipt_sha256, args.tools), 'nativeRollbackVerified':False}))
