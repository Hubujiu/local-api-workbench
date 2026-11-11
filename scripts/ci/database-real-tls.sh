#!/usr/bin/env bash
# Disposable CI fixtures only. Reuse service image IDs; never pull or modify services.
set -euo pipefail
mode=${1:?setup or cleanup required}
root=${LOCALAPI_TLS_ROOT:?dedicated LOCALAPI_TLS_ROOT required}
[[ "$root" == "${RUNNER_TEMP:?}/localapi-real-tls" ]] || { echo 'invalid fixture root' >&2; exit 1; }
cleanup() {
  local failed=0 id
  local remaining=()
  if [[ -f "$root/containers" ]]; then
    while IFS= read -r id; do
      [[ "$id" =~ ^[a-f0-9]{64}$ ]] || { failed=1; continue; }
      # Only IDs created and recorded by this invocation, including anonymous volumes.
      if ! docker rm -fv "$id" >/dev/null 2>&1; then failed=1; remaining+=("$id"); fi
    done < "$root/containers"
  fi
  if [[ "$failed" == 0 ]]; then
    rm -rf -- "$root"
  elif (( ${#remaining[@]} )); then
    printf '%s\n' "${remaining[@]}" > "$root/containers"
  fi
  return "$failed"
}
if [[ "$mode" == cleanup ]]; then cleanup; exit; fi
[[ "$mode" == setup && ! -e "$root" ]] || { echo 'fixture setup requires a fresh directory' >&2; exit 1; }
umask 077
mkdir "$root"
: > "$root/containers"
stage=prepare
trap 'status=$?; if (( status != 0 )); then echo "TLS_FIXTURE_SETUP_FAILED stage=$stage" >&2; cleanup || echo TLS_FIXTURE_CLEANUP_FAILED >&2; fi' EXIT
# The CA signing key stays outside every container mount; it is never uploaded.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -sha256 -subj /CN=LocalAPI-CI-CA \
  -keyout "$root/ca.key" -out "$root/ca.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -sha256 -subj /CN=LocalAPI-CI-Wrong-CA \
  -keyout "$root/wrong-ca.key" -out "$root/wrong-ca.crt" >/dev/null 2>&1
for variant in good bad; do
  mkdir "$root/$variant"
  san='DNS:localhost,IP:127.0.0.1'
  [[ "$variant" == good ]] || san='DNS:wrong.invalid'
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n' "$san" > "$root/$variant/extensions"
  openssl req -new -newkey rsa:2048 -nodes -subj /CN=localapi-fixture \
    -keyout "$root/$variant/server.key" -out "$root/$variant/server.csr" >/dev/null 2>&1
  openssl x509 -req -in "$root/$variant/server.csr" -CA "$root/ca.crt" -CAkey "$root/ca.key" \
    -set_serial "$([[ "$variant" == good ]] && echo 1 || echo 2)" -days 1 -sha256 \
    -extfile "$root/$variant/extensions" -out "$root/$variant/server.crt" >/dev/null 2>&1
  cp "$root/ca.crt" "$root/$variant/ca.crt"
  rm "$root/$variant/extensions" "$root/$variant/server.csr"
  cat > "$root/$variant/pg_hba.conf" <<'HBA'
local all all trust
hostnossl all all 0.0.0.0/0 reject
hostnossl all all ::/0 reject
hostssl all all 0.0.0.0/0 scram-sha-256
hostssl all all ::/0 scram-sha-256
HBA
  cat > "$root/$variant/redis.conf" <<'REDIS'
bind 0.0.0.0
protected-mode yes
port 0
tls-port 6379
tls-cert-file /tls/server.crt
tls-key-file /tls/server.key
tls-ca-cert-file /tls/ca.crt
tls-auth-clients no
unixsocket /tmp/localapi-redis.sock
unixsocketperm 700
save ""
appendonly no
user default off
user fixture_admin on >public-ci-admin-only ~* +@all
user tls_reader on >public-ci-tls-only ~localapi:tls +ping +get
REDIS
done
# Prevent accidental mounting of either signing key even in future copy changes.
rm "$root/ca.key" "$root/wrong-ca.key"
for engine in postgres mysql redis; do
  stage="image-$engine"
  case "$engine" in
    postgres) service=${POSTGRES_SERVICE_ID:?}; port=5432 ;;
    mysql) service=${MYSQL_SERVICE_ID:?}; port=3306 ;;
    redis) service=${REDIS_SERVICE_ID:?}; port=6379 ;;
  esac
  image=$(docker inspect --format '{{.Image}}' "$service")
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'invalid service image ID' >&2; exit 1; }
  printf '%s %s\n' "$engine" "$image" >> "$root/image-ids.txt"
  printf 'TLS_FIXTURE_IMAGE engine=%s image=%s\n' "$engine" "$image"
  for variant in good bad; do
    stage="create-$engine-$variant"
    args=(create --pull=never -p "127.0.0.1::$port" --mount "type=bind,source=$root/$variant,target=/fixture,readonly" --tmpfs /tls:rw,noexec,nosuid,size=1m --entrypoint /bin/sh)
    case "$engine" in
      postgres)
        args+=(-e POSTGRES_USER=fixture_admin -e POSTGRES_PASSWORD=public-ci-admin-only -e POSTGRES_DB=fixture)
        command='cp /fixture/* /tls/; chown -R postgres:postgres /tls; chmod 755 /tls; chmod 600 /tls/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tls/server.key -c hba_file=/tls/pg_hba.conf'
        ;;
      mysql)
        args+=(-e MYSQL_ROOT_PASSWORD=public-ci-admin-only -e MYSQL_DATABASE=fixture)
        command='cp /fixture/* /tls/; chown -R mysql:mysql /tls; chmod 755 /tls; chmod 600 /tls/server.key; exec docker-entrypoint.sh mysqld --ssl-ca=/tls/ca.crt --ssl-cert=/tls/server.crt --ssl-key=/tls/server.key --require-secure-transport=ON'
        ;;
      redis)
        command='cp /fixture/* /tls/; chown -R redis:redis /tls; chmod 755 /tls; chmod 600 /tls/server.key; exec docker-entrypoint.sh redis-server /tls/redis.conf'
        ;;
    esac
    id=$(docker "${args[@]}" "$image" -ec "$command")
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || exit 1
    printf '%s\n' "$id" >> "$root/containers"
    printf '%s\n' "$id" > "$root/$engine-$variant.id"
    docker start "$id" >/dev/null
    binding=$(docker port "$id" "$port/tcp")
    [[ "$binding" =~ ^127\.0\.0\.1:([0-9]+)$ ]] || exit 1
    printf '%s %s %s\n' "$engine" "$variant" "${BASH_REMATCH[1]}" >> "$root/ports.txt"
  done
