import argparse
import base64
import dataclasses
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


class CleanupError(Exception):
    pass


@dataclasses.dataclass(frozen=True)
class Policy:
    repository: str = "Hubujiu/local-api-workbench"
    main: str = "f59b11ac3dc96c567db155dd871ef08ba445937c"
    maintenance: str = "maintenance/finalize-main-20261117"
    archive: str = "archive/main-consolidation-2026-11-17/"
    branch_count: int = 337
    ci_run: int = 44130790449
    ci_jobs: int = 47
    remote_url: str = "https://github.com/Hubujiu/local-api-workbench"


PRODUCTION = Policy()
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"(?:sha256:)?[0-9a-f]{64}\Z")


def require(condition, message):
    if not condition:
        raise CleanupError(message)


def bounded_diagnostic(value):
    for key in ("GITHUB_TOKEN", "GH_TOKEN"):
        token = os.environ.get(key, "")
        if token:
            for secret in (token, base64.b64encode(("x-access-token:" + token).encode()).decode()):
                value = value.replace(secret, "[redacted]")
    value = re.sub(r"https?://[^\s/@]+(?::[^\s/@]*)?@", "https://[redacted]@", value)
    value = re.sub(r"(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)", "[redacted]", value)
    value = re.sub(r"(?im)^.*(?:authorization|extraheader).*$", "[redacted authorization header]", value)
    lines = value.strip().splitlines()
    return "\n".join(lines if len(lines) <= 16 else lines[:8] + ["[truncated]"] + lines[-8:])[:2400]


