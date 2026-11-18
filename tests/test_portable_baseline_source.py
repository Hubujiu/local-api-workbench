import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from attest_windows_baseline_source import read_lock, verify_source, validate_receipt, attest
from test_portable_windows_stage import package
from test_portable_download import make_directory
from compile_hosted_product_pair import candidate_version

ROOT=Path(__file__).resolve().parents[1]

class BaselineSourceTests(unittest.TestCase):
    def setUp(self):
        self.lock=read_lock(ROOT/'packaging/windows-msi/windows-baseline-source-lock.json')
        self.receipt=dict(schemaVersion=1,kind='source-rebuild',repository=self.lock['repository'],sourceUrl=self.lock['sourceUrl'],head=self.lock['head'],version=self.lock['version'],nodeVersion=self.lock['nodeVersion'],sourceFiles=self.lock['files'],builderHead='a'*40,manifestSha256='b'*64,historicalArchiveReproduced=False)

    def validate(self, receipt):
        validate_receipt(receipt,self.lock,self.lock['head'],'0.1.0','b'*64,'a'*40)

    def test_rebuilt_manifest_is_new_and_independently_bound(self):
        self.validate(self.receipt)
        for field,value in [('kind','artifact-download'),('head','c'*40),('version','0.1.1'),('manifestSha256','c'*64),('builderHead','c'*40),('historicalArchiveReproduced',True),('sourceFiles',{}),('sourceUrl','https://example.com/')]:
            with self.subTest(field=field),self.assertRaises(ValueError): self.validate({**self.receipt,field:value})
        with self.assertRaises(ValueError): self.validate({**self.receipt,'extra':'unreviewed'})

    def test_exact_source_files_and_clean_head_are_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); files={}
            for file in self.lock['files']:
                path=root/file;path.parent.mkdir(exist_ok=True);path.write_bytes(b'fixture');files[file]=hashlib.sha256(b'fixture').hexdigest()
            lock={**self.lock,'files':files}
            with patch('attest_windows_baseline_source.subprocess.check_output',side_effect=[lock['head']+'\n','']):verify_source(root,lock)
            for replies in [['c'*40+'\n'],[lock['head']+'\n',' M scripts/build-desktop.mjs']]:
                with patch('attest_windows_baseline_source.subprocess.check_output',side_effect=replies),self.assertRaises(ValueError):verify_source(root,lock)
            (root/'package-lock.json').write_bytes(b'changed')
            with patch('attest_windows_baseline_source.subprocess.check_output',side_effect=[lock['head']+'\n','']),self.assertRaises(ValueError):verify_source(root,lock)

    def test_candidate_version_future_releases_and_msi_bounds(self):
        for value in ['0.1.1','0.1.2','0.2.0','1.0.0','255.255.65535']:self.assertEqual(candidate_version(value),value)
        for value in ['0.0.9','0.1.0','00.1.1','0.1.1-rc.1','256.0.0','0.256.0','0.1.65536','0.1',None]:
            with self.subTest(value=value),self.assertRaises(ValueError):candidate_version(value)

    def test_rebuild_attestation_verifies_inventory_and_identity_not_archive_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            payload=Path(temp).resolve()/'portable'
            make_directory(payload,package(head=self.lock['head']))
            with patch('attest_windows_baseline_source.verify_source'):
                receipt=attest(temp,payload,self.lock,'a'*40)
                self.assertEqual(receipt['manifestSha256'],hashlib.sha256((payload/'build-manifest.json').read_bytes()).hexdigest())
                self.assertFalse(receipt['historicalArchiveReproduced'])
                (payload/'resources/app/package.json').write_text('{}')
                with self.assertRaises(ValueError):attest(temp,payload,self.lock,'a'*40)

    def test_source_pin_keeps_previously_reviewed_baseline_commit(self):
        archive=json.loads((ROOT/'packaging/windows-msi/windows-baseline-lock.json').read_text())
        self.assertEqual(self.lock['head'],archive['head'])
        self.assertEqual(self.lock['repository'],archive['repository'])
        self.assertNotIn('manifestSha256',self.lock)
