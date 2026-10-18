# Limited Apipost public-JSON compatibility

Supports the public swagger2apipost output shape {project,apis,env,dataModel}, including its {status:"success",data:...} wrapper. It does not claim byte-compatible loading of the current proprietary Offline2.0 project directory or every historical export.

Imported: nested/flat API folders (including empty folders), HTTP methods/URLs, Header/Query/Path/Cookie rows, enabled/required/type/description metadata, raw/form bodies, Basic/Bearer credentials, response examples and schemas. Referenced local file paths are never read; users must reselect them.

A scheme-less hostname is prefixed with HTTPS and receives a persisted import note visible in the design page. Relative URLs without resolved environment context are rejected. Nonempty environment/data-model dependencies, inherited global/folder parameters and scripts are rejected instead of silently dropped or executed. Unsupported resource/auth/body types also fail explicitly.

The primary fixture is an actual output from the official converter against a synthetic input. No legacy converter/runtime dependency is added to the application. The reference old runtime was inspected, not executed.

Sources:
- https://www.npmjs.com/package/swagger2apipost
- https://www.npmjs.com/package/apipost-runtime
- tests/fixtures/APIPOST-FIXTURE.md
