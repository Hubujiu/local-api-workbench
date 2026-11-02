#!/usr/bin/env python3
"""Read-only capability metadata; never database or TCPS acceptance.

No third-party imports. The main guard is the ONLY runtime entry. Parser and
restriction validation functions are pure so they can be audited/tested without
Docker. Raw Docker errors, image environment, and file contents are never saved.
"""

import json
import os
import re
import selectors
import signal
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

IMAGE = "container-registry.oracle.com/database/free:23.26.3.0-lite-amd64@sha256:770ca58ab319d8cfde610b0db25c06899ce0af9591c4addfa10d2cb8f0318e65"
REPO_DIGEST = IMAGE.split(":23.", 1)[0] + "@" + IMAGE.split("@", 1)[1]
BRANCH = "refs/heads/wip/oracle-lite-capability-probe"
ROOTS = (
    "/opt/oracle", "/usr/lib/jvm", "/usr/lib64/jvm", "/usr/java",
    "/usr/share/java", "/etc/oracle", "/etc/pki", "/usr/bin/java", "/bin/java",
)
MAX_OUTPUT = 2 * 1024 * 1024
MAX_JSON = 3 * 1024 * 1024
UID = "65534:65534"
DOCKER = "/usr/bin/docker"
LABEL = "io.localapi.oracle-lite-inventory"
ENV_CLEAR_KEYS = (
    "BASH_ENV", "ENV", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH",
    "LD_DEBUG", "LD_DEBUG_OUTPUT", "LD_PROFILE", "LD_SHOW_AUXV",
    "LD_ORIGIN_PATH", "GLIBC_TUNABLES", "GCONV_PATH", "LOCPATH", "NLSPATH",
)
HASH_STATES = {"sha256", "metadata-only-wallet", "not-regular", "size-limit", "budget-limit", "read-error"}
SCAN_STATES = {"complete", "absent", "unreadable", "not-inspected", "scan-error", "entry-limit", "depth-limit", "path-limit", "candidate-limit", "hash-incomplete", "symlink-root", "symlink-ancestor"}
IMAGE_FORMAT = '{"id":{{json .Id}},"digests":{{json .RepoDigests}},"os":{{json .Os}},"architecture":{{json .Architecture}},"volumes":{{json .Config.Volumes}},"size":{{json .Size}}}'
# Selected fields only: no raw Env values, inspect dump, or host mount Source.
CONTAINER_FORMAT = '''{"id":{{json .Id}},"image":{{json .Image}},"path":{{json .Path}},"args":{{json .Args}},"user":{{json .Config.User}},"workingDir":{{json .Config.WorkingDir}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"healthcheck":{{json .Config.Healthcheck}},"labels":{{json .Config.Labels}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"network":{{json .HostConfig.NetworkMode}},"privileged":{{json .HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"memory":{{json .HostConfig.Memory}},"memorySwap":{{json .HostConfig.MemorySwap}},"nanoCpus":{{json .HostConfig.NanoCpus}},"pidsLimit":{{json .HostConfig.PidsLimit}},"ipcMode":{{json .HostConfig.IpcMode}},"pidMode":{{json .HostConfig.PidMode}},"utsMode":{{json .HostConfig.UTSMode}},"usernsMode":{{json .HostConfig.UsernsMode}},"binds":{{json .HostConfig.Binds}},"volumesFrom":{{json .HostConfig.VolumesFrom}},"devices":{{json .HostConfig.Devices}},"deviceRequests":{{json .HostConfig.DeviceRequests}},"portBindings":{{json .HostConfig.PortBindings}},"publishAllPorts":{{json .HostConfig.PublishAllPorts}},"logType":{{json .HostConfig.LogConfig.Type}},"ulimits":{{json .HostConfig.Ulimits}},"requestedMounts":{{json .HostConfig.Mounts}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"name":{{json $m.Name}},"driver":{{json $m.Driver}},"type":{{json $m.Type}},"destination":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}],"networks":{{json .NetworkSettings.Networks}},"running":{{json .State.Running}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}}}'''
# Transform only these selected environment entries into safe key/boolean pairs.
# Raw Config.Env values are NEVER emitted by Docker, saved, or uploaded.
HOOK_ENV_PREDICATE = "or " + " ".join('(eq $key "' + key + '")' for key in ENV_CLEAR_KEYS)
HOOK_ENV_FORMAT = (
    '"hookEnvironment":[null{{range .Config.Env}}'
    '{{$key := index (split . "=") 0}}{{if ' + HOOK_ENV_PREDICATE + '}}'
    ',{"key":{{json $key}},"cleared":{{eq . (printf "%s=" $key)}}}'
    '{{end}}{{end}}]'
)
CONTAINER_FORMAT = CONTAINER_FORMAT[:-1] + "," + HOOK_ENV_FORMAT + "}"


