# Public TLS test fixtures

localhost.crt and localhost.key are intentionally public, generated solely for loopback HTTPS tests. They authorize no real account or service. Never use this certificate/key in production or add its CA to a system trust store. The tests supply it only to the single fixture request that requires it.

oracle-valid.crt and oracle-expired.crt are loopback leaves signed by the existing
public localhost test CA, using the separate, intentionally public
oracle-fixture.key. The valid leaf expires in November 2030; the expired leaf
expired on November 2, 2026. Oracle isolated-CA tests parse both, assert the issuer,
signature, key match and validity windows, and verify a concrete
CERT_HAS_EXPIRED TLS error. Empty fixtures fail at module load. None of these
files represents production credentials or a system trust anchor.
