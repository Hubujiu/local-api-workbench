# Selected definition export in the workbench

The project export dialog now offers a separate **选择资源导出定义** flow. Existing full Workbench backup and whole-project OpenAPI exports remain distinct. The new flow uses the existing owner `export-preview` and `export-selection` contract; it adds no server authority, background network execution, persistent grant or upload destination.

## Human contract

- Selection starts empty and never falls back to the whole project. A selected API/document folder means its entire subtree. Protocol definitions, global configuration and collection registration are indivisible bundles. Deleted resources are not listed.
- Only saved data is eligible. Unsaved drafts are neither saved automatically nor silently ignored: the user must save deliberately and reopen. No PUT, import or execution is performed by the selected export flow.
- Formats are Apipost JSON, the supported Apipost directory **JSON manifest** (not ZIP), and Postman Collection 2.1. Unsupported semantics fail; these are definition interchange formats, not full backups or promises of complete vendor compatibility.
- Postman only allows API/folder selection and does not contain environment/global variable values. Placeholders remain unresolved and independent replay is not promised. Backend warnings are displayed verbatim, HTML-escaped, before confirmation and are compared again on the export result.
- The confirmation lists requested resources, mandatory dependencies and final scope. Consent is unchecked. No assertion of redaction is made: static authentication, URL, headers, scripts, body, examples and variables can contain secrets. Neither resource inventory nor preview displays credential values. A separate unchecked option authorizes the backend's database-rebind projection for native formats only.
- Closing or changing project, draft, input, format or modal invalidates a pending result. Export is bound to the exact preview configuration revision, artifact digest and dependency identities. Withdrawing consent while the final read is pending prevents download.
- Each confirmation can submit the final export once. A lost/error/mismatched result is not automatically retried or downloaded; close and preview again. Download means the browser was asked to save a file, not proof that the person saved it on disk.

## Verification boundary

Tests execute the actual app callbacks, the UI receipt validators and all three real owner HTTP preview/export/import/save/reload paths. Selected credentials deliberately remain in the fixture output, while unrelated secret-bearing requests remain excluded and source state is unchanged. Browser acceptance exercises actual selection, explicit consent, download roundtrip and stale previews. A test's presence or a focused pass is not evidence of a successful browser run; validate the exact candidate CI and retain failed original runs separately.
