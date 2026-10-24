# Form file selection is bound to its original editing context

Reading a selected file is asynchronous. A completion must not write into whichever
request or row happens to be selected later, nor replace a newer file choice with
an older read that finished last. Each form-row selection now has a token and a
captured project/request/body-type/row identity. A stale completion is discarded
before mutation or rendering. Removing the row, changing the request/project,
leaving the API page, changing body type, clearing the selection, or choosing a
newer file prevents that stale write.

The existing 6 MiB input limit remains and is also checked against the resulting
bytes. Base64 conversion still occurs locally; this does not upload the file until
the user sends the API request. Persisted files remain part of local plaintext
project data. No host filesystem paths are read by this helper.

Unit tests force out-of-order completion and cancellation. The browser test delays
actual File reads, navigates to another request, chooses a newer file, and checks
persisted filenames and bytes. The same application UI and save path are exercised.
