# Modern Apipost JSON interchange

Evidence obtained 2026-10-20 without asking the user for a sample:
- https://github.com/Fengfeng788/study-web3/blob/67ab385bb429d0e8e72f97a2dd88c6ef4f88568c/Go/task4/doc/go-blog-apipost.json
- https://github.com/whale-coding/go_demo_exchangeapp/blob/1102043ce4c66b94f411ff67d61a4ec6128ea1d8/docs/Apipost接口文档/exchangeapp.json
- https://github.com/EchoAPI-Team/echoapi-for-vscode/blob/bc8ecb58271ac7a8b0289fad2f0455745b4562f1/src/types/project/export.ts

These are public ecosystem export examples/types, NOT proof of an Offline2 2.0.0 native-directory round trip. Original Offline2 static exporter uses matching top-level global/apis/models/samples/automated_testings shape. Earlier code mislabeled those shared markers as exclusive to Offline2. No original code or third-party sample payload is copied into the repository; tests use independently authored fictional data. External samples are inspected locally for structure only, never executed or sent to their endpoints.

Support complete modern envelopes, HTTP APIs/folders, wrapped parameter arrays, response examples, environment/service matrices, global variables and lifecycle marks. Preserve IDs through namespaced deterministic resource IDs; relative APIs default to declared service1 or the sole service, never guess among multiple services. Keep imported environments separate and do not silently switch the user's active environment. Requests carry a note to choose an imported environment. Nonempty unsupported models/cases/automated tests/custom resources/tasks/attributes fail before mutation, rather than being dropped. Incomplete shared markers retain explicit rejection. Modern exports require full-project import to avoid losing environment dependencies; request-only conversion and MCP sync reject until supported.

Fixed acceptance before implementation: relative path + service/variable construction against real loopback fixture; wrapped headers/query/restful and response examples; namespace collision checks and environment/global conflict atomicity; inheritance and unsupported dependency rejection; no source URL contacted on import; real browser import/selection and project persistence. Public-source read-only probes may add interoperability evidence but are not a substitute for exact native Offline2 validation.

Read-only public-source probe: the pinned go-blog export imports 10 HTTP APIs, 3 folders, 2 environments, 1 service and 4 lifecycle marks. No source endpoint was contacted. The pinned exchangeapp export is rejected because it enables an unsupported Mock IP allowlist, demonstrating that this is not blanket permissive conversion. The source files are not redistributed or executed.

Imported examples retain their schema and body. Original Mock activation and automatic response checking are NOT automatically enabled, and this semantic boundary is displayed in every imported API's notes. This is an explicitly limited interchange adapter, not a lossless native clone.

## Flat model extension

The subsequent increment supports at most 100 complete flat models with model_type=model and root parent_id. Field structure and model-reference normalization are corroborated by the same pinned EchoAPI repository's src/utils/exportutils/apiToSelf.ts; implementation here is independent. Models appear in the existing model library and namespaced OpenAPI components. Recognized direct model IDs and #/definitions/ID or #/components/schemas/ID references are rewritten; model-local pointers are rebased. Remote/missing references, nested model folders and proprietary composite reference/override extensions reject atomically. No schemas or external URLs are fetched. Tests cover sample generation through references, rebasing, conflicts and visible imported model entries. This replaces the initial blanket rejection of models, not the exclusions for cases/tasks/custom composition.
