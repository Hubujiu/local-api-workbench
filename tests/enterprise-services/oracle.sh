# Sourced by run.sh on a fresh, explicitly opted-in hosted VM.
image=container-registry.oracle.com/database/free@sha256:0f2792015eec52d167244eddfba8ab2e333bbf76a824a5615d2095f84a2b1740
export ORACLE_PWD="$admin" WALLET_PASSWORD="Cc7$(openssl rand -hex 16)"
echo "::add-mask::$WALLET_PASSWORD"
container=$(docker run -d --platform linux/amd64 --shm-size=1g \
  -p 127.0.0.1:2484:2484 -e ORACLE_PWD "$image")
for _ in {1..120}; do
  if [[ $(docker inspect --format '{{.State.Health.Status}}' "$container") == healthy ]]; then break; fi
  sleep 4
done
[[ $(docker inspect --format '{{.State.Health.Status}}' "$container") == healthy ]]
docker exec -i -u oracle -e WALLET_PASSWORD "$container" bash -se <<'ORACLE_TLS'
set -eu
wallet=/tmp/workbench-server-wallet
mkdir -m 700 "$wallet"
orapki wallet create -wallet "$wallet" -pwd "$WALLET_PASSWORD" -auto_login
orapki wallet add -wallet "$wallet" -pwd "$WALLET_PASSWORD" -dn CN=localhost -keysize 2048 -self_signed -validity 2
orapki wallet export -wallet "$wallet" -pwd "$WALLET_PASSWORD" -dn CN=localhost -cert /tmp/workbench-oracle.crt
listener=$(lsnrctl status | awk '/Listener Parameter File/{print $NF; exit}')
[[ -f "$listener" ]]
netdir=$(dirname "$(readlink -f "$listener")")
cat >> "$listener" <<NET

WORKBENCH_TLS = (DESCRIPTION=(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=1522))(ADDRESS=(PROTOCOL=TCPS)(HOST=0.0.0.0)(PORT=2484))))
WALLET_LOCATION = (SOURCE=(METHOD=FILE)(METHOD_DATA=(DIRECTORY=$wallet)))
SSL_CLIENT_AUTHENTICATION = FALSE
NET
cat >> "$netdir/sqlnet.ora" <<NET

WALLET_LOCATION = (SOURCE=(METHOD=FILE)(METHOD_DATA=(DIRECTORY=$wallet)))
SSL_CLIENT_AUTHENTICATION = FALSE
NET
lsnrctl start WORKBENCH_TLS
ORACLE_TLS
oracle_sql() {
  docker exec -i -u oracle "$container" sqlplus -s -L '/ as sysdba'
}
{
  cat <<SQL
whenever oserror exit failure
whenever sqlerror exit failure rollback
set echo off verify off feedback off
select banner_full from v\$version;
alter system set local_listener='(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=1521))(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=1522)))' scope=memory;
alter system register;
alter session set container=FREEPDB1;
create user WORKBENCH_GATE no authentication default tablespace USERS quota 2M on USERS;
create user WORKBENCH_READER identified by "$reader";
grant create session to WORKBENCH_READER;
SQL
  cat tests/fixtures/oracle-real-service.sql
  echo 'grant select on WORKBENCH_GATE.WORKBENCH_ORACLE_GATE to WORKBENCH_READER;'
  echo 'exit'
} | oracle_sql
for _ in {1..30}; do
  if docker exec -u oracle "$container" lsnrctl services WORKBENCH_TLS | grep -qi 'Service "FREEPDB1"'; then break; fi
  sleep 2
done
docker exec -u oracle "$container" lsnrctl services WORKBENCH_TLS
docker cp "$container:/tmp/workbench-oracle.crt" "$fixture/ca.crt"
export LOCALAPI_ORACLE_PREVIEW=read-only LOCALAPI_ORACLE_REAL=1 LOCALAPI_ORACLE_REAL_CONFIG="$fixture/read.json"
jq -n --rawfile ca "$fixture/ca.crt" '
  {disposable:true,connection:{host:"localhost",port:2484,database:"FREEPDB1",user:"WORKBENCH_READER",
  password:env.reader,ssl:true,serverDN:"CN=localhost",ca:$ca}}
' > "$LOCALAPI_ORACLE_REAL_CONFIG"
node --test tests/oracle-real-service.test.mjs
