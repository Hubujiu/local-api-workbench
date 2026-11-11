# SQL Server protocol-level acceptance, not live database acceptance

`tests/sqlserver-protocol.test.mjs` exercises the unchanged project transport
`createTediousSQLServerPort` with its real pinned Tedious 20.3.8 classes and a
loopback-only synthetic TCP peer. No mock Connection, Request or Socket replaces
the client. No new package or dependency change is introduced. The test peer uses
already installed Tedious internal framing helpers, native-duplexpair and Node
TLS. Internal helper imports are version-coupled to the lockfile; they are not
new public application APIs or an independent TDS implementation.

The fixture follows the upstream Tedious `connection-encryption-test.ts` and
`message-io-test.ts` pattern: PRELOGIN records carry TLS 1.2 handshake data,
then encrypted TLS records carry LOGIN7. Sources:

- https://github.com/tediousjs/tedious/blob/aac5ee16de1d4d4c385ae2278b270af00f16afbe/test/unit/connection-encryption-test.ts
- https://github.com/tediousjs/tedious/blob/aac5ee16de1d4d4c385ae2278b270af00f16afbe/test/unit/message-io-test.ts
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tds/60f56408-0188-4cd5-8b90-25c6f2423868

This is a project-adapter regression, not merely running upstream tests. It checks
that the actual client requests full encryption; OFF, NOT_SUP, omitted and unknown
server encryption responses fail without subsequent client bytes or LOGIN7.
ON/REQ responses perform a real trusted TLS handshake before the synthetic peer
can decode fictional username/database in LOGIN7. An untrusted certificate or a
trusted certificate with a wrong hostname yields no decrypted LOGIN7. Raw TCP is
checked for fictional username, password and TDS-obfuscated-password markers;
absence of these markers alone is not a complete cryptographic traffic proof.

The positive cases deliberately close before LOGINACK: every operation fails with
the project's fixed redacted error and waits for its closure receipt. No SQL is
executed and neither authentication success nor database confirmation is claimed.
One accepted socket per test checks that these paths do not retry. All sockets,
TLS pairs and listeners are locally owned and closed. Test deadlines do not alter
production connect/compiler/query/cleanup budgets.

The existing public test-only localhost key/certificate are reused. A second
certificate, using that same already-public fixture key, has only
`wrong-sqlserver.invalid` in its SAN. It is a negative identity fixture, not a new
production credential or trust-store change. Tests never disable certificate
verification or use trustServerCertificate=true. No EULA, account, real SQL Server
binary or external service is used. Public provider registration remains absent.

Remaining gaps: SQL Server authentication, actual target database/instance
selection, server READ_ONLY enforcement and object side effects, real query/result
TDS semantics, server-side cancellation and platform-specific CI remain separate
acceptance. Passing a synthetic peer is not authorization to enable the provider.

## Upstream attribution

The TLS bridge and PRELOGIN fixture pattern are adapted from the MIT-licensed
Tedious tests cited above. The MIT notice is retained below.

The MIT License

Copyright (c) 2010-2026 Mike D Pilsbury

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
