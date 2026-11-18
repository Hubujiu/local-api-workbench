# Sourced by run.sh on a fresh, explicitly opted-in hosted VM.
image=mcr.microsoft.com/mssql/server@sha256:e10cd49443c94dbdcb7a050987db22ff4d8c87052ac53768abe1ed848d3fcef6
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=Workbench-Test-CA \
  -keyout "$fixture/ca.key" -out "$fixture/ca.crt" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj /CN=localhost \
  -keyout "$fixture/server.key" -out "$fixture/server.csr" 2>/dev/null
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' > "$fixture/extensions"
openssl x509 -req -in "$fixture/server.csr" -CA "$fixture/ca.crt" -CAkey "$fixture/ca.key" \
  -CAcreateserial -days 2 -extfile "$fixture/extensions" -out "$fixture/server.crt"
cat > "$fixture/mssql.conf" <<'CONFIG'
[network]
tlscert = /var/opt/mssql/workbench.crt
tlskey = /var/opt/mssql/workbench.key
tlsprotocols = 1.2
forceencryption = 1
CONFIG
chmod 644 "$fixture/mssql.conf" "$fixture/server.crt" "$fixture/ca.crt"
sudo chown 10001:0 "$fixture/server.key"
sudo chmod 400 "$fixture/server.key"
export MSSQL_SA_PASSWORD="$admin" SQLCMDPASSWORD="$admin"
container=$(docker run -d --platform linux/amd64 -p 127.0.0.1:1433:1433 \
  -e ACCEPT_EULA=Y -e MSSQL_PID=Developer -e MSSQL_SA_PASSWORD \
  -v "$fixture/mssql.conf:/var/opt/mssql/mssql.conf:ro" \
  -v "$fixture/server.key:/var/opt/mssql/workbench.key:ro" \
  -v "$fixture/server.crt:/var/opt/mssql/workbench.crt:ro" \
  -v "$fixture/ca.crt:/usr/local/share/ca-certificates/workbench.crt:ro" "$image")
docker exec -u 0 "$container" update-ca-certificates >/dev/null
sql() {
  docker exec -i -e SQLCMDPASSWORD "$container" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -b -l 5 "$@"
}
for _ in {1..80}; do
  if sql -Q 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 3
done
sql -Q "SET NOCOUNT ON; SELECT SERVERPROPERTY('ProductVersion'), SERVERPROPERTY('Edition')"
sql -Q 'CREATE DATABASE localapi_gate_ro'
sql -Q 'CREATE DATABASE localapi_gate_rw'
sql -Q "CREATE LOGIN workbench_reader WITH PASSWORD='$reader'"
for db in localapi_gate_ro localapi_gate_rw; do
  sql -d "$db" < tests/fixtures/sqlserver-real-service.sql
  sql -d "$db" -Q 'CREATE USER workbench_reader FOR LOGIN workbench_reader; GRANT SELECT ON dbo.workbench_sqlserver_gate TO workbench_reader'
done
sql -Q 'ALTER DATABASE localapi_gate_ro SET READ_ONLY WITH ROLLBACK IMMEDIATE'
export LOCALAPI_SQLSERVER_REAL=1 LOCALAPI_SQLSERVER_REAL_CONFIG="$fixture/read.json"
jq -n --rawfile ca "$fixture/ca.crt" '
  {host:"localhost",port:1433,user:"workbench_reader",password:env.reader,ssl:true,ca:$ca} as $c |
  {disposable:true,readOnly:($c+{database:"localapi_gate_ro"}),readWrite:($c+{database:"localapi_gate_rw"})}
' > "$LOCALAPI_SQLSERVER_REAL_CONFIG"
node --test tests/sqlserver-real-service.test.mjs