class ProbeError(Exception):
    """Carries only fixed, non-sensitive error codes."""


def metadata_category(path):
    lower = path.lower()
    sensitive = any(s in lower for s in ("wallet", "keystore", "credential", "password", "secret", "private")) or lower.endswith((".p12", ".pfx", ".sso", ".jks", ".key", ".pem", ".der", ".crt", ".cer"))
    if sensitive:
        return "wallet-metadata"
    base = lower.rsplit("/", 1)[-1]
    if re.fullmatch(r"(?:orapki|mkstore|configtcps)(?:\..*)?|java(?:\.exe)?|(?:oraclepki|osdt|jps|jce|jsafe).*\.jar|ojpse.*", base):
        return "tool-candidate"
    return None


def parse_inventory(data):
    """Parse bounded NUL-delimited metadata; never treat partial scans as absence."""
    report = {"prefixes": [], "files": [], "protocolComplete": False}
    if len(data) > MAX_OUTPUT:
        raise ProbeError("protocol-output-limit")
    fields = data.split(b"\0")
    pos = 0
    active = None
    seen = set()
    hashed_bytes = 0
    hashed_files = 0
    visited_total = 0
    prefix_files = 0
    prefix_hash_incomplete = False
    try:
        while pos < len(fields) - 1:
            tag = fields[pos].decode("ascii")
            pos += 1
            if tag == "BEGIN":
                root = fields[pos].decode("ascii")
                pos += 1
                if active or root not in ROOTS or root in seen:
                    raise ValueError()
                seen.add(root)
                active = {"path": root, "status": "partial", "visitedEntries": None}
                report["prefixes"].append(active)
                prefix_files = 0
                prefix_hash_incomplete = False
            elif tag == "END":
                root, status, visited = (value.decode("ascii") for value in fields[pos:pos + 3])
                pos += 3
                if not active or root != active["path"] or status not in SCAN_STATES or not re.fullmatch(r"[0-9]{1,6}", visited):
                    raise ValueError()
                visited_total += int(visited)
                if visited_total > 100000 or int(visited) < prefix_files:
                    raise ValueError()
                if status in {"absent", "unreadable", "not-inspected", "symlink-ancestor"} and (prefix_files or int(visited)):
                    raise ValueError()
                if status == "complete" and (int(visited) == 0 or prefix_hash_incomplete):
                    raise ValueError()
                active.update(status=status, visitedEntries=int(visited))
                active = None
            elif tag == "FILE":
                values = fields[pos:pos + 8]
                pos += 8
                if len(values) != 8 or not active or len(report["files"]) >= 512:
                    raise ValueError()
                root, kind, mode, size, path, category, hash_status, digest = (v.decode("utf-8", "strict") for v in values)
                if root != active["path"] or not (path == root or path.startswith(root + "/")) or len(values[4]) > 4096:
                    raise ValueError()
                if any(part in {"", ".", ".."} for part in path[1:].split("/")) or path.count("/") - root.count("/") > 16:
                    raise ValueError()
                if kind not in "bcdflpsD" or len(kind) != 1 or not re.fullmatch(r"[0-7]{1,4}", mode) or not re.fullmatch(r"[0-9]{1,20}", size):
                    raise ValueError()
                if category not in {"wallet-metadata", "tool-candidate"} or hash_status not in HASH_STATES:
                    raise ValueError()
                # Independent wallet defense, even if the shell protocol changes.
                if category != metadata_category(path):
                    raise ValueError()
                if category == "wallet-metadata" and (hash_status != "metadata-only-wallet" or digest):
                    raise ValueError()
                if category == "tool-candidate" and ((kind == "f" and hash_status not in {"sha256", "size-limit", "budget-limit", "read-error"}) or (kind != "f" and hash_status != "not-regular")):
                    raise ValueError()
                prefix_files += 1
                prefix_hash_incomplete = prefix_hash_incomplete or hash_status in {"size-limit", "budget-limit", "read-error"}
                if hash_status == "sha256":
                    if category != "tool-candidate" or kind != "f" or not re.fullmatch(r"[a-f0-9]{64}", digest):
                        raise ValueError()
                    hashed_bytes += int(size)
                    hashed_files += 1
                    if int(size) > 33554432 or hashed_bytes > 134217728 or hashed_files > 128:
                        raise ValueError()
                elif digest:
                    raise ValueError()
                entry = {"path": path, "type": kind, "mode": mode, "size": int(size), "category": category, "hashStatus": hash_status}
                if digest:
                    entry["sha256"] = digest
                report["files"].append(entry)
            elif tag == "DONE":
                if active or seen != set(ROOTS) or pos != len(fields) - 1 or fields[-1] != b"":
                    raise ValueError()
                report["protocolComplete"] = True
            else:
                raise ValueError()
    except (ValueError, IndexError, UnicodeError):
        report["protocolError"] = "invalid-or-truncated-metadata"
    if "protocolError" in report:
        report["protocolComplete"] = False
    if not report["protocolComplete"]:
        report["protocolError"] = "invalid-or-truncated-metadata"
    return report