done
# Bounded socket-only bootstrap. No certificate verification bypass for TCP.
deadline=$((SECONDS + 120))
for engine in postgres mysql redis; do
  for variant in good bad; do
    id=$(cat "$root/$engine-$variant.id")
    stage="ready-$engine-$variant"
    case "$engine" in
      postgres) ready=(docker exec --user postgres "$id" sh -ec 'case "$(readlink /proc/1/exe)" in */postgres) ;; *) exit 1;; esac; exec psql -U fixture_admin -d fixture -Atqc "SELECT 1"') ;;
      mysql) ready=(docker exec --user mysql -e MYSQL_PWD=public-ci-admin-only "$id" sh -ec 'case "$(readlink /proc/1/exe)" in */mysqld) ;; *) exit 1;; esac; exec mysql --protocol=socket -uroot -Nse "SELECT 1"') ;;
      redis) ready=(docker exec -e REDISCLI_AUTH=public-ci-admin-only "$id" redis-cli -s /tmp/localapi-redis.sock --user fixture_admin PING) ;;
    esac
    ok=0
    while (( SECONDS < deadline )); do
      if timeout 3 "${ready[@]}" >/dev/null 2>&1; then ok=1; break; fi
      sleep 1
    done
    [[ "$ok" == 1 ]] || exit 1
    stage="policy-$engine-$variant"
    case "$engine" in
      postgres)
        policy=$(docker exec "$id" psql -U fixture_admin -d fixture -Atqc "SELECT CASE WHEN current_setting('ssl') = 'on' AND (SELECT count(*) FROM pg_hba_file_rules WHERE type = 'hostnossl' AND auth_method = 'reject' AND error IS NULL) = 2 THEN 1 ELSE 0 END")
        [[ "$policy" == 1 ]] || exit 1
        ;;
      mysql)
        policy=$(docker exec -e MYSQL_PWD=public-ci-admin-only "$id" mysql --protocol=socket -uroot -Nse 'SELECT @@GLOBAL.require_secure_transport')
        [[ "$policy" == 1 ]] || exit 1
        ;;
      redis)
        plain=$(docker exec -e REDISCLI_AUTH=public-ci-admin-only "$id" redis-cli -s /tmp/localapi-redis.sock --user fixture_admin --raw CONFIG GET port 2>/dev/null | tail -n 1)
        secure=$(docker exec -e REDISCLI_AUTH=public-ci-admin-only "$id" redis-cli -s /tmp/localapi-redis.sock --user fixture_admin --raw CONFIG GET tls-port 2>/dev/null | tail -n 1)
        [[ "$plain" == 0 && "$secure" == 6379 ]] || exit 1
        ;;
    esac
    stage="seed-$engine-$variant"
    case "$engine" in
      postgres)
        docker exec -i "$id" psql -v ON_ERROR_STOP=1 -U fixture_admin -d fixture >/dev/null <<'SQL'
CREATE ROLE tls_reader LOGIN PASSWORD 'public-ci-tls-only';
GRANT CONNECT ON DATABASE fixture TO tls_reader;
CREATE TABLE tls_fixture(value text);
INSERT INTO tls_fixture VALUES ('tls-value');
GRANT SELECT ON tls_fixture TO tls_reader;
SQL
        ;;
      mysql)
        docker exec -i -e MYSQL_PWD=public-ci-admin-only "$id" mysql --protocol=socket -uroot >/dev/null <<'SQL'
CREATE USER 'tls_reader'@'%' IDENTIFIED BY 'public-ci-tls-only' REQUIRE SSL;
CREATE TABLE fixture.tls_fixture(value varchar(32));
INSERT INTO fixture.tls_fixture VALUES ('tls-value');
GRANT SELECT ON fixture.* TO 'tls_reader'@'%';
SQL
        ;;
      redis)
        docker exec -e REDISCLI_AUTH=public-ci-admin-only "$id" redis-cli -s /tmp/localapi-redis.sock --user fixture_admin SET localapi:tls tls-value >/dev/null 2>&1
        ;;
    esac
  done
done
# Publish policy evidence only after every live fixture has answered the checks.
cat > "$root/server-policy.json" <<'JSON'
{"postgres":{"ssl":true,"hostnosslReject":true},"mysql":{"requireSecureTransport":true},"redis":{"port":0,"tlsPort":6379}}
JSON
node --input-type=module - "$root" <<'JS'
import fs from 'node:fs';
const root=process.argv[2], ports={};
for(const line of fs.readFileSync(root+'/ports.txt','utf8').trim().split('\n')){
 const [engine,variant,port]=line.split(' '); (ports[engine]??={})[variant]=Number(port);
}
fs.writeFileSync(root+'/ports.json',JSON.stringify(ports));
JS
printf '%s\n' TLS_FIXTURES_READY
