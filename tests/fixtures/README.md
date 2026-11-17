# Public TLS test fixtures

localhost.crt and localhost.key are intentionally public, generated solely for loopback HTTPS tests. They authorize no real account or service. Never use this certificate/key in production or add its CA to a system trust store. The tests supply it only to the single fixture request that requires it.
