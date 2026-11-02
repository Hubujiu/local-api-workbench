"""Pure fixtures. Run only after independent source/closure audit.

This loads definitions under a non-main module name. No main(), subprocess,
Docker, image, network, shell, Oracle, Java, build, or service operation is called.
"""

import copy
import importlib.util
from pathlib import Path
import unittest


SOURCE = Path(__file__).parents[1] / "scripts" / "oracle-lite-inventory.py"
SPEC = importlib.util.spec_from_file_location("oracle_lite_inventory_definitions", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def wire(*values):
    return b"\0".join(value.encode() for value in values) + b"\0"


def inventory(file_record=b"", status="complete"):
    result = b""
    for index, root in enumerate(MODULE.ROOTS):
        result += wire("BEGIN", root)
        if index == 0:
            result += file_record
        result += wire("END", root, status if index == 0 else "absent", "1" if index == 0 and status not in {"absent", "unreadable", "not-inspected", "symlink-ancestor"} else "0")
    return result + wire("DONE")


def file_record(path="/opt/oracle/bin/orapki", category="tool-candidate", hash_status="sha256", digest="a" * 64, kind="f", size="1024"):
    return wire("FILE", "/opt/oracle", kind, "755", size, path, category, hash_status, digest)


def safe_container():
    return {
        "id": "1" * 64, "image": "sha256:" + "2" * 64,
        "path": "/usr/bin/env", "args": ["reviewed-literal-command"],
        "user": MODULE.UID, "workingDir": "/", "restartPolicy": "no", "entrypoint": ["/usr/bin/env"], "cmd": ["reviewed-literal-command"],
        "readonly": True, "network": "none", "privileged": False,
        "memory": 268435456, "memorySwap": 268435456,
        "nanoCpus": 1000000000, "pidsLimit": 32, "ipcMode": "none",
        "pidMode": "", "utsMode": "", "usernsMode": "",
        "publishAllPorts": False, "logType": "none", "running": False,
        "labels": {MODULE.LABEL: "owner"}, "capDrop": ["ALL"],
        "securityOpt": ["no-new-privileges=true"],
        "healthcheck": {"Test": ["NONE"]}, "networks": {"none": {}},
        "ulimits": [{"Name": "core", "Soft": 0, "Hard": 0}, {"Name": "nofile", "Soft": 64, "Hard": 64}],
        "requestedMounts": [{"Type": "volume", "Target": "/opt/oracle/oradata", "ReadOnly": True, "VolumeOptions": {"DriverConfig": {"Name": "local"}}}],
        "mounts": [{"name": "3" * 64, "driver": "local", "type": "volume", "destination": "/opt/oracle/oradata", "rw": False}],
        "status": "created", "exitCode": 0, "oomKilled": False,
        "hookEnvironment": [None] + [{"key": key, "cleared": True} for key in MODULE.ENV_CLEAR_KEYS],
    }


def validate(info, old_volumes=None, started=False):
    return MODULE.validate_container(info, "sha256:" + "2" * 64, ["reviewed-literal-command"], ["/opt/oracle/oradata"], "owner", old_volumes or set(), started=started)


class ParserFixtures(unittest.TestCase):
    def test_complete_empty_scope_is_only_metadata(self):
        result = MODULE.parse_inventory(inventory())
        self.assertTrue(result["protocolComplete"])
        self.assertEqual(result["files"], [])
        self.assertNotIn("runtimeAcceptance", result)

    def test_regular_tool_hash(self):
        result = MODULE.parse_inventory(inventory(file_record()))
        self.assertTrue(result["protocolComplete"])
        self.assertEqual(result["files"][0]["sha256"], "a" * 64)

    def test_wallet_metadata_has_no_hash(self):
        record = file_record("/opt/oracle/wallet/ewallet.p12", "wallet-metadata", "metadata-only-wallet", "")
        result = MODULE.parse_inventory(inventory(record))
        self.assertTrue(result["protocolComplete"])
        self.assertNotIn("sha256", result["files"][0])

    def test_wallet_hash_and_disguised_tool_rejected(self):
        for path, category in [("/opt/oracle/ewallet.p12", "wallet-metadata"), ("/opt/oracle/wallet/oraclepki.jar", "tool-candidate"), ("/opt/oracle/secret/orapki", "tool-candidate")]:
            with self.subTest(path=path):
                result = MODULE.parse_inventory(inventory(file_record(path, category)))
                self.assertFalse(result["protocolComplete"])
                self.assertEqual(result["files"], [])

    def test_unknown_candidate_and_outside_scope_rejected(self):
        for path in ["/opt/oracle/arbitrary.bin", "/etc/passwd", "/opt/oracle-other/orapki"]:
            self.assertFalse(MODULE.parse_inventory(inventory(file_record(path)))["protocolComplete"])

    def test_symlink_hash_and_hash_budget_rejected(self):
        for record in [file_record(kind="l"), file_record(size="33554433")]:
            self.assertFalse(MODULE.parse_inventory(inventory(record))["protocolComplete"])

    def test_truncated_protocol_is_not_complete(self):
        for blob in [inventory()[:-1], inventory()[:-6], inventory(file_record())[:100], inventory() + wire("DONE")]:
            self.assertFalse(MODULE.parse_inventory(blob)["protocolComplete"])

    def test_scan_failure_is_preserved_not_absent(self):
        for status in ["unreadable", "scan-error", "depth-limit", "entry-limit", "candidate-limit", "hash-incomplete", "symlink-root"]:
            result = MODULE.parse_inventory(inventory(status=status))
            self.assertTrue(result["protocolComplete"])
            self.assertEqual(result["prefixes"][0]["status"], status)

    def test_protocol_byte_limit(self):
        with self.assertRaises(MODULE.ProbeError):
            MODULE.parse_inventory(b"x" * (MODULE.MAX_OUTPUT + 1))

    def test_complete_cannot_hide_hash_failure_or_files_under_absence(self):
        for status in ["size-limit", "budget-limit", "read-error"]:
            record = file_record(hash_status=status, digest="")
            self.assertFalse(MODULE.parse_inventory(inventory(record))["protocolComplete"])
        self.assertFalse(MODULE.parse_inventory(inventory(file_record(), status="absent"))["protocolComplete"])

    def test_depth_and_aggregate_visit_limits(self):
        too_deep = "/opt/oracle/" + "d/" * 16 + "orapki"
        self.assertFalse(MODULE.parse_inventory(inventory(file_record(too_deep)))["protocolComplete"])
        excessive = inventory().replace(wire("END", "/opt/oracle", "complete", "1"), wire("END", "/opt/oracle", "complete", "100001"))
        self.assertFalse(MODULE.parse_inventory(excessive)["protocolComplete"])
        empty_present = inventory().replace(wire("END", "/opt/oracle", "complete", "1"), wire("END", "/opt/oracle", "complete", "0"))
        self.assertFalse(MODULE.parse_inventory(empty_present)["protocolComplete"])


class RestrictionFixtures(unittest.TestCase):
    def test_minimal_cleanup_identity_never_needs_runtime_restrictions(self):
        info = {"id": "1" * 64, "image": "sha256:" + "2" * 64, "labels": {MODULE.LABEL: "owner"}, "requestedMounts": None, "mounts": []}
        MODULE.validate_cleanup_identity(info, "owner", "1" * 64, "sha256:" + "2" * 64)
        self.assertEqual(MODULE.new_anonymous_mounts(info, [], set()), [])
        for key, value in [("id", "3" * 64), ("image", "other"), ("labels", {MODULE.LABEL: "other"})]:
            changed = copy.deepcopy(info)
            changed[key] = value
            with self.assertRaises(MODULE.ProbeError):
                MODULE.validate_cleanup_identity(changed, "owner", "1" * 64, "sha256:" + "2" * 64)

    def test_expected_restrictions(self):
        proof = validate(safe_container())
        self.assertTrue(proof["readonly"])
        self.assertTrue(proof["mounts"][0]["newAnonymousVolume"])
        self.assertNotIn("name", proof["mounts"][0])

    def test_wrong_identity_and_unsafe_restrictions(self):
        for key, value in [("image", "wrong"), ("user", "0:0"), ("path", "/opt/oracle/runOracle.sh"), ("readonly", False), ("network", "host"), ("privileged", True), ("capAdd", ["SYS_ADMIN"]), ("securityOpt", []), ("pidsLimit", 0), ("binds", ["/:/host"]), ("portBindings", {"2484/tcp": [{}]}), ("healthcheck", {"Test": ["CMD", "oracle"]})]:
            with self.subTest(key=key):
                info = safe_container()
                info[key] = value
                with self.assertRaises(MODULE.ProbeError):
                    validate(info)

    def test_mount_rw_source_host_and_existing_volume_rejected(self):
        cases = []
        info = safe_container()
        info["mounts"][0]["rw"] = True
        cases.append(info)
        info = safe_container()
        info["requestedMounts"][0]["Source"] = "existing"
        cases.append(info)
        info = safe_container()
        info["mounts"][0]["type"] = "bind"
        cases.append(info)
        info = safe_container()
        info["mounts"][0]["driver"] = "remote-plugin"
        cases.append(info)
        info = safe_container()
        info["requestedMounts"][0]["VolumeOptions"]["DriverConfig"]["Options"] = {"device": "/host", "o": "bind"}
        cases.append(info)
        for info in cases:
            with self.assertRaises(MODULE.ProbeError):
                validate(info)
        with self.assertRaises(MODULE.ProbeError):
            validate(safe_container(), {"3" * 64})

    def test_initialization_hooks_must_all_be_cleared_without_duplicates(self):
        info = safe_container()
        info["hookEnvironment"][1]["cleared"] = False
        with self.assertRaises(MODULE.ProbeError):
            validate(info)
        info = safe_container()
        info["hookEnvironment"].pop()
        with self.assertRaises(MODULE.ProbeError):
            validate(info)
        info = safe_container()
        info["hookEnvironment"][-1] = info["hookEnvironment"][1]
        with self.assertRaises(MODULE.ProbeError):
            validate(info)

    def test_after_exit_still_requires_restrictions_and_success(self):
        info = safe_container()
        info["status"] = "exited"
        validate(info, started=True)
        for key, value in [("running", True), ("oomKilled", True), ("exitCode", 1)]:
            changed = copy.deepcopy(info)
            changed[key] = value
            with self.assertRaises(MODULE.ProbeError):
                validate(changed, started=True)

    def test_only_exact_image_and_canonical_oracle_volumes(self):
        info = {"id": "sha256:" + "4" * 64, "digests": [MODULE.REPO_DIGEST], "os": "linux", "architecture": "amd64", "volumes": {"/opt/oracle/oradata": {}}}
        self.assertEqual(MODULE.validate_image(info), ["/opt/oracle/oradata"])
        for key, value in [("digests", ["other"]), ("architecture", "arm64"), ("volumes", {"/host": {}}), ("volumes", {"/opt/oracle/../secret": {}}), ("volumes", {"/opt/oracle/a": {}, "/opt/oracle/a/b": {}})]:
            changed = copy.deepcopy(info)
            changed[key] = value
            with self.assertRaises(MODULE.ProbeError):
                MODULE.validate_image(changed)


if __name__ == "__main__":
    unittest.main()