def validate_image(info):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", info.get("id", "")) or REPO_DIGEST not in (info.get("digests") or []):
        raise ProbeError("image-identity-mismatch")
    if info.get("os") != "linux" or info.get("architecture") != "amd64":
        raise ProbeError("image-platform-mismatch")
    volumes = sorted((info.get("volumes") or {}).keys())
    # Source-less anonymous read-only views only, never a host/existing source.
    if len(volumes) > 4 or any(not re.fullmatch(r"/opt/oracle/[A-Za-z0-9_/-]{1,100}", p) or ".." in p.split("/") or "//" in p or p.endswith("/") for p in volumes):
        raise ProbeError("unsupported-image-volume-scope")
    if any(a != b and a.startswith(b + "/") for a in volumes for b in volumes):
        raise ProbeError("overlapping-image-volume-scope")
    return volumes


def new_anonymous_mounts(info, volumes, old_volumes):
    """No existing source, bind, or pre-existing volume can be treated as owned."""
    requests = info.get("requestedMounts") or []
    if len(requests) != len(volumes) or any(m.get("Type") != "volume" or m.get("Target") != v or m.get("Source") or m.get("ReadOnly") is not True or m.get("BindOptions") or m.get("TmpfsOptions") for m, v in zip(sorted(requests, key=lambda m: m.get("Target", "")), volumes)):
        raise ProbeError("container-mount-request-mismatch")
    for mount in requests:
        options = mount.get("VolumeOptions") or {}
        driver = options.get("DriverConfig") or {}
        if driver.get("Name") != "local" or driver.get("Options") or options.get("NoCopy") or options.get("Subpath") or options.get("Labels"):
            raise ProbeError("container-volume-driver-options-mismatch")
    actual_mounts = info.get("mounts") or []
    if len(actual_mounts) != len(volumes) or any(m.get("type") != "volume" or m.get("destination") != v or m.get("rw") is not False or m.get("driver") != "local" or not re.fullmatch(r"[a-f0-9]{64}", m.get("name", "")) or m["name"] in old_volumes for m, v in zip(sorted(actual_mounts, key=lambda m: m.get("destination", "")), volumes)):
        raise ProbeError("container-mount-mismatch")
    if len({m["name"] for m in actual_mounts}) != len(volumes):
        raise ProbeError("container-volume-identity-mismatch")
    return actual_mounts


