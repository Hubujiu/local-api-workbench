# Durable unsigned product-journey baseline

The mandatory product journey now builds its old `0.1.0` installation from the
previously reviewed exact official source commit in `windows-baseline-source-lock.json`.
It does not depend on the retention window of the historical Actions artifacts.
The historical archive lock and its strict downloader remain unchanged for separate
historical-byte verification; the journey does not fall back between these modes.

The dedicated baseline job checks the exact clean Git checkout and SHA-256 of all
four package/lock inputs, installs the historical locked dependencies, and executes
that commit's desktop builder, manifest writer and complete portable verifier.
The current authoring helper additionally verifies the resulting inventory, Windows
names, `0.1.0` application identity and x64 architecture. The same exact checkout is
checked again after building. It never rewrites historical version files.

This is a **new source rebuild**, not a reproduction of the original ZIP. Timestamp,
runtime packaging or other build inputs may yield different bytes. The job emits a
new manifest hash and an independently hashed `source-rebuild.json` receipt. The MSI
authoring job verifies both independent outputs against the source lock and candidate
head, then re-verifies each payload in normal MSI preparation. The receipt is retained
beside the transferred plan. A mismatch fails closed; original archive hashes are
never repurposed as claims about the rebuild. These hashes are integrity evidence,
not a code signature or reproducible-build attestation.

Candidate versions come from the candidate's committed package and lockfiles. Both
source identity and MSI authoring enforce canonical MSI versions >= `0.1.1`, including
future `0.1.2`, `0.2.0`, etc. The old product remains `0.1.0`; normal same-family upgrade,
downgrade prevention, failure rollback and native product validation stay unchanged.

No signing, release deployment, workflow dispatch or runner-setting change is part
of this patch. Local fixture/contract checks cannot establish native Windows success;
the next authorized hosted journey must build both actual products and complete the
existing native/standard-user gates before being treated as release evidence.
