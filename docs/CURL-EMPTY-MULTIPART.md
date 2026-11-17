# Empty multipart cURL export

For `form-data` with no enabled fields, cURL export now emits a literal zero-part
multipart body with `--data-binary`. Its fixed ASCII boundary is 48 characters,
and the closing delimiter plus CRLF is 54 bytes, matching runtime framing and
length. Runtime still generates a fresh random boundary: this is semantic
zero-part equivalence, not byte-for-byte equality across independent executions.

The command targets a POSIX shell. Its quoted body contains actual CRLF bytes;
JSON serialization preserves them. Editors or clipboard workflows that normalize
line endings can change these bytes. Windows shell syntax is not added here.

Explicit Content-Type and Content-Length headers are replaced by the generated
framing headers, including mixed-case input. Empty multipart with Transfer-Encoding
or Trailer is rejected, including API-key injection. API-key injection into
Content-Type or Content-Length is also rejected: runtime retains injected key
spelling and can send conflicting framing headers. Dynamic signing, files
(including disabled file rows), and explicit part-media restrictions remain in
place. Nonempty multipart behavior is unchanged. Node/Python/Go generation still
rejects multipart.

Reimporting this cURL yields a raw body with the fixed boundary and literal CRLF;
it does not reconstruct an editable multipart form or preserve the original
form-data definition. Use project backup for that representation.

Verification: `node --test tests/curl-empty-multipart.test.mjs` runs runtime and
actual cURL against a loopback server, checks each body's own boundary, byte
length, header multiplicity, encoded URL and literal marker header, and verifies
raw reimport. It executes only fixed test fixtures, never imported user commands.
The POSIX execution test is skipped on Windows; pure rejection checks still run.
