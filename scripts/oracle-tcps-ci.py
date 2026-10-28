#!/usr/bin/env python3
"""Ephemeral, explicitly authorized GitHub-only Oracle TCPS fixture.

Never run this helper locally. It does not provision hosts, log in to a registry,
modify host trust, expose plaintext Oracle, or upload raw database output.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time


PIN = "container-registry.oracle.com/database/free:23.26.3.0-lite-amd64@sha256:770ca58ab319d8cfde610b0db25c06899ce0af9591c4addfa10d2cb8f0318e65"
DIGEST = PIN.split("@", 1)[1]
LABEL = "com.local-api.oracle-tcps-ci"
CERT_MOUNT = "/opt/oracle/ci-tcps"
PHASE = "guard"

# Fixed software-location classes only. These are diagnostics, not fallback
# executable paths: the fixture continues to require the documented PATH/API.
PROBE_TOOLS = ("sqlplus", "lsnrctl", "orapki", "openssl", "sha256sum")
PROBE_BIN_ROOTS = {
    "oracle23_bin": "/opt/oracle/product/23ai/dbhomeFree/bin",
    "oracle26_bin": "/opt/oracle/product/26ai/dbhomeFree/bin",
    "oracle_common_bin": "/opt/oracle/bin",
    "usr_bin": "/usr/bin",
    "bin": "/bin",
}
PROBE_CONFIG_LOCATIONS = {
    "canonical": "/opt/oracle/configTcps.sh",
    "scripts": "/opt/oracle/scripts/configTcps.sh",
    "setup_scripts": "/opt/oracle/scripts/setup/configTcps.sh",
    "startup_scripts": "/opt/oracle/scripts/startup/configTcps.sh",
    "oracle23_home": "/opt/oracle/product/23ai/dbhomeFree/configTcps.sh",
    "oracle26_home": "/opt/oracle/product/26ai/dbhomeFree/configTcps.sh",
}
PROBE_INTERFACES = {
    "tcps_certs_location": "TCPS_CERTS_LOCATION",
    "cert_crt": "cert.crt",
    "client_key": "client.key",
    "ca_crt": "ca.crt",
    "pkcs12_import": "import_pkcs12",
}


def capability_checks():
    checks = {f"tool_{tool}_in_path": ["command", "-v", tool]
              for tool in (*PROBE_TOOLS, "grep")}
    for location, root in PROBE_BIN_ROOTS.items():
        for tool in PROBE_TOOLS:
            checks[f"tool_{tool}_{location}"] = ["test", "-x", root + "/" + tool]
    for location, filename in PROBE_CONFIG_LOCATIONS.items():
        for kind, flag in (("exists", "-e"), ("regular", "-f"), ("readable", "-r"), ("executable", "-x")):
            checks[f"config_{location}_{kind}"] = ["test", flag, filename]
    for key, marker in PROBE_INTERFACES.items():
        checks[f"config_interface_{key}"] = ["grep", "-F", "-q", "--", marker, PROBE_CONFIG_LOCATIONS["canonical"]]
    return checks


PROBE_CHECKS = capability_checks()
PROBE_REQUIRED = (
    *(f"tool_{tool}_in_path" for tool in (*PROBE_TOOLS, "grep")),
    *(f"config_canonical_{kind}" for kind in ("exists", "regular", "readable", "executable")),
    *(f"config_interface_{kind}" for kind in ("tcps_certs_location", "cert_crt", "client_key")),
)


class Failure(Exception):
    def __init__(self, label, codes=()):
        self.label = label
        self.codes = sorted(set(codes))[:8]


def require(condition, label):
    if not condition:
        raise Failure(label)


def safe_codes(data):
    return re.findall(r"\b(?:ORA|TNS|PKI|NJS)-\d{3,5}\b", data.decode("utf-8", "replace"))


def paths():
    require(os.environ.get("GITHUB_ACTIONS") == "true", "github_actions_required")
    require(os.environ.get("ORACLE_TCPS_ACCEPTANCE") == "1", "explicit_ci_gate_required")
    require(sys.platform == "linux", "linux_required")
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    require(run.isdecimal() and attempt.isdecimal(), "invalid_job_identity")
    runner = Path(os.environ.get("RUNNER_TEMP", ""))
    require(runner.is_absolute() and runner.is_dir(), "invalid_runner_temp")
    name = f"oracle-tcps-{run}-{attempt}"
    root = runner / name
    evidence = runner / "oracle-tcps-evidence"
    supplied = os.environ.get("ORACLE_CI_STATE_DIR")
    require(supplied is None or supplied == str(root), "state_path_mismatch")
    require(not root.is_symlink() and not evidence.is_symlink(), "symlink_path_rejected")
    return name, root, evidence


NAME, ROOT, EVIDENCE = paths()


def report(**fields):
    EVIDENCE.mkdir(mode=0o700, exist_ok=True)
    path = EVIDENCE / "fixture.json"
    value = json.loads(path.read_text()) if path.exists() else {"pin": PIN}
    value.update(fields)
    path.write_text(json.dumps(value, indent=2) + "\n")


def phase(value):
    global PHASE
    PHASE = value
    report(phase=value)
    print("ORACLE_CI_PHASE " + value, flush=True)


def command(args, label, timeout=60, input_data=None, check=True):
    # No shell interpolation. An empty Docker configuration prohibits reuse of
    # account credentials; these are local daemon operations or anonymous pull.
    env = {"PATH": os.environ["PATH"], "LANG": "C.UTF-8",
           "HOME": str(ROOT), "DOCKER_CONFIG": str(ROOT / "docker-config")}
    with tempfile.TemporaryFile(dir=ROOT) as output:
        try:
            completed = subprocess.run(args, env=env, input=input_data,
                                       stdout=output, stderr=subprocess.STDOUT,
                                       timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            raise Failure(label + "_timeout") from None
        output.seek(0)
        data = output.read(4 * 1024 * 1024 + 1)
    require(len(data) <= 4 * 1024 * 1024, label + "_output_limit")
    if check and completed.returncode:
        raise Failure(label, safe_codes(data))
    return completed.returncode, data


def docker(*args, label="docker_command_failed", timeout=60, input_data=None, check=True):
    return command(["docker", *args], label, timeout, input_data, check)


def save_state(state):
    (ROOT / "state.json").write_text(json.dumps(state) + "\n")


def state():
    value = json.loads((ROOT / "state.json").read_text())
    require(value.get("identity") == NAME and value.get("pin") == PIN, "state_identity_mismatch")
    for key, suffix in (("container", "db"), ("network", "net"), ("volume", "data")):
        require(value.get(key) == NAME + "-" + suffix, "resource_identity_mismatch")
    return value


def inspect_container(name, timeout=15):
    _, data = docker("inspect", name, label="container_inspect_failed", timeout=timeout)
    value = json.loads(data)[0]
    require(value.get("Config", {}).get("Labels", {}).get(LABEL) == NAME, "container_owner_mismatch")
    return value


def sql(text, label, timeout=30):
    item = state()
    data = ("whenever oserror exit failure rollback\n"
            "whenever sqlerror exit failure rollback\n"
            "set echo off feedback off heading off pagesize 0 verify off\n"
            "alter session set container=FREEPDB1;\n" + text + "\nexit\n").encode()
    return docker("exec", "--user", "oracle", "-i", item["container"],
                  "sqlplus", "-L", "-s", "/", "as", "sysdba", label=label,
                  timeout=timeout, input_data=data)


def wait_database(seconds=600):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        info = inspect_container(state()["container"], timeout=budget(deadline, 10, "database_readiness_deadline"))
        current = info.get("State", {})
        require(current.get("Running") is True, "database_exited_before_ready")
        # A healthy status alone is insufficient: require the actual PDB open.
        if current.get("Health", {}).get("Status") == "healthy":
            _, result = sql("select 'ORACLE_PDB_READY' from v$pdbs where name='FREEPDB1' and open_mode='READ WRITE';", "pdb_readiness_failed",
                            timeout=budget(deadline, 10, "database_readiness_deadline"))
            if result.decode().strip() == "ORACLE_PDB_READY":
                return
        time.sleep(min(2, max(0, deadline - time.monotonic())))
    raise Failure("database_readiness_deadline")


def budget(deadline, cap, label):
    remaining = deadline - time.monotonic()
    require(remaining > 0, label)
    return min(cap, remaining)


def probe_script():
    # Every check runs even when an earlier one is false. No environment dump,
    # file contents, arbitrary paths, stderr, or tool output reaches stdout.
    lines = ["set -u", """probe() {
  local key="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '%s=true\\n' "$key"
  else
    printf '%s=false\\n' "$key"
  fi
}"""]
    for key, args in PROBE_CHECKS.items():
        lines.append("probe " + " ".join(shlex.quote(value) for value in (key, *args)))
    lines.append("exit 0")
    return "\n".join(lines)


def parse_capabilities(data):
    # Unobserved and uninspectable capabilities are null (unknown), never false.
    unknown = dict.fromkeys(PROBE_CHECKS)
    if len(data) > 16 * 1024:
        return unknown, "output_limit"
    try:
        lines = data.decode("ascii").splitlines()
    except UnicodeDecodeError:
        return unknown, "invalid_encoding"
    values = {}
    for line in lines:
        match = re.fullmatch(r"([a-z][a-z0-9_]{1,79})=(true|false)", line)
        if match is None or match[1] not in PROBE_CHECKS or match[1] in values:
            return unknown, "invalid_schema"
        values[match[1]] = match[2] == "true"
    complete = set(values) == set(PROBE_CHECKS)
    result = {**unknown, **values}
    if (result["tool_grep_in_path"] is not True
            or result["config_canonical_regular"] is not True
            or result["config_canonical_readable"] is not True):
        for key in PROBE_INTERFACES:
            result[f"config_interface_{key}"] = None
    return result, "complete" if complete else "incomplete"


def shipped_tool_preflight():
    phase("shipped_tool_preflight")
    # Save an unknown baseline first: even failure to launch the shell, a timeout,
    # or malformed output must leave an explicit safe diagnostic artifact.
    capabilities = dict.fromkeys(PROBE_CHECKS)
    report(capabilities=capabilities, capabilityProbeStatus="not_completed",
           capabilityProbeExitCode=None, capabilityRequired=list(PROBE_REQUIRED),
           capabilityUnknownMeaning="null means not observed or not inspectable",
           capabilityLocations="fixed software locations only; no PATH fallback",
           capabilityCaCrtRequired=False)
    try:
        exit_code, output = docker(
            "run", "--name", NAME + "-probe", "--label", LABEL + "=" + NAME,
            "--network", "none", "--no-healthcheck", "--entrypoint", "/bin/bash",
            PIN, "-c", probe_script(), label="capability_probe_execution_failed",
            timeout=60, check=False)
    except Failure as error:
        report(capabilityProbeStatus=error.label)
        raise
    except Exception:
        report(capabilityProbeStatus="probe_execution_error")
        raise Failure("capability_probe_execution_failed") from None
    capabilities, status = parse_capabilities(output)
    missing = [key for key in PROBE_REQUIRED if capabilities[key] is False]
    unknown = [key for key in PROBE_REQUIRED if capabilities[key] is None]
    report(capabilities=capabilities, capabilityProbeStatus=status,
           capabilityProbeExitCode=exit_code, capabilityMissingRequired=missing,
           capabilityUnknownRequired=unknown)
    # A complete map is persisted before each fail-closed gate. ca.crt is advisory
    # because the supported cert.crt chain fallback was already part of the plan.
    require(exit_code == 0, "capability_probe_nonzero_exit")
    require(status == "complete", "capability_probe_invalid_output")
    require(not missing and not unknown, "pinned_lite_tcps_tools_incompatible")
    # Copy only the fixed, validated software file to obtain its hash. Never
    # execute it on the host or retain its source in the evidence directory.
    destination = ROOT / "shipped-configTcps.sh"
    docker("cp", "-L", NAME + "-probe:/opt/oracle/configTcps.sh", str(destination),
           label="shipped_script_hash_read_failed", timeout=15)
    require(destination.is_file() and not destination.is_symlink()
            and destination.stat().st_size <= 256 * 1024, "shipped_script_size_invalid")
    report(shippedConfigTcpsSha256=hashlib.sha256(destination.read_bytes()).hexdigest())
    destination.unlink()
    docker("rm", NAME + "-probe", label="probe_cleanup_failed")


def generate_certificates():
    for authority in ("a", "b"):
        command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                 "-sha256", "-days", "2", "-subj", "/CN=Oracle CI CA " + authority.upper(),
                 "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                 "-addext", "keyUsage=critical,keyCertSign,cRLSign",
                 "-keyout", str(ROOT / f"ca-{authority}.key"),
                 "-out", str(ROOT / f"ca-{authority}.crt")], "ca_generation_failed")
    for kind, san in (("good", "IP:127.0.0.1,DNS:localhost"),
                      ("wrong", "IP:127.0.0.2,DNS:wrong.invalid")):
        folder = ROOT / kind
        folder.mkdir(mode=0o700)
        subject = "/CN=localhost" if kind == "good" else "/CN=wrong.invalid"
        command(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
                 "-subj", subject, "-keyout", str(folder / "client.key"),
                 "-out", str(folder / "request.csr")], "leaf_request_failed")
        (folder / "extensions.cnf").write_text(
            "basicConstraints=critical,CA:FALSE\n"
            "keyUsage=critical,digitalSignature,keyEncipherment\n"
            "extendedKeyUsage=serverAuth\nsubjectAltName=" + san + "\n")
        command(["openssl", "x509", "-req", "-sha256", "-days", "2",
                 "-in", str(folder / "request.csr"), "-CA", str(ROOT / "ca-a.crt"),
                 "-CAkey", str(ROOT / "ca-a.key"), "-set_serial", "1" if kind == "good" else "2",
                 "-extfile", str(folder / "extensions.cnf"), "-out", str(folder / "leaf.crt")],
                "leaf_sign_failed")
        (folder / "cert.crt").write_bytes((folder / "leaf.crt").read_bytes() + (ROOT / "ca-a.crt").read_bytes())
        command(["openssl", "verify", "-CAfile", str(ROOT / "ca-a.crt"),
                 "-purpose", "sslserver", str(folder / "leaf.crt")], "leaf_chain_invalid")
    # Verify the positive SAN offline; never disable hostname validation online.
    command(["openssl", "verify", "-CAfile", str(ROOT / "ca-a.crt"),
             "-verify_ip", "127.0.0.1", str(ROOT / "good" / "leaf.crt")], "matching_san_invalid")
    status, _ = command(["openssl", "verify", "-CAfile", str(ROOT / "ca-a.crt"),
                         "-verify_ip", "127.0.0.1", str(ROOT / "wrong" / "leaf.crt")],
                        "wrong_san_check", check=False)
    require(status != 0, "negative_certificate_unexpectedly_matches")


def activate_files(kind):
    require(kind in ("good", "wrong"), "unknown_certificate_variant")
    active = ROOT / "active"
    active.mkdir(mode=0o755, exist_ok=True)
    active.chmod(0o755)  # mkdir is otherwise restricted by the private umask.
    for filename in ("cert.crt", "client.key", "ca.crt"):
        target = active / filename
        if target.exists():
            target.unlink()
        source = ROOT / "ca-a.crt" if filename == "ca.crt" else ROOT / kind / filename
        target.write_bytes(source.read_bytes())
        # Only this directory is mounted, read-only, in the isolated container.
        # Its host ancestors remain mode 0700; no key is an artifact.
        target.chmod(0o444)


def certificate(kind):
    require(kind in ("good", "wrong"), "unknown_certificate_variant")
    phase("certificate_" + kind)
    item = state()
    inspect_container(item["container"])
    activate_files(kind)
    docker("exec", "--user", "oracle", "--env", "TCPS_CERTS_LOCATION=" + CERT_MOUNT,
           item["container"], "/opt/oracle/configTcps.sh", "2484", "localhost",
           label="shipped_tcps_configuration_failed", timeout=90)
    _, data = docker("exec", "--user", "oracle", item["container"], "lsnrctl", "status",
                     label="listener_status_failed", timeout=15)
    compact = re.sub(rb"\s+", b"", data).lower()
    require(b"(protocol=tcps)" in compact and b"(port=2484)" in compact,
            "tcps_listener_missing")
    wait_database(60)
    report(certificateVariant=kind, tcpsListenerConfigured=True)


def setup():
    require(not ROOT.exists(), "state_directory_already_exists")
    ROOT.mkdir(mode=0o700)
    (ROOT / "docker-config").mkdir(mode=0o700)
    env_file = os.environ.get("GITHUB_ENV", "")
    require(Path(env_file).is_absolute(), "github_env_required")
    with open(env_file, "a") as output:
        output.write("ORACLE_CI_STATE_DIR=" + str(ROOT) + "\n")
    item = {"identity": NAME, "pin": PIN, "container": NAME + "-db",
            "network": NAME + "-net", "volume": NAME + "-data",
            "service": "FREEPDB1", "reader": "CI_READER",
            "readerPassword": "Aa0" + secrets.token_hex(18),
            "caFile": "ca-a.crt", "wrongCaFile": "ca-b.crt",
            "evidenceDirectory": str(EVIDENCE)}
    save_state(item)
    phase("resource_preflight")
    _, root_data = docker("info", "--format", "{{.DockerRootDir}}", label="docker_unavailable")
    docker_root = Path(root_data.decode().strip())
    require(docker_root.is_absolute(), "invalid_docker_root")
    memory = {line.split(":", 1)[0]: int(line.split()[1]) * 1024
              for line in Path("/proc/meminfo").read_text().splitlines()}
    try:
        disk_free = shutil.disk_usage(docker_root).free
    except OSError:
        raise Failure("docker_storage_capacity_unreadable") from None
    capacity = {"cpuCount": os.cpu_count(), "memoryAvailableBytes": memory["MemAvailable"],
                "diskFreeBytes": disk_free}
    _, node = command(["node", "--version"], "node_unavailable")
    require(re.fullmatch(rb"v24\.\d+\.\d+\s*", node) is not None, "node24_required")
    report(runner=capacity, nodeVersion=node.decode().strip(), platform="linux/amd64")
    require(capacity["cpuCount"] >= 2 and capacity["memoryAvailableBytes"] >= 6 * 1024**3
            and capacity["diskFreeBytes"] >= 20 * 1024**3, "standard_runner_capacity_insufficient")
    require(os.uname().machine == "x86_64", "amd64_runner_required")
    phase("pull_pinned_image")
    docker("pull", "--platform", "linux/amd64", PIN, label="anonymous_pinned_pull_failed", timeout=300)
    _, raw = docker("image", "inspect", PIN, label="image_inspection_failed")
    image = json.loads(raw)[0]
    require(image.get("Os") == "linux" and image.get("Architecture") == "amd64", "image_platform_mismatch")
    require(any(value.endswith("@" + DIGEST) for value in image.get("RepoDigests", [])), "pulled_image_digest_mismatch")
    health_test = image.get("Config", {}).get("Healthcheck", {}).get("Test", [])
    require(bool(health_test) and health_test[0] != "NONE", "pinned_image_healthcheck_missing")
    report(imageId=image["Id"], digestVerified=True)
    shipped_tool_preflight()
    phase("generate_private_certificates")
    generate_certificates()
    activate_files("good")
    admin_password = "Aa0" + secrets.token_hex(18)
    for password in (admin_password, item["readerPassword"]):
        print("::add-mask::" + password, flush=True)
    (ROOT / "database.env").write_text("ORACLE_PWD=" + admin_password + "\nENABLE_TCPS=false\n")
    phase("create_isolated_database")
    docker("network", "create", "--internal", "--label", LABEL + "=" + NAME, item["network"], label="network_create_failed")
    docker("volume", "create", "--label", LABEL + "=" + NAME, item["volume"], label="volume_create_failed")
    docker("run", "--detach", "--name", item["container"], "--label", LABEL + "=" + NAME,
           "--platform", "linux/amd64", "--network", item["network"],
           "--publish", "127.0.0.1::2484", "--memory", "4g", "--cpus", "2", "--shm-size", "1g",
           "--env-file", str(ROOT / "database.env"),
           "--mount", "type=volume,src=" + item["volume"] + ",dst=/opt/oracle/oradata",
           "--mount", "type=bind,src=" + str(ROOT / "active") + ",dst=" + CERT_MOUNT + ",readonly",
           PIN, label="database_container_start_failed", timeout=60)
    info = inspect_container(item["container"])
    ports = info.get("NetworkSettings", {}).get("Ports", {})
    published = {key: value for key, value in ports.items() if value}
    require(set(published) == {"2484/tcp"} and len(published["2484/tcp"]) == 1,
            "unexpected_published_ports")
    binding = published["2484/tcp"][0]
    require(binding.get("HostIp") == "127.0.0.1", "non_loopback_publication_rejected")
    item["port"] = int(binding["HostPort"])
    save_state(item)
    phase("database_readiness")
    wait_database()
    phase("least_privilege_fixture")
    owner_password = "Aa0" + secrets.token_hex(18)
    print("::add-mask::" + owner_password, flush=True)
    sql(f"""create user CI_OWNER identified by "{owner_password}" account lock quota 32M on USERS;
