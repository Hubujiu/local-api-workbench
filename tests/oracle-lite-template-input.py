"""Audited pure bridge: export template strings, or validate synthetic Go output.

No subprocess, Docker, network, application import, or collector main call. Run
only after closure audit. The collector module is loaded under a non-main name;
its import-time work is stdlib imports/constants and template string building.
"""

import importlib.util
import json
from pathlib import Path
import sys

SOURCE = Path(__file__).parents[1] / "scripts" / "oracle-lite-inventory.py"
SPEC = importlib.util.spec_from_file_location("oracle_lite_template_definitions", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main():
    if sys.argv[1:] == ["export"]:
        print(json.dumps({
            "imageFormat": MODULE.IMAGE_FORMAT,
            "containerFormat": MODULE.CONTAINER_FORMAT,
            "cleanupFormat": MODULE.CLEANUP_FORMAT,
            "clearKeys": list(MODULE.ENV_CLEAR_KEYS),
            "labelKey": MODULE.LABEL, "uid": MODULE.UID,
            "repoDigest": MODULE.REPO_DIGEST,
        }))
        return
    if len(sys.argv) != 3 or sys.argv[1] != "verify":
        raise SystemExit("Expected export or verify SYNTHETIC_RESULT_JSON")
    with Path(sys.argv[2]).open("rb") as handle:
        raw = handle.read(262145)
    if len(raw) > 262144:
        raise SystemExit("Synthetic result exceeds bound")
    result = json.loads(raw)
    if result["passed"] < 16 or result["failed"] != 0:
        raise SystemExit("Synthetic Go fixture did not pass")
    for entry in result["containers"]:
        MODULE.validate_container(entry["inspection"], "sha256:" + "2" * 64,
                                  ["synthetic-reviewed-command"], entry["volumes"],
                                  "synthetic-owner", set())
        MODULE.validate_cleanup_identity(entry["cleanup"], "synthetic-owner",
                                         "1" * 64, "sha256:" + "2" * 64)
        MODULE.new_anonymous_mounts(entry["cleanup"], entry["volumes"], set())
    for entry in result["images"]:
        if MODULE.validate_image(entry["inspection"]) != entry["volumes"]:
            raise SystemExit("Synthetic image-volume mismatch")
    print("Production validators accepted all Go-rendered synthetic fixtures.")


if __name__ == "__main__":
    main()
