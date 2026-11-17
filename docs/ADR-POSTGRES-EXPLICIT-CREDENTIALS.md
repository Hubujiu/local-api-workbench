# Explicit PostgreSQL client identity and startup policy

The installed pg 8.16.3 resolves missing/null/empty identity fields through PG*
environment variables. Its null-password path can read PGPASSFILE/HOME .pgpass,
and an omitted ssl field can inherit PGSSLMODE=no-verify. PGOPTIONS, PGAPPNAME
and PGREPLICATION also affect startup. This conflicts with request/session/CLI
credentials being explicit and scoped. No actual credential disclosure is
claimed; reproduction uses only a fresh child process with synthetic variables
and a memory-only pgpass substitute, never real password files.

Both read and explicitly opted-in write paths use one new client factory:

- Require explicit nonempty user/database before SSH or connection creation.
- Missing/empty password means an actual empty password provider, never undefined,
  null, ambient PG credentials or a password-file lookup; repeated auth challenges
  retain that rule. Supplied passwords remain private per-client closures.
- Use pg's exported pure-JS client/type-overrides subpaths, not the package entry
  that can select libpq via NODE_PG_FORCE_NATIVE.
- Pass ssl:false explicitly, or retain strict certificate/host verification with
  an explicitly supplied CA. No verification bypass is added.
- Allowlist startup identity/application/statement budget; remove options and
  replication state before connecting. The wire serializer's fixed UTF8 is tested.
- Keep connection/statement/query budgets at 3000/2000/3000ms, readonly transaction
  and extended-query protections, write opt-in/count/commit handling and SSH pins.
- Do not mutate process.env, pg.defaults, another client's identity or MySQL.

Focused acceptance includes concurrent fake-environment clients on a real local
TCP endpoint with PostgreSQL startup/cleartext-auth framing, two auth challenges
per client, missing/empty/explicit password, no pgpass calls, no ambient startup
fields or TLS negotiation, and immutable per-client inputs. The endpoint is a
protocol capture fixture, not a database server. Existing real PostgreSQL/SSH
read/write CI remains required for the exact commit before acceptance. Existing
unit fixtures now name their PG identity explicitly rather than relying on
process defaults. Native-import/CLI/MCP combination fixtures must do the same.

This does not claim to sandbox arbitrary PostgreSQL functions or replace a
least-privilege database role. Existing manual writes remain separately opt-in;
no sessions or imported task gain write rights, persistent credentials, or retries.

## TLS wire follow-up

The isolated synthetic-environment child also negotiates the actual PostgreSQL SSLRequest and upgrades the same TCP socket to TLS. Explicit fixture CA plus localhost succeeds and authenticates; missing CA and a mismatched logical hostname reject before PostgreSQL startup or password transmission. Only the fixture socket's TCP destination is redirected to loopback, leaving the actual driver's TLS hostname verification intact. No global trust, DNS, or TLS configuration is changed. This is protocol/TLS evidence, not an SQL server.