create user CI_READER identified by "{item['readerPassword']}";
grant create session to CI_READER;
create table CI_OWNER.CI_VALUES (ID number, DECIMAL_VALUE number, BIG_VALUE number, SMALL_VALUE number, HUGE_VALUE number, TXT varchar2(4000), RAW_VALUE raw(16), DATE_VALUE date, CLOB_VALUE clob, BLOB_VALUE blob);
insert into CI_OWNER.CI_VALUES values (1, .12345678901234567890123456789012345678, 9007199254740993, 1e-130, 9.9999999999999999999999999999999999999e125, 'oracle-ci', hextoraw('00ff8041'), date '2026-01-01', to_clob('not-supported'), empty_blob());
create table CI_OWNER.CI_ROWS (ID number, TXT varchar2(4000));
insert into CI_OWNER.CI_ROWS select level, rpad('x',2000,'x') from dual connect by level <= 1100;
grant read on CI_OWNER.CI_VALUES to CI_READER;
grant read on CI_OWNER.CI_ROWS to CI_READER;
commit;
declare n number;
begin
 select count(*) into n from dba_sys_privs where grantee='CI_READER';
 if n != 1 then raise_application_error(-20001,'privileges'); end if;
 select count(*) into n from dba_sys_privs where grantee='CI_READER' and privilege='CREATE SESSION' and admin_option='NO';
 if n != 1 then raise_application_error(-20001,'privileges'); end if;
 select count(*) into n from dba_role_privs where grantee='CI_READER';
 if n != 0 then raise_application_error(-20001,'roles'); end if;
 select count(*) into n from dba_tab_privs where grantee='CI_READER';
 if n != 2 then raise_application_error(-20001,'object privileges'); end if;
 select count(*) into n from dba_tab_privs where grantee='CI_READER' and owner='CI_OWNER' and table_name in ('CI_VALUES','CI_ROWS') and privilege='READ' and grantable='NO';
 if n != 2 then raise_application_error(-20001,'read grants'); end if;
 select count(*) into n from dba_users where username='CI_OWNER' and account_status='LOCKED';
 if n != 1 then raise_application_error(-20001,'owner unlocked'); end if;
