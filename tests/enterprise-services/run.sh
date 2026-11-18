#!/usr/bin/env bash
set -euo pipefail
[[ ${WORKBENCH_DB_TERMS:-} == accepted ]] || { echo 'Set WORKBENCH_DB_TERMS=accepted after accepting the selected vendor development/test terms.' >&2; exit 2; }
local_dameng=false
if [[ $# == 2 && $1 == --local-dameng ]]; then
  [[ -n ${DOCKER_HOST:-} && -f $2 ]] || { echo 'Supply a disposable Docker daemon and the official DM8 archive.' >&2; exit 2; }
  local_dameng=true
  ENGINE=dameng
  WORKBENCH_DM8_ARCHIVE=$(realpath -- "$2")
  EXPECTED_HEAD=$(git rev-parse HEAD)
  git diff --quiet HEAD -- . || { echo 'Commit tracked changes before recording local acceptance.' >&2; exit 2; }
  temp_root=$(realpath -- "${TMPDIR:-/tmp}")
else
  [[ $# == 0 && ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
  temp_root=$(realpath -- "$RUNNER_TEMP")
fi
[[ $(git rev-parse HEAD) == "$EXPECTED_HEAD" ]]
umask 077
fixture=$(mktemp -d "$temp_root/workbench-db-XXXXXXXX")
readonly fixture
container=
cleanup() {
  if [[ $container =~ ^[0-9a-f]{64}$ ]]; then docker rm -fv "$container" >/dev/null; fi
  if [[ $local_dameng == true && $(dirname -- "$fixture") == "$temp_root" && $(basename -- "$fixture") =~ ^workbench-db-[A-Za-z0-9]{8}$ ]]; then
    if (( EUID == 0 )); then rm -rf -- "$fixture"; else sudo rm -rf -- "$fixture"; fi
  fi
}
trap cleanup EXIT
password_bytes=20
if [[ $ENGINE == dameng ]]; then password_bytes=16; fi
admin="Aa9$(openssl rand -hex "$password_bytes")"
reader="Bb8$(openssl rand -hex "$password_bytes")"
export admin reader
if [[ $local_dameng == false ]]; then
  echo "::add-mask::$admin"
  echo "::add-mask::$reader"
fi
case "$ENGINE" in
  sqlserver) source tests/enterprise-services/sqlserver.sh ;;
  oracle) source tests/enterprise-services/oracle.sh ;;
  dameng) source tests/enterprise-services/dameng.sh ;;
  *) exit 2 ;;
esac
echo "REAL_DATABASE_ACCEPTANCE_PASS $ENGINE $EXPECTED_HEAD $image"
