# Sourced by run.sh on a fresh, explicitly opted-in hosted VM.
archive="$fixture/dm8.tar"
digest=d11acaca7097631675f63875d3438c7c7c28647c64329998c80eaabbd0952b37
image=sha256:06e711491c23bd76ffdaea4387176ffe3d8cab48b30ea330a860ec352bb31e8c
curl -fsSL --retry 2 --max-time 480 -o "$archive" \
  https://download.dameng.com/eco/dm8/dm8_20250206_x86_rh6_rq_single.tar
printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --strict
docker load -i "$archive"
[[ $(docker image inspect --format '{{.Id}} {{.Architecture}}' "$image") == "$image amd64" ]]
server_certs="$fixture/server_ssl"
client_certs="$fixture/client_ssl"
mkdir -p "$server_certs" "$client_certs/SYSDBA" "$client_certs/WORKBENCH_READER"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=Workbench-DM8-Test-CA \
  -keyout "$fixture/ca.key" -out "$server_certs/ca-cert.pem" 2>/dev/null
openssl genrsa -traditional -out "$server_certs/server-key.pem" 2048
openssl req -new -key "$server_certs/server-key.pem" -subj /CN=localhost -out "$fixture/server.csr"
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' > "$fixture/extensions"
openssl x509 -req -in "$fixture/server.csr" -CA "$server_certs/ca-cert.pem" -CAkey "$fixture/ca.key" \
  -CAcreateserial -days 2 -extfile "$fixture/extensions" -out "$server_certs/server-cert.pem"
for name in SYSDBA WORKBENCH_READER; do cp "$server_certs/ca-cert.pem" "$client_certs/$name/ca-cert.pem"; done
# The unprivileged database process owns only its temporary data directory.
cp "$server_certs/ca-cert.pem" "$fixture/ca.crt"
sudo chown -R 65534:65534 "$server_certs" "$client_certs"
container=$(docker run -d --platform linux/amd64 --user 65534:65534 --cap-drop ALL \
  -p 127.0.0.1:5236:5236 --shm-size=512m -e HOME=/tmp -e admin -e LD_LIBRARY_PATH=/opt/dmdbms/bin \
  --mount "type=bind,src=$server_certs,dst=/opt/dmdbms/bin/server_ssl,readonly" \
  --mount "type=bind,src=$client_certs,dst=/opt/dmdbms/bin/client_ssl,readonly" \
  --entrypoint /bin/sh "$image" -ec '
    cd /opt/dmdbms/bin
    mkdir -p /tmp/workbench-db
    ./dminit PATH=/tmp/workbench-db DB_NAME=WORKBENCH INSTANCE_NAME=WORKBENCH CHARSET=1 \
      SYSDBA_PWD="$admin" SYSAUDITOR_PWD="$admin"
    config=/tmp/workbench-db/WORKBENCH/dm.ini
    test -f "$config"
    sed -i -E "s/^([[:space:]]*ENABLE_ENCRYPT[[:space:]]*=[[:space:]]*)[0-9]+/\15/;s/^([[:space:]]*MIN_SSL_VERSION[[:space:]]*=[[:space:]]*)[^[:space:]#]+/\1771/" "$config"
    grep -Eq "^[[:space:]]*ENABLE_ENCRYPT[[:space:]]*=[[:space:]]*5([[:space:]]|$)" "$config"
    exec ./dmserver "$config"')
dm_sql() {
  docker exec -i -w /opt/dmdbms/bin "$container" ./disql -S -L "$1"
}
admin_login="SYSDBA/$admin@127.0.0.1:5236"
reader_login="WORKBENCH_READER/$reader@127.0.0.1:5236"
ready=false
for _ in {1..80}; do
  [[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]] || break
  if printf "SELECT 'WORKBENCH_DM_READY' AS FIXTURE_STATE FROM DUAL;\nEXIT;\n" | dm_sql "$admin_login" > "$fixture/readiness" 2>&1 &&
     grep -Eq '^[[:space:]]*([0-9]+[[:space:]]+)?WORKBENCH_DM_READY[[:space:]]*$' "$fixture/readiness"; then
    ready=true
    break
  fi
  sleep 2
done
if [[ $ready != true ]]; then
  docker logs --tail 35 "$container" 2>&1
  test ! -f "$fixture/readiness" || tail -n 12 "$fixture/readiness"
  return 1
fi
dm_sql "$admin_login" <<SQL
WHENEVER SQLERROR EXIT FAILURE ROLLBACK
SELECT * FROM V\$VERSION;
SELECT PARA_NAME, PARA_VALUE FROM V\$DM_INI WHERE PARA_NAME IN ('ENABLE_ENCRYPT','MIN_SSL_VERSION');
CREATE SCHEMA WORKBENCH AUTHORIZATION SYSDBA;
CREATE TABLE WORKBENCH.READ_FIXTURE(ID BIGINT PRIMARY KEY, AMOUNT DECIMAL(30,3), PAYLOAD VARBINARY(3));
INSERT INTO WORKBENCH.READ_FIXTURE VALUES(1,12345678901234567890.125,HEXTORAW('0001FF'));
COMMIT;
CREATE USER WORKBENCH_READER IDENTIFIED BY "$reader";
GRANT CREATE SESSION TO WORKBENCH_READER;
GRANT SELECT ON WORKBENCH.READ_FIXTURE TO WORKBENCH_READER;
EXIT;
SQL
dm_sql "$reader_login" > "$fixture/native" <<'SQL'
WHENEVER SQLERROR EXIT FAILURE ROLLBACK
SET TRANSACTION READ ONLY;
SELECT 'DM_NATIVE_READ_OK' AS FIXTURE_STATE FROM WORKBENCH.READ_FIXTURE
WHERE ID=1 AND AMOUNT=12345678901234567890.125 AND RAWTOHEX(PAYLOAD)='0001FF';
ROLLBACK;
EXIT;
SQL
cat "$fixture/native"
grep -Eq '^[[:space:]]*([0-9]+[[:space:]]+)?DM_NATIVE_READ_OK[[:space:]]*$' "$fixture/native"
export LOCALAPI_DAMENG_REAL=1 LOCALAPI_DAMENG_PREVIEW=read-only LOCALAPI_DAMENG_REAL_CONFIG="$fixture/reader.json"
jq -n --rawfile ca "$fixture/ca.crt" \
  '{host:"127.0.0.1",serverName:"127.0.0.1",port:5236,ssl:true,user:"WORKBENCH_READER",password:env.reader,ca:$ca}' \
  > "$LOCALAPI_DAMENG_REAL_CONFIG"
node --test tests/dameng-real-service.test.mjs