def validate_container(info, image_id, command, volumes, token, old_volumes, started=False):
    """Validate selected actual Docker state, not merely requested CLI flags."""
    expected = {
        "image": image_id, "path": "/usr/bin/env", "args": command,
        "user": UID, "workingDir": "/", "restartPolicy": "no", "entrypoint": ["/usr/bin/env"], "cmd": command,
        "readonly": True, "network": "none", "privileged": False,
        "memory": 268435456, "memorySwap": 268435456,
        "nanoCpus": 1000000000, "pidsLimit": 32, "ipcMode": "none",
        "pidMode": "", "utsMode": "", "usernsMode": "",
        "publishAllPorts": False, "logType": "none", "running": False,
    }
    if any(info.get(key) != value for key, value in expected.items()):
        raise ProbeError("container-restriction-mismatch")
    if not re.fullmatch(r"[a-f0-9]{64}", info.get("id", "")) or (info.get("labels") or {}).get(LABEL) != token:
        raise ProbeError("container-ownership-mismatch")
    if any(info.get(k) for k in ("capAdd", "binds", "volumesFrom", "devices", "deviceRequests", "portBindings")):
        raise ProbeError("container-unexpected-access")
    if info.get("capDrop") != ["ALL"] or info.get("securityOpt") != ["no-new-privileges=true"]:
        raise ProbeError("container-security-mismatch")
    hooks = info.get("hookEnvironment")
    if not isinstance(hooks, list) or len(hooks) != len(ENV_CLEAR_KEYS) + 1 or hooks[0] is not None or any(not isinstance(item, dict) or item.get("cleared") is not True or item.get("key") not in ENV_CLEAR_KEYS for item in hooks[1:]) or {item["key"] for item in hooks[1:]} != set(ENV_CLEAR_KEYS):
        raise ProbeError("container-initialization-hooks-not-cleared")
    if (info.get("healthcheck") or {}).get("Test") != ["NONE"] or set(info.get("networks") or {}) != {"none"}:
        raise ProbeError("container-healthcheck-or-network-mismatch")
    actual_mounts = new_anonymous_mounts(info, volumes, old_volumes)
    limits = {(item.get("Name"), item.get("Soft"), item.get("Hard")) for item in (info.get("ulimits") or [])}
    if limits != {("core", 0, 0), ("nofile", 64, 64)}:
        raise ProbeError("container-ulimit-mismatch")
    if info.get("status") != ("exited" if started else "created"):
        raise ProbeError("container-state-mismatch")
    if started and (info.get("exitCode") != 0 or info.get("oomKilled") is not False):
        raise ProbeError("container-inspection-exit-failed")
    proof = {key: info[key] for key in ("user", "readonly", "network", "privileged", "capDrop", "securityOpt", "memory", "memorySwap", "nanoCpus", "pidsLimit", "ipcMode", "logType", "ulimits")}
    proof["mounts"] = [{"type": m["type"], "driver": m["driver"], "destination": m["destination"], "rw": m["rw"], "newAnonymousVolume": True} for m in actual_mounts]
    proof["clearedInitializationHookKeys"] = list(ENV_CLEAR_KEYS)
    return proof


def bounded_command(argv, env, timeout, limit=MAX_OUTPUT):
    """Bound time and combined bytes; raw stderr is always discarded."""
    output = bytearray()
    byte_count = 0
    reason = None
    deadline = time.monotonic() + timeout
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, True)
            selector.register(process.stderr, selectors.EVENT_READ, False)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    reason = "command-time-limit"
                    break
                for key, _ in selector.select(min(0.2, max(0, deadline - time.monotonic()))):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    byte_count += len(chunk)
                    if byte_count > limit:
                        reason = "command-output-limit"
                        break
                    if key.data:
                        output.extend(chunk)
                if reason:
                    break
        if reason:
            os.killpg(process.pid, signal.SIGKILL)
        remaining = max(0.1, deadline - time.monotonic())
        try:
            rc = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            rc = process.wait(timeout=5)
            reason = "command-time-limit"
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()
    return {"output": bytes(output), "rc": rc, "failure": reason, "observedBytes": byte_count}


def runner_guard():
    expected = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "GITHUB_EVENT_NAME": "push", "GITHUB_REF": BRANCH, "GITHUB_REPOSITORY": "Hubujiu/local-api-workbench", "GITHUB_REPOSITORY_ID": "1423306754"}
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise ProbeError("not-approved-github-push-runner")
    if not re.fullmatch(r"[0-9]+", os.environ.get("GITHUB_RUN_ID", "")):
        raise ProbeError("missing-github-run-identity")


