#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${WORKBENCH_DB_TERMS:-} == accepted ]]
[[ $(git rev-parse HEAD) == "$EXPECTED_HEAD" ]]
umask 077
fixture=$(mktemp -d "$RUNNER_TEMP/workbench-db-XXXXXXXX")
container=
cleanup() {
  if [[ $container =~ ^[0-9a-f]{64}$ ]]; then docker rm -fv "$container" >/dev/null; fi
}
trap cleanup EXIT
admin="Aa9$(openssl rand -hex 20)"
reader="Bb8$(openssl rand -hex 20)"
export admin reader
echo "::add-mask::$admin"
echo "::add-mask::$reader"
case "$ENGINE" in
  sqlserver) source tests/enterprise-services/sqlserver.sh ;;
  oracle) source tests/enterprise-services/oracle.sh ;;
  *) exit 2 ;;
esac
echo "REAL_DATABASE_ACCEPTANCE_PASS $ENGINE $EXPECTED_HEAD $image"
