# Isolating Mock documents from the workbench origin

## Threat and boundary

Mock can serve arbitrary user/import-provided body strings and media types on the
same loopback origin as the authenticated workbench. A direct browser navigation
to a text/html or SVG response must not turn that sample into a script-capable
workbench page. `nosniff` alone does not prevent correctly typed HTML execution.

Every successful Mock response now has server-owned headers:

- Content-Security-Policy: `sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- X-Content-Type-Options: `nosniff`
- Cache-Control: `no-store`

The shared editor/server validator rejects attempts to supply CSP (including
report-only), nosniff, cache-control, Set-Cookie, Clear-Site-Data, or Refresh headers.
Existing framing-header protections remain. Header matching is case-insensitive.

These are intentional limits of a same-origin local Mock service. Executable
HTML pages, cookie-changing responses, and arbitrary browser-state headers need
a separately isolated service/origin; they are not provided by this endpoint.
Response body bytes, status, safe media type and ordinary custom headers remain
available to API clients. The workbench's ordinary static-page CSP is unchanged.

## Verification

The regression first failed because real Mock HTML lacked a sandbox policy and
browser-state headers were accepted. Tests now check actual HTTP policy, body
preservation, no-store/nosniff, and rejection of Set-Cookie without emitting it.

The browser case creates and saves an HTML example through the UI, opens its Mock
URL in a separate page in the same authenticated test context, and verifies:

- The harmless heading renders but the inline script marker never executes.
- Script/image/form probes do not reach the synthetic session endpoint.
- A form click cannot navigate the page or change the main workbench selection.

This is targeted origin-isolation evidence, not a claim of a complete application
security audit or exact browser compatibility with the reference application.

Reference: [W3C CSP sandbox directive](https://www.w3.org/TR/CSP3/#directive-sandbox).
