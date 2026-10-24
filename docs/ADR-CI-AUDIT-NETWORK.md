# Desktop CI: bounded network waits, mandatory audits

The f00558d Windows desktop job first failed because the npm advisory endpoint timed out. Its retry spent about five minutes in each npm ci and was cancelled at roughly the existing fifteen-minute job limit while npm audit was still pending. No package build or smoke test ran in that attempt. This does not establish a product failure or a successful security audit.

Desktop CI now separates dependency installation from security validation. Install commands use --no-audit only to avoid repeated implicit advisory requests. Explicit root and desktop npm audit --audit-level=high commands must both succeed before packaging. The root audit is now an explicit blocking gate as well. Neither gate uses continue-on-error, optional conditions, a success fallback, or a lower severity threshold.

The desktop job sets npm fetch timeout to 30 seconds and one retry, with a bounded retry delay. The fifteen-minute job limit and test budgets remain unchanged. Network failure still fails the job; it is not reclassified as a clean audit. These settings reduce time lost to an unavailable endpoint, but do not repair npm's service or prove Windows desktop validation. The exact commit's CI remains the acceptance evidence.

A workflow regression test checks the presence, order, mandatory behavior, and network bounds of these gates. It does not replace either real audit or desktop smoke tests.

A later macOS attempt (ada2c28) failed closed at the 30-second advisory endpoint timeout. The gate now runs through npm run audit:ci (and -- --prefix desktop). The wrapper invokes the same high-severity audit with JSON output, retries only recognizable network failures once after two seconds, and preserves a final failure. Each child audit has a 90-second outer limit. A valid clean report and zero exit code are both required; high/critical findings, malformed output, non-network failures, or a second network failure cannot pass. Regression tests exercise these paths. Real root and desktop audits also pass locally; only exact-commit CI establishes runner validation.

The same bounded npm fetch settings now also apply at workflow scope: otherwise non-desktop installs could still spend five minutes in implicit audit requests. Their install behavior and all mandatory desktop audit gates remain unchanged. This does not mark an unavailable registry as audited or turn dependency download failures into success.