def main():
    output_dir = Path("oracle-lite-inventory-output")
    output_dir.mkdir(mode=0o700, exist_ok=False)
    report = {
        "schemaVersion": 1, "purpose": "bounded-read-only-capability-inventory",
        "image": IMAGE, "inspectionComplete": False, "runtimeAcceptance": False,
        "databaseStarted": False, "restrictionsVerified": False,
        "cleanupComplete": False, "status": "not-started", "errors": [],
        "scope": {"prefixes": list(ROOTS), "maxDepth": 16, "maxVisitedEntries": 100000, "maxCandidates": 512, "maxPathBytes": 4096, "maxFileHashBytes": 33554432, "maxTotalHashBytes": 134217728, "maxHashedFiles": 128, "maxAttachSeconds": 120, "maxMainCommandSeconds": 660, "maxCleanupCommandSeconds": 70, "maxOutputBytes": MAX_OUTPUT, "symlinksFollowed": False},
        "interpretation": "Metadata only. No Java/Oracle CLI or database execution, no TCPS acceptance. Absent means only an accessible fixed prefix was absent; incomplete/unreadable/truncated scans never prove a capability missing. No wallet contents or hashes. No JAR extraction or class-content publication.",
    }
    logs = []
    container_id = None
    create_attempted = False
    token = uuid.uuid4().hex
    old_volumes = set()
    name = "oracle-lite-inventory-" + token
    phase = "runner-guard"
    previous_handlers = {}

    def interrupted(signum, frame):
        raise ProbeError("interrupted")

    for sig in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[sig] = signal.signal(sig, interrupted)
    with tempfile.TemporaryDirectory(prefix="oracle-lite-docker-empty-") as config:
        # An empty Docker config and explicit local socket prevent credentials,
        # context selection, remote daemons, and inherited Docker env. Daemon
        # registry mirrors are checked separately before the one allowed pull.
        env = {"PATH": "/usr/bin:/bin", "HOME": config, "LANG": "C", "LC_ALL": "C"}
        docker = [DOCKER, "--host", "unix:///var/run/docker.sock", "--config", config]
        deadline = time.monotonic() + 660

        def call(args, timeout=20, limit=131072, allow_failure=False):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProbeError("overall-command-time-limit")
            result = bounded_command(docker + args, env, min(timeout, remaining), limit)
            if not allow_failure and (result["failure"] or result["rc"] != 0):
                raise ProbeError(result["failure"] or "docker-command-failed")
            return result

        def inspect_container(target):
            return json.loads(call(["container", "inspect", "--format", CONTAINER_FORMAT, target])["output"])

        try:
            runner_guard()
            script = Path(__file__).with_suffix(".sh").read_text(encoding="utf-8")
            if len(script.encode()) > 16384:
                raise ProbeError("shell-script-size-limit")
            phase = "local-daemon-and-disk-preflight"
            daemon = json.loads(call(["info", "--format", '{"root":{{json .DockerRootDir}},"mirrors":{{json .RegistryConfig.Mirrors}},"os":{{json .OSType}}}'])["output"])
            root = daemon.get("root", "")
            if daemon.get("os") != "linux" or daemon.get("mirrors") or not isinstance(root, str) or not root.startswith("/") or len(root) > 512:
                raise ProbeError("unsupported-local-daemon-config")
            def disk_free():
                disk = os.statvfs(root)
                return disk.f_bavail * disk.f_frsize
            before_pull = disk_free()
            report["diskPreflight"] = {"beforePullFreeBytes": before_pull, "minimumBeforePullBytes": 20 * 1024**3}
            if before_pull < 20 * 1024**3:
                raise ProbeError("insufficient-disk-before-pull")
            phase = "pull-exact-approved-lite"
            call(["image", "pull", "--quiet", "--platform", "linux/amd64", IMAGE], timeout=480)
            logs.append("Exact approved Lite pull completed; no fallback attempted.")
            phase = "image-config"
            info = json.loads(call(["image", "inspect", "--format", IMAGE_FORMAT, IMAGE])["output"])
            volumes = validate_image(info)
            image_size = info.get("size")
            if type(image_size) is not int or not 0 < image_size <= 16 * 1024**3:
                raise ProbeError("unsupported-image-size")
            before_create = disk_free()
            required = image_size + 2 * 1024**3
            report["diskPreflight"].update(beforeCreateFreeBytes=before_create, minimumBeforeCreateBytes=required, imageSizeBytes=image_size)
            if before_create < required:
                raise ProbeError("insufficient-disk-before-volume-copy")
            old_volumes = set(call(["volume", "ls", "--quiet"], limit=65536)["output"].decode("ascii").splitlines())
            report["imageIdentity"] = {"id": info["id"], "repoDigest": REPO_DIGEST, "os": info["os"], "architecture": info["architecture"], "declaredVolumes": volumes}
            command = ["-i", "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "HOME=/nonexistent", "/bin/bash", "--noprofile", "--norc", "-c", script]
            args = ["container", "create", "--pull=never", "--platform", "linux/amd64", "--name", name, "--label", LABEL + "=" + token, "--user", UID, "--workdir", "/", "--restart=no", "--read-only", "--network", "none", "--ipc", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--pids-limit", "32", "--ulimit", "core=0:0", "--ulimit", "nofile=64:64", "--log-driver", "none", "--no-healthcheck", "--entrypoint", "/usr/bin/env"]
            for key in ENV_CLEAR_KEYS:
                args.extend(["--env", key + "="])
            for volume in volumes:
                args.extend(["--mount", "type=volume,destination=" + volume + ",readonly,volume-driver=local"])
            args.extend([IMAGE] + command)
            phase = "create-contained-inventory"
            create_attempted = True
            created = call(args, timeout=45)["output"].decode("ascii").strip()
            if not re.fullmatch(r"[a-f0-9]{64}", created):
                raise ProbeError("invalid-created-container-id")
            container_id = created
            phase = "verify-before-start"
            actual = inspect_container(container_id)
            report["restrictions"] = validate_container(actual, info["id"], command, volumes, token, old_volumes)
            report["restrictionsVerified"] = True
            logs.append("Selected actual container restrictions and image identity verified before shell start.")
            phase = "bounded-shell-inventory"
            result = call(["container", "start", "--attach", container_id], timeout=120, limit=MAX_OUTPUT, allow_failure=True)
            inventory = parse_inventory(result["output"])
            report.update(inventory)
            if result["failure"] or result["rc"] != 0:
                raise ProbeError(result["failure"] or "inventory-command-failed")
            phase = "verify-after-exit"
            validate_container(inspect_container(container_id), info["id"], command, volumes, token, old_volumes, started=True)
            report["inspectionComplete"] = inventory["protocolComplete"] and all(p["status"] in {"complete", "absent"} for p in inventory["prefixes"])
            report["status"] = "complete" if report["inspectionComplete"] else "partial"
            logs.append("Read-only metadata collection finished; runtimeAcceptance remains false.")
        except ProbeError as error:
            report["errors"].append({"phase": phase, "code": str(error)})
            report["status"] = "blocked-or-incomplete"
        except Exception:
            report["errors"].append({"phase": phase, "code": "unexpected-error-details-redacted"})
            report["status"] = "blocked-or-incomplete"
        finally:
            deadline = time.monotonic() + 70
            # Cleanup only our unique, labeled container and its own anonymous
            # volumes. No image prune, host deletion, or prior evidence mutation.
            if create_attempted:
                try:
                    owned = inspect_container(container_id or name)
                    if (owned.get("labels") or {}).get(LABEL) != token or not re.fullmatch(r"[a-f0-9]{64}", owned.get("id", "")):
                        raise ProbeError("cleanup-ownership-unverified")
                    try:
                        owned_mounts = new_anonymous_mounts(owned, volumes, old_volumes)
                    except ProbeError:
                        # Container ownership is known, volume ownership is not.
                        # Remove only that container, never an uncertain volume.
                        call(["container", "rm", "--force", owned["id"]], timeout=30)
                        raise ProbeError("cleanup-volume-ownership-unverified")
                    call(["container", "rm", "--force", "--volumes", owned["id"]], timeout=30)
                    remaining = set(call(["volume", "ls", "--quiet"], limit=65536)["output"].decode("ascii").splitlines())
                    if any(m["name"] in remaining for m in owned_mounts):
                        raise ProbeError("cleanup-volumes-not-confirmed")
                    report["cleanupComplete"] = True
                except Exception:
                    report["errors"].append({"phase": "cleanup", "code": "cleanup-not-confirmed"})
                    report["inspectionComplete"] = False
            else:
                report["cleanupComplete"] = True
            for sig, handler in previous_handlers.items():
                signal.signal(sig, handler)
    if report["errors"]:
        report["inspectionComplete"] = False
    encoded = json.dumps(report, indent=2, ensure_ascii=True) + "\n"
    if len(encoded.encode()) > MAX_JSON:
        report.pop("files", None)
        report["inspectionComplete"] = False
        report["errors"].append({"phase": "artifact", "code": "json-size-limit-files-omitted"})
        encoded = json.dumps(report, indent=2, ensure_ascii=True) + "\n"
    (output_dir / "inventory.json").write_text(encoded, encoding="utf-8")
    logs.append("inspectionComplete=" + str(report["inspectionComplete"]).lower() + "; runtimeAcceptance=false; databaseStarted=false; cleanupComplete=" + str(report["cleanupComplete"]).lower())
    (output_dir / "sanitized.log").write_text("\n".join(logs) + "\n", encoding="utf-8")
    print(logs[-1])
    return 0 if report["inspectionComplete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