end;
/
select 'ORACLE_FIXTURE_READY' from dual;
""", "fixture_setup_or_grants_failed", timeout=60)
    report(leastPrivilegeVerified=True, ownerLocked=True)
    certificate("good")
    report(status="ready")
    print("ORACLE_TCPS_FIXTURE_READY", flush=True)


def sessions_zero():
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        _, output = sql("select count(*) from v$session where username='CI_READER';", "session_observation_failed",
                        timeout=budget(deadline, 10, "reader_session_cleanup_deadline"))
        require(re.fullmatch(rb"\s*\d+\s*", output) is not None, "invalid_session_observation")
        if int(output.strip()) == 0:
            print("ORACLE_READER_SESSIONS_ZERO", flush=True)
            return
        time.sleep(min(0.25, max(0, deadline - time.monotonic())))
    raise Failure("reader_session_cleanup_deadline")


def cleanup():
    # Ownership comes from this job's immutable run identity, not state JSON.
    failures = []
    try:
        # A missing credential directory does not prove resource deletion. Build
        # fresh empty command state so another cleanup can still inspect labels.
        ROOT.mkdir(mode=0o700, exist_ok=True)
        (ROOT / "docker-config").mkdir(mode=0o700, exist_ok=True)
        for kind, allowed in (("container", {NAME + "-db", NAME + "-probe"}),
                              ("volume", {NAME + "-data"}), ("network", {NAME + "-net"})):
            try:
                args = [kind, "ls"] + (["--all"] if kind == "container" else [])
                args += ["--filter", "label=" + LABEL + "=" + NAME,
                         "--format", "{{.Names}}" if kind == "container" else "{{.Name}}"]
                _, result = docker(*args, label="cleanup_listing_failed", timeout=15)
                names = set(result.decode().split())
                require(names <= allowed, "unexpected_owned_resource")
                for name in sorted(names):
                    try:
                        remove = [kind, "rm"] + (["--force"] if kind == "container" else []) + [name]
                        docker(*remove, label="cleanup_removal_failed", timeout=30)
                    except Exception:
                        failures.append("cleanup_removal_failed_" + kind)
                _, remaining = docker(*args, label="cleanup_verification_failed", timeout=15)
                require(not remaining.strip(), "owned_resource_remains")
            except Exception:
                failures.append("cleanup_verification_failed_" + kind)
    except Exception:
        failures.append("cleanup_command_state_failed")
    finally:
        # Destroy local keys/passwords even if the Docker daemon is unavailable.
        try:
            if ROOT.exists():
                shutil.rmtree(ROOT)
        except Exception:
            failures.append("private_material_cleanup_failed")
    report(cleanup="verified" if not failures else "failed", cleanupFailures=failures)
    require(not failures, "cleanup_incomplete")
    print("ORACLE_TCPS_CLEANUP_VERIFIED", flush=True)


def main():
    os.umask(0o077)
    try:
        if sys.argv[1:] == ["setup"]:
            setup()
        elif sys.argv[1:] == ["cleanup"]:
            cleanup()
        elif sys.argv[1:] == ["sessions-zero"]:
            sessions_zero()
        elif len(sys.argv) == 3 and sys.argv[1] == "certificate":
            certificate(sys.argv[2])
        else:
            raise Failure("invalid_command")
    except Exception as error:
        label = error.label if isinstance(error, Failure) else "unexpected_fixture_error"
        codes = error.codes if isinstance(error, Failure) else []
        report(status="failed", failurePhase=PHASE, failure=label, diagnosticCodes=codes)
        print("ORACLE_TCPS_FIXTURE_FAILED " + label, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
