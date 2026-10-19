# Bounded Redis reads

Apipost's database reference includes Redis among its database integrations:
https://wiki.apipost.cn/docs/http_debug/database/ . This adds a read-only subset;
it does not claim all commands, Redis Cluster/Sentinel or database script hooks.

The wire client implements bounded RESP2 framing from
https://redis.io/docs/latest/develop/reference/protocol-spec/ . Arguments use
binary-safe length-prefixed strings, not an inline command or shell. No Redis
server or external executable is bundled into the desktop product.

Choose Redis in the database page, enter host/port, optional username/password,
numeric database index, TLS choice, and a JSON command array such as
`["GET","key"]`. Credentials remain request-scoped and are not saved.

Supported reads: PING, GET, TYPE, TTL/PTTL, STRLEN, HLEN, LLEN, SCARD, ZCARD,
HGET, HEXISTS, SISMEMBER, ZSCORE, MGET, EXISTS, HMGET, bounded LRANGE/ZRANGE/
GETRANGE, and SCAN/HSCAN/SSCAN/ZSCAN with MATCH/COUNT. No SET, EVAL, CONFIG,
KEYS, unbounded HGETALL/SMEMBERS, pubsub or arbitrary commands. Collection
ranges are capped at1000 items; GETRANGE at64KiB; multi-key reads at100keys.
SCAN COUNT is a server hint, not a guarantee; response-size limits still apply.

- Total connection/auth/select/query deadline at most3seconds, no reconnect.
- At most64KiB per encoded command,1MiB per bulk string,2MiB received wire data,
  8 nested levels,5000 parsed nodes and2002 members per RESP array.
- Results show at most1000 rows; SCAN returns its cursor for explicit paging.
- Non-UTF8 bulk strings are labelled base64; large integers remain strings.
- TLS verification is mandatory, with optional caller-supplied CA. No certificate
  bypass, Unix socket discovery, filesystem reads or credential discovery.

The UI and protocol fixtures use synthetic local values. CI additionally starts
an isolated official Redis7.2 service, seeds fictional data, and checks real
GET/MGET/list/hash-scan behavior and mutation rejection. Authentication and TLS
framing are independently tested against loopback protocol fixtures.
