# Downloaded portable verification

The `downloaded-portable` jobs depend on the desktop matrix and download each
successful portable artifact from the same workflow run into a separate runner
temporary directory. The existing pre-archive manifest check and clean/crash
Electron journeys remain unchanged. No external artifact is replaced or executed.

The verifier reads the Windows downloaded directory, or streams the Linux/macOS
inner `tar.gz` without extraction. It requires the exact expected commit and
platform, the complete manifest file/hash and symbolic-link inventory, valid local
link resolution, the application entrypoints and an executable Unix launcher.
The manifest next to the Unix archive must match its internal copy byte-for-byte.
The gzip trailer is consumed to validate its CRC, not just the tar end marker.
Unsupported entries, duplicate/traversing paths, missing/extra/changed files,
identity mismatches, lost executable permissions and broken/escaping/cyclic links
fail the job. The verifier assumes a quiescent isolated download directory.

Python 3.12 is a verification-job dependency only. It is not a product runtime or
an additional prerequisite of `npm test`. Standard-library unit tests use inert
synthetic files and run on each platform before the artifact is downloaded.

This verifies the distributed bytes and structure after GitHub artifact download;
it is not another application launch, a signature/notarization check, an installer
acceptance test or a guarantee on arbitrary user machines. GitHub's downloader
handles the outer artifact ZIP; this script does not independently claim an outer
ZIP digest comparison. The manifest is a consistency record, not a cryptographic
publisher signature or proof of the provenance of every transitive dependency.