class Git:
    def __init__(self, directory):
        self.directory = pathlib.Path(directory)

    def run(self, label, *arguments):
        try:
            result = subprocess.run(
                ["git", *arguments], cwd=self.directory, text=True,
                capture_output=True, timeout=240, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise CleanupError(f"Git {label} could not complete") from error
        if result.returncode != 0:
            detail = bounded_diagnostic(result.stderr)
            raise CleanupError(f"Git {label} failed (exit {result.returncode}): {detail}")
        return result.stdout.strip()

    def remote_refs(self):
        lines = self.run("read remote refs", "ls-remote", "--refs", "origin").splitlines()
        refs = {}
        for line in lines:
            sha, ref = line.split("\t", 1)
            require(SHA.fullmatch(sha) is not None, "Invalid remote object ID")
            require(ref not in refs, "Duplicate remote ref")
            refs[ref] = sha
        return refs


def write_json(path, value):
    path = pathlib.Path(path)
    temporary = path.with_name(path.name + ".pending")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def hash_file(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_plan(path, git, environment, policy):
    manifest = json.loads(pathlib.Path(path).read_text())
    require(manifest.get("schema_version") == 1, "Unsupported manifest schema")
    require(manifest.get("repository") == policy.repository, "Manifest repository mismatch")
    require(manifest.get("main_sha") == policy.main, "Manifest main mismatch")
    require(manifest.get("maintenance_branch") == policy.maintenance, "Maintenance branch mismatch")
    require(manifest.get("archive_prefix") == policy.archive, "Archive prefix mismatch")
    heads = manifest.get("heads")
    require(isinstance(heads, dict) and len(heads) == policy.branch_count, "Incomplete original head inventory")
    for ref, sha in heads.items():
        require(isinstance(ref, str) and ref.startswith("refs/heads/"), "Invalid manifest branch")
        require(isinstance(sha, str) and SHA.fullmatch(sha) is not None, "Invalid manifest SHA")
        git.run("validate branch name", "check-ref-format", ref)
    require(heads.get("refs/heads/main") == policy.main, "Original main is not pinned")
    maintenance_ref = "refs/heads/" + policy.maintenance
    require(maintenance_ref not in heads, "Maintenance ref already present in original snapshot")
    require(environment.get("GITHUB_REPOSITORY") == policy.repository, "Wrong GitHub repository")
    require(environment.get("GITHUB_SERVER_URL") == "https://github.com", "Wrong GitHub server")
    require(environment.get("GITHUB_REF") == maintenance_ref, "Wrong triggering ref")
    require(environment.get("GITHUB_EVENT_NAME") == "push", "Only exact-branch push is allowed")
    head = environment.get("GITHUB_SHA", "")
    require(SHA.fullmatch(head) is not None and head != policy.main, "Invalid maintenance SHA")
    require(git.run("read checkout head", "rev-parse", "HEAD") == head, "Checkout differs from triggering SHA")
    remote_url = git.run("read origin", "remote", "get-url", "origin")
    require(remote_url.removesuffix(".git") == policy.remote_url.removesuffix(".git"), "Origin repository mismatch")
    git.run("check maintenance ancestry", "merge-base", "--is-ancestor", policy.main, head)
    expected_heads = dict(heads)
    expected_heads[maintenance_ref] = head
    deletions = {ref: sha for ref, sha in expected_heads.items() if ref != "refs/heads/main"}
    require(len(deletions) == policy.branch_count, "Unexpected deletion count")
    tags = {"refs/tags/" + policy.archive + ref.removeprefix("refs/heads/"): sha for ref, sha in deletions.items()}
    for tag in tags:
        git.run("validate archive name", "check-ref-format", tag)
    return {"heads": expected_heads, "deletions": deletions, "tags": tags, "head": head}


def check_remote(refs, plan, policy, complete_tags=False, final=False):
    heads = {ref: sha for ref, sha in refs.items() if ref.startswith("refs/heads/")}
    expected = {"refs/heads/main": policy.main} if final else plan["heads"]
    require(heads == expected, "Remote heads differ from exact approved inventory")
    prefix = "refs/tags/" + policy.archive
    actual_tags = {ref: sha for ref, sha in refs.items() if ref.startswith(prefix)}
    require(not set(actual_tags) - set(plan["tags"]), "Unknown archive tag in reserved prefix")
    for ref, sha in actual_tags.items():
        require(plan["tags"][ref] == sha, "Archive tag conflicts with approved SHA")
    if complete_tags:
        require(actual_tags == plan["tags"], "Archive tags are incomplete")


def github_json(path, token):
    request = urllib.request.Request(
        "https://api.github.com" + path,
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "main-consolidation-maintenance"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except (OSError, ValueError, urllib.error.HTTPError) as error:
        raise CleanupError("GitHub CI verification request failed") from error


def verify_ci(environment, policy):
    token = environment.get("GITHUB_TOKEN", "")
    require(bool(token), "GITHUB_TOKEN is required for CI verification")
    prefix = f"/repos/{policy.repository}/actions/runs/{policy.ci_run}"
    run = github_json(prefix, token)
    require(run.get("id") == policy.ci_run, "CI run ID mismatch")
    require(run.get("repository", {}).get("full_name") == policy.repository, "CI repository mismatch")
    require(run.get("head_sha") == policy.main and run.get("head_branch") == "main", "CI tested a different main")
    require(run.get("event") == "push", "CI must be main push evidence")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "Main CI is not successful")
    jobs = github_json(prefix + "/jobs?filter=latest&per_page=100", token)
    items = jobs.get("jobs", [])
    require(jobs.get("total_count") == policy.ci_jobs and len(items) == policy.ci_jobs, "Incomplete CI job inventory")
    require(len({job.get("id") for job in items}) == policy.ci_jobs, "Duplicate CI jobs")
    require(all(job.get("status") == "completed" and job.get("conclusion") == "success" for job in items), "A main CI job is not successful")
    require(any(job.get("name") == "required" for job in items), "Required CI aggregation job missing")
    return {"run_id": policy.ci_run, "head_sha": policy.main, "run_attempt": run.get("run_attempt"),
            "job_count": len(items), "conclusion": "success", "jobs": [{"id": j["id"], "name": j["name"]} for j in items]}


def artifact_receipt(environment, policy):
    identifier = environment.get("CLEANUP_BACKUP_ARTIFACT_ID", "")
    run_id = environment.get("GITHUB_RUN_ID", "")
    url = environment.get("CLEANUP_BACKUP_ARTIFACT_URL", "")
    digest = environment.get("CLEANUP_BACKUP_ARTIFACT_DIGEST", "")
    require(identifier.isdecimal() and int(identifier) > 0, "Uploaded backup artifact ID required")
    require(run_id.isdecimal() and int(run_id) > 0, "Current workflow run ID required")
    require(url == f"https://github.com/{policy.repository}/actions/runs/{run_id}/artifacts/{identifier}", "Uploaded backup artifact URL mismatch")
    require(DIGEST.fullmatch(digest) is not None, "Uploaded backup artifact digest required")
    return {"id": identifier, "url": url, "digest": digest}


def verify_artifact(environment, policy):
    receipt = artifact_receipt(environment, policy)
    token = environment.get("GITHUB_TOKEN", "")
    require(bool(token), "GITHUB_TOKEN is required for backup verification")
    artifact = github_json(f"/repos/{policy.repository}/actions/artifacts/{receipt['id']}", token)
    run_id = environment["GITHUB_RUN_ID"]
    attempt = environment.get("GITHUB_RUN_ATTEMPT", "")
    require(attempt.isdecimal() and int(attempt) > 0, "Current workflow attempt required")
    require(artifact.get("id") == int(receipt["id"]), "Backup artifact ID mismatch")
    require(artifact.get("name") == f"main-consolidation-backup-{run_id}-{attempt}", "Backup artifact name mismatch")
    require(artifact.get("expired") is False and artifact.get("size_in_bytes", 0) > 0, "Backup artifact unavailable")
    workflow = artifact.get("workflow_run", {})
    require(workflow.get("id") == int(run_id), "Backup belongs to another workflow run")
    require(workflow.get("head_sha") == environment["GITHUB_SHA"], "Backup belongs to another maintenance revision")
    require(workflow.get("head_branch") == policy.maintenance, "Backup belongs to another branch")
    require(artifact.get("digest", "").removeprefix("sha256:") == receipt["digest"].removeprefix("sha256:"), "Uploaded backup artifact digest mismatch")
    return receipt


def verify_bundle(git, bundle, plan):
    git.run("verify bundle", "bundle", "verify", str(bundle))
    bundled = {}
    for line in git.run("list bundle refs", "bundle", "list-heads", str(bundle)).splitlines():
        sha, ref = line.split(" ", 1)
        bundled[ref] = sha
    for ref, sha in plan["tags"].items():
        require(bundled.get(ref) == sha, "Bundle lacks an exact archive tag")
    for ref, sha in plan["heads"].items():
        tracking = "refs/remotes/origin/" + ref.removeprefix("refs/heads/")
        require(bundled.get(tracking) == sha, "Bundle lacks an exact original remote head")
    with tempfile.TemporaryDirectory(prefix="main-consolidation-restore-") as temporary:
        restored = pathlib.Path(temporary) / "restored.git"
        git.run("restore backup independently", "clone", "--mirror", str(bundle), str(restored))
        recovered = Git(restored)
        recovered.run("verify recovered objects", "fsck", "--full")
        restored_refs = {}
        for line in recovered.run("inspect recovered refs", "for-each-ref", "--format=%(objectname) %(refname)").splitlines():
            sha, ref = line.split(" ", 1)
            restored_refs[ref] = sha
        require(all(restored_refs.get(ref) == sha for ref, sha in bundled.items() if ref != "HEAD"), "Restored refs differ from bundle")


def prepare(git, plan, output, environment, policy, ci_check=verify_ci):
    ci = ci_check(environment, policy)
    refs = git.remote_refs()
    check_remote(refs, plan, policy)
    git.run("fetch complete objects", "fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*")
    check_remote(git.remote_refs(), plan, policy)
    missing = {ref: sha for ref, sha in plan["tags"].items() if ref not in refs}
    if missing:
        leases = ["--force-with-lease=" + ref + ":" for ref in sorted(missing)]
        refspecs = [missing[ref] + ":" + ref for ref in sorted(missing)]
        git.run("archive heads atomically", "push", "--atomic", *leases, "origin", *refspecs)
    check_remote(git.remote_refs(), plan, policy, complete_tags=True)
    git.run("fetch archive objects", "fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*")
    bundle = output / "repository.bundle"
    pending = output / "repository.pending.bundle"
    if pending.exists():
        pending.unlink()
    git.run("create full backup bundle", "bundle", "create", str(pending), "--all")
    verify_bundle(git, pending, plan)
    pending.replace(bundle)
    check_remote(git.remote_refs(), plan, policy, complete_tags=True)
    manifest = {"schema_version": 1, "repository": policy.repository, "main_sha": policy.main,
                "maintenance_sha": plan["head"], "heads": plan["heads"], "archive_tags": plan["tags"],
                "bundle": {"filename": bundle.name, "sha256": hash_file(bundle)}, "main_ci": ci,
                "restore_example": "git push origin refs/tags/" + policy.archive + "BRANCH:refs/heads/BRANCH"}
    write_json(output / "recovery-manifest.json", manifest)
    (output / "repository.bundle.sha256").write_text(manifest["bundle"]["sha256"] + "  repository.bundle\n")
    result = {"status": "prepared", "main_sha": policy.main, "archive_count": len(plan["tags"]),
              "planned_deletion_count": len(plan["deletions"]), "bundle_sha256": manifest["bundle"]["sha256"]}
    write_json(output / "cleanup-result.json", result)
    return result


def apply(git, plan, output, environment, policy, ci_check=verify_ci, artifact_check=verify_artifact):
    receipt = artifact_check(environment, policy)
    manifest = json.loads((output / "recovery-manifest.json").read_text())
    require(manifest.get("schema_version") == 1 and manifest.get("repository") == policy.repository, "Invalid recovery manifest")
    require(manifest.get("main_sha") == policy.main and manifest.get("maintenance_sha") == plan["head"], "Recovery manifest revision mismatch")
    require(manifest.get("heads") == plan["heads"] and manifest.get("archive_tags") == plan["tags"], "Recovery ref inventory mismatch")
    require(manifest.get("bundle", {}).get("filename") == "repository.bundle", "Invalid bundle path")
    bundle = output / "repository.bundle"
    require(hash_file(bundle) == manifest["bundle"].get("sha256"), "Backup bundle digest mismatch")
    verify_bundle(git, bundle, plan)
    ci = ci_check(environment, policy)
    check_remote(git.remote_refs(), plan, policy, complete_tags=True)
    require("refs/heads/main" not in plan["deletions"], "Main must never be deleted")
    require(all(ref.startswith("refs/heads/") for ref in plan["deletions"]), "Non-branch deletion rejected")
    leases = ["--force-with-lease=" + ref + ":" + plan["deletions"][ref] for ref in sorted(plan["deletions"])]
    refspecs = [":" + ref for ref in sorted(plan["deletions"])]
    git.run("delete branches atomically", "push", "--atomic", *leases, "origin", *refspecs)
    final_refs = git.remote_refs()
    check_remote(final_refs, plan, policy, complete_tags=True, final=True)
    result = {"status": "completed", "main_sha": policy.main, "remaining_heads": {"refs/heads/main": policy.main},
              "deleted_branch_count": len(plan["deletions"]), "verified_archive_count": len(plan["tags"]),
              "bundle_sha256": manifest["bundle"]["sha256"], "backup_artifact": receipt, "main_ci": ci}
    write_json(output / "cleanup-result.json", result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--phase", choices=("prepare", "apply"), required=True)
    arguments = parser.parse_args()
    output = pathlib.Path(arguments.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    try:
        git = Git(pathlib.Path.cwd())
        plan = load_plan(arguments.manifest, git, os.environ, PRODUCTION)
        operation = prepare if arguments.phase == "prepare" else apply
        result = operation(git, plan, output, os.environ, PRODUCTION)
    except (CleanupError, OSError, ValueError, KeyError, TypeError) as error:
        message = str(error) if isinstance(error, CleanupError) else type(error).__name__
        result = {"status": "failed", "phase": arguments.phase, "error": message}
        write_json(output / "cleanup-result.json", result)
        print(json.dumps(result, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
