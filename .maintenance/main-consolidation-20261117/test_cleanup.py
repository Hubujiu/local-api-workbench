import dataclasses
import base64
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

import cleanup


def raw_git(directory, *arguments):
    result = subprocess.run(["git", *arguments], cwd=directory, text=True, capture_output=True, check=True)
    return result.stdout.strip()


def fake_ci(environment, policy):
    return {"run_id": policy.ci_run, "head_sha": policy.main, "job_count": policy.ci_jobs, "conclusion": "success"}


class Fixture:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.remote = self.root / "remote.git"
        self.checkout = self.root / "checkout"
        self.output = self.root / "evidence"
        self.checkout.mkdir()
        self.output.mkdir()
        raw_git(self.root, "init", "--bare", str(self.remote))
        raw_git(self.checkout, "init", "-b", "main")
        raw_git(self.checkout, "config", "user.email", "fixture@example.invalid")
        raw_git(self.checkout, "config", "user.name", "Cleanup fixture")
        raw_git(self.checkout, "remote", "add", "origin", str(self.remote))
        self.main = self.commit("main")
        raw_git(self.checkout, "checkout", "-b", "feature/alpha")
        self.alpha = self.commit("alpha")
        raw_git(self.checkout, "branch", "deps/base", self.main)
        raw_git(self.checkout, "checkout", "-b", "experimental/old", self.main)
        self.experimental = self.commit("experiment")
        raw_git(self.checkout, "checkout", "-b", cleanup.PRODUCTION.maintenance, self.main)
        self.maintenance = self.commit("maintenance")
        raw_git(self.checkout, "push", "origin", "--all")
        raw_git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        self.policy = dataclasses.replace(cleanup.PRODUCTION, main=self.main, branch_count=4, remote_url=str(self.remote))
        self.environment = {"GITHUB_REPOSITORY": self.policy.repository, "GITHUB_SERVER_URL": "https://github.com",
                            "GITHUB_REF": "refs/heads/" + self.policy.maintenance, "GITHUB_EVENT_NAME": "push",
                            "GITHUB_SHA": self.maintenance, "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1",
                            "GITHUB_TOKEN": "unused-fixture-token", "CLEANUP_BACKUP_ARTIFACT_ID": "67890",
                            "CLEANUP_BACKUP_ARTIFACT_URL": f"https://github.com/{self.policy.repository}/actions/runs/12345/artifacts/67890",
                            "CLEANUP_BACKUP_ARTIFACT_DIGEST": "a" * 64}
        self.manifest = self.root / "manifest.json"
        cleanup.write_json(self.manifest, {"schema_version": 1, "repository": self.policy.repository,
                                          "main_sha": self.main, "maintenance_branch": self.policy.maintenance,
                                          "archive_prefix": self.policy.archive,
                                          "heads": {"refs/heads/main": self.main, "refs/heads/feature/alpha": self.alpha,
                                                    "refs/heads/deps/base": self.main, "refs/heads/experimental/old": self.experimental}})
        self.git = cleanup.Git(self.checkout)
        self.plan = cleanup.load_plan(self.manifest, self.git, self.environment, self.policy)

    def commit(self, value):
        (self.checkout / "fixture.txt").write_text(value + "\n")
        raw_git(self.checkout, "add", "fixture.txt")
        raw_git(self.checkout, "commit", "-m", value)
        return raw_git(self.checkout, "rev-parse", "HEAD")

    def prepare(self):
        return cleanup.prepare(self.git, self.plan, self.output, self.environment, self.policy, ci_check=fake_ci)

    def apply(self):
        return cleanup.apply(self.git, self.plan, self.output, self.environment, self.policy,
                             ci_check=fake_ci, artifact_check=cleanup.artifact_receipt)

    def heads(self):
        return {r: s for r, s in self.git.remote_refs().items() if r.startswith("refs/heads/")}


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.fixture = Fixture(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_diagnostics_are_bounded_and_do_not_expose_git_credentials(self):
        token = "fixture-token-value"
        encoded = base64.b64encode(("x-access-token:" + token).encode()).decode()
        raw = f"remote: rejected\nAuthorization: basic {encoded}\nhttps://user:password@github.com/repo\n{token}\n" + "line\n" * 1000
        with mock.patch.dict("os.environ", {"GITHUB_TOKEN": token}):
            diagnostic = cleanup.bounded_diagnostic(raw)
        self.assertNotIn(token, diagnostic)
        self.assertNotIn(encoded, diagnostic)
        self.assertNotIn("password", diagnostic)
        self.assertIn("rejected", diagnostic)
        self.assertLessEqual(len(diagnostic), 2400)

    def test_happy_cleanup_preserves_main_and_every_archived_commit(self):
        fixture = self.fixture
        before = fixture.heads()
        prepared = fixture.prepare()
        self.assertEqual(prepared["status"], "prepared")
        self.assertEqual(fixture.heads(), before)
        result = fixture.apply()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(fixture.heads(), {"refs/heads/main": fixture.main})
        remote = fixture.git.remote_refs()
        for tag, sha in fixture.plan["tags"].items():
            self.assertEqual(remote[tag], sha)
        restore = pathlib.Path(self.temporary.name) / "restored.git"
        raw_git(fixture.root, "clone", "--mirror", str(fixture.output / "repository.bundle"), str(restore))
        for ref, sha in fixture.plan["heads"].items():
            tracking = "refs/remotes/origin/" + ref.removeprefix("refs/heads/")
            self.assertEqual(raw_git(restore, "rev-parse", tracking), sha)
        self.assertFalse((restore / "config").read_text().find("unused-fixture-token") >= 0)

    def test_changed_head_between_validation_and_push_aborts_entire_transaction(self):
        fixture = self.fixture
        fixture.prepare()
        before = fixture.heads()
        run = fixture.git.run

        def race(label, *arguments):
            if label == "delete branches atomically":
                raw_git(fixture.remote, "update-ref", "refs/heads/feature/alpha", fixture.experimental, fixture.alpha)
            return run(label, *arguments)

        fixture.git.run = race
        with self.assertRaisesRegex(cleanup.CleanupError, "delete branches atomically failed"):
            fixture.apply()
        before["refs/heads/feature/alpha"] = fixture.experimental
        self.assertEqual(fixture.heads(), before)
        self.assertEqual(fixture.heads()["refs/heads/main"], fixture.main)

    def test_tag_conflict_aborts_without_deleting_or_overwriting(self):
        fixture = self.fixture
        tag = "refs/tags/" + fixture.policy.archive + "feature/alpha"
        raw_git(fixture.remote, "update-ref", tag, fixture.experimental)
        before = fixture.heads()
        with self.assertRaisesRegex(cleanup.CleanupError, "Archive tag conflicts"):
            fixture.prepare()
        self.assertEqual(fixture.heads(), before)
        self.assertEqual(fixture.git.remote_refs()[tag], fixture.experimental)

    def test_new_unknown_branch_fails_closed_before_archive(self):
        fixture = self.fixture
        raw_git(fixture.remote, "update-ref", "refs/heads/new-work", fixture.main)
        before = fixture.heads()
        with self.assertRaisesRegex(cleanup.CleanupError, "exact approved inventory"):
            fixture.prepare()
        self.assertEqual(fixture.heads(), before)
        self.assertFalse(any(r.startswith("refs/tags/") for r in fixture.git.remote_refs()))

    def test_new_unknown_branch_after_backup_prevents_deletion(self):
        fixture = self.fixture
        fixture.prepare()
        raw_git(fixture.remote, "update-ref", "refs/heads/new-work", fixture.main)
        before = fixture.heads()
        with self.assertRaisesRegex(cleanup.CleanupError, "exact approved inventory"):
            fixture.apply()
        self.assertEqual(fixture.heads(), before)

    def test_prepare_resumes_partial_archives_without_overwriting_them(self):
        fixture = self.fixture
        tag = next(iter(fixture.plan["tags"]))
        raw_git(fixture.remote, "update-ref", tag, fixture.plan["tags"][tag])
        fixture.prepare()
        fixture.prepare()
        self.assertEqual(fixture.heads(), fixture.plan["heads"])
        self.assertEqual(fixture.git.remote_refs()[tag], fixture.plan["tags"][tag])
        fixture.apply()
        self.assertEqual(fixture.heads(), {"refs/heads/main": fixture.main})

    def test_corrupted_bundle_prevents_deletion(self):
        fixture = self.fixture
        fixture.prepare()
        with (fixture.output / "repository.bundle").open("ab") as stream:
            stream.write(b"corrupt")
        with self.assertRaisesRegex(cleanup.CleanupError, "digest mismatch"):
            fixture.apply()
        self.assertEqual(fixture.heads(), fixture.plan["heads"])

    def test_missing_artifact_receipt_prevents_deletion(self):
        fixture = self.fixture
        fixture.prepare()
        del fixture.environment["CLEANUP_BACKUP_ARTIFACT_ID"]
        with self.assertRaisesRegex(cleanup.CleanupError, "artifact ID required"):
            fixture.apply()
        self.assertEqual(fixture.heads(), fixture.plan["heads"])

    def test_truncated_pack_cannot_pass_as_a_verified_backup(self):
        fixture = self.fixture
        fixture.prepare()
        bundle = fixture.output / "repository.bundle"
        bundle.write_bytes(bundle.read_bytes()[:-32])
        manifest_path = fixture.output / "recovery-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["bundle"]["sha256"] = cleanup.hash_file(bundle)
        cleanup.write_json(manifest_path, manifest)
        with self.assertRaises(cleanup.CleanupError):
            fixture.apply()
        self.assertEqual(fixture.heads(), fixture.plan["heads"])

    def test_wrong_execution_environment_and_changed_main_are_rejected(self):
        fixture = self.fixture
        for key, value in [("GITHUB_REF", "refs/heads/main"), ("GITHUB_EVENT_NAME", "pull_request"),
                           ("GITHUB_REPOSITORY", "other/repository"), ("GITHUB_SHA", fixture.alpha)]:
            with self.subTest(key=key):
                environment = {**fixture.environment, key: value}
                with self.assertRaises(cleanup.CleanupError):
                    cleanup.load_plan(fixture.manifest, fixture.git, environment, fixture.policy)
        raw_git(fixture.remote, "update-ref", "refs/heads/main", fixture.alpha, fixture.main)
        with self.assertRaisesRegex(cleanup.CleanupError, "exact approved inventory"):
            fixture.prepare()
        self.assertEqual(fixture.heads()["refs/heads/main"], fixture.alpha)

    def test_uploaded_artifact_is_bound_to_current_run_revision_and_digest(self):
        fixture = self.fixture
        artifact = {"id": 67890, "name": "main-consolidation-backup-12345-1", "expired": False,
                    "size_in_bytes": 123, "digest": "sha256:" + "a" * 64,
                    "workflow_run": {"id": 12345, "head_sha": fixture.maintenance, "head_branch": fixture.policy.maintenance}}
        with mock.patch.object(cleanup, "github_json", return_value=artifact):
            self.assertEqual(cleanup.verify_artifact(fixture.environment, fixture.policy)["id"], "67890")
        for change in [{"expired": True}, {"digest": "sha256:" + "b" * 64}, {"size_in_bytes": 0},
                       {"workflow_run": {"id": 999}}, {"name": "unrelated-backup"}]:
            with self.subTest(change=change), mock.patch.object(cleanup, "github_json", return_value={**artifact, **change}):
                with self.assertRaises(cleanup.CleanupError):
                    cleanup.verify_artifact(fixture.environment, fixture.policy)

    def test_ci_gate_requires_exact_main_and_complete_successful_job_set(self):
        fixture = self.fixture
        run = {"id": fixture.policy.ci_run, "repository": {"full_name": fixture.policy.repository},
               "head_sha": fixture.main, "head_branch": "main", "event": "push", "status": "completed", "conclusion": "success"}
        items = [{"id": i, "name": "required" if i == 0 else f"job-{i}", "status": "completed", "conclusion": "success"} for i in range(47)]
        jobs = {"total_count": 47, "jobs": items}
        with mock.patch.object(cleanup, "github_json", side_effect=[run, jobs]):
            self.assertEqual(cleanup.verify_ci(fixture.environment, fixture.policy)["job_count"], 47)
        for bad_run, bad_jobs in [({**run, "head_sha": fixture.alpha}, jobs),
                                  (run, {"total_count": 47, "jobs": items[:-1]}),
                                  (run, {"total_count": 47, "jobs": [{**items[0], "conclusion": "skipped"}, *items[1:]]})]:
            with self.subTest(run=bad_run["head_sha"], jobs=len(bad_jobs["jobs"])), mock.patch.object(cleanup, "github_json", side_effect=[bad_run, bad_jobs]):
                with self.assertRaises(cleanup.CleanupError):
                    cleanup.verify_ci(fixture.environment, fixture.policy)


if __name__ == "__main__":
    unittest.main(verbosity=2)
