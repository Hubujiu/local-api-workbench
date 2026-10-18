# HTTP/2 CONNECT and cURL protocol fidelity

- HTTP/2 now uses an explicit CONNECT tunnel for HTTP or HTTPS proxies, for both cleartext h2c and TLS origins. HTTP/1.1's existing forward-proxy/CONNECT behavior remains supported by shared tunnel setup.
- Origin TLS CA/client certificate/key and proxy TLS CA are separate. The proxy receives only its own Basic proxy credentials; those are not added to origin HTTP/2 headers. Origin TLS verifies the target hostname inside the tunnel. Neither leg disables certificate validation.
- New tls.proxyCa is available in API design and step connection editing. It trusts only the HTTPS proxy, not the origin. Proxy client-certificate authentication is not added by this change.
- CONNECT timeout/cancellation, target stream deadline and cleanup remain bounded. Native tests cover all four target/proxy TLS combinations, independent trust failures, origin hostname mismatch and origin mutual TLS.
- cURL export explicitly chooses HTTP/1.1 or strict HTTP/2 prior knowledge and forces tunneling for proxied HTTP/2. --globoff prevents literal URL brackets from expanding; --noproxy fixes explicit/direct behavior instead of inheriting unrelated environment proxy exclusions. HTTP/2 HTTPS requires curl8.10+with HTTP/2 support; older versions offered HTTP/1.1 fallback even with prior-knowledge.
- Import accepts the emitted protocol/tunnel/global-proxy flags, but rejects multiple URLs rather than silently keeping the last one. Selective proxy bypass lists, HTTP/1.1 cleartext CONNECT and upgrade/fallback-only HTTP/2 semantics remain unsupported rather than silently translated.
- Inline certificate, binary/file and dynamic-signature cURL export still requires manual configuration. Linux integration executes generated Bash commands against actual local h2c fixtures, direct and through CONNECT, with apostrophes/literal brackets and conflicting environment proxy settings. No Windows/macOS system-cURL runtime compatibility is claimed.

Primary reference: https://curl.se/docs/manpage.html#--http2-prior-knowledge
