# Failure-only packaged script diagnostics

The macOS packaged smoke check twice exhausted the unchanged 250 ms script activity budget on the same production commit. The first result reached asynchronous completion after successful HTTP and subrequest responses; the retry exhausted the initial user-script phase. Local Linux execution of the identical combined fixture passed twenty runs (54–74 ms activity). That difference does not establish a runner-load cause or prove macOS stability.

On failure only, the desktop check now preserves the original failure screenshot and result, then runs bounded isolated schema, utility and JSON5/crypto probes plus a combined diagnostic without the schema assertions. These probe outcomes are diagnostic logs only. They never replace the original assertion, retry it into success, alter the runtime budget, disable checks or change application source. The original combined acceptance source is pinned by a SHA-256 regression using a fixed fictional loopback URL. It must still pass for the job to succeed.

All probe requests use the same already-created loopback fixture. No real account, external endpoint or user project is involved. Probe errors retain the original test failure. The existing overall watchdog and shutdown checks remain in effect. This change gathers evidence for a performance investigation; it is not itself a timeout fix.
