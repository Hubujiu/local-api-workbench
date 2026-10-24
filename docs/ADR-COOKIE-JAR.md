# Local, opt-in Cookie manager

Reference: https://wiki.apipost.cn/docs/http/cookies/ describes storing server
cookies, automatic reuse behind an explicit switch, management operations and
manual-header precedence. Cookie matching/parsing uses pinned tough-cookie6.0.2
(BSD-3-Clause): https://github.com/salesforce/tough-cookie .

## Scope and privacy

- Default off. Enabling is an explicit UI action for one project and environment.
  Enabled mode replaces manually entered Cookie headers/parameter rows with the
  jar's matching cookies. Disabling restores the existing manual precedence.
- Local state is separate from portable project files and project backup/export.
  The jar file itself is excluded; request/response evidence can still contain
  Cookie or Set-Cookie values and must be reviewed before sharing a project.
  It is plaintext, not an OS credential vault; the UI says so and masks values.
  All stored cookies, including session cookies, survive application restart
  until expiry or explicit deletion. This is API-client behavior, not browser
  session lifecycle emulation.
- Domain, host-only, path, expiry, Secure and cookie-prefix checks apply. Secure
  cookies are never sent over HTTP, including localhost. This is not a browser
  navigation engine; no browser SameSite/top-level-site emulation is claimed.
- Manual create/update/delete/clear uses revision checks. Writes use the existing
  cross-process lock and atomic rename; concurrent response capture merges into
  fresh state. Invalid server cookies are ignored; storage failures are retained
  as response evidence rather than discarding the HTTP response.
- Limits:500cookies per project/environment,4KiB per Set-Cookie,100 response
  Set-Cookie headers and2MiB storage. Control characters are rejected. Max-Age is
  converted to an absolute expiry so reads/settings changes cannot renew it.

## Execution

Debug requests, plans, CLI and authorized MCP executions use the selected local
jar. Script HTTP/$.ajax callbacks share that same jar, so login-before-request
works without exporting host APIs into QuickJS. Digest's challenge retry retains
its jar context. Cancellation suppresses capture after the signal is aborted.

Load tests take an initial jar snapshot and create an isolated in-memory copy
per iteration. Their response cookies never overwrite the user's persistent
jar or leak into another iteration.

UI management is available from the request Cookie tab. Mutations take effect
immediately; closing the dialog does not undo them. Clear/delete actions require
an explicit confirmation inside the application. A stale edit remains open and
can be reloaded rather than overwriting newly captured cookies.

Validation uses fictional values and loopback fixtures only. Unit/integration
coverage includes restart, project/environment separation, domain/path/Secure,
prefixes, Max-Age, IPv6, revision conflicts, concurrent response capture, real
script/main requests and load snapshot isolation. Browser checks cover opt-in,
creation/edit persistence, masked display, stale revision recovery and deletion.

Manager dialog reads/writes are scoped to the exact open dialog instance. Closing
and reopening cannot let a delayed response overwrite the newer draft. The
browser regression deliberately holds an earlier read, reopens the manager and
edits a new URL before releasing that read; the new draft must remain intact.
