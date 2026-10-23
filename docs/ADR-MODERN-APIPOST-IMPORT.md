# Modern Apipost JSON interchange

Evidence obtained 2026-10-20 without asking the user for a sample:
- https://github.com/Fengfeng788/study-web3/blob/67ab385bb429d0e8e72f97a2dd88c6ef4f88568c/Go/task4/doc/go-blog-apipost.json
- https://github.com/whale-coding/go_demo_exchangeapp/blob/1102043ce4c66b94f411ff67d61a4ec6128ea1d8/docs/Apipost接口文档/exchangeapp.json
- https://github.com/EchoAPI-Team/echoapi-for-vscode/blob/bc8ecb58271ac7a8b0289fad2f0455745b4562f1/src/types/project/export.ts

These are public ecosystem export examples/types, NOT proof of an Offline2 2.0.0 native-directory round trip. Original Offline2 static exporter uses matching top-level global/apis/models/samples/automated_testings shape. Earlier code mislabeled those shared markers as exclusive to Offline2. No original code or third-party sample payload is copied into the repository; tests use independently authored fictional data. External samples are inspected locally for structure only, never executed or sent to their endpoints.

Support complete modern envelopes, HTTP APIs/folders, wrapped parameter arrays, response examples, environment/service matrices, global variables and lifecycle marks. Preserve IDs through namespaced deterministic resource IDs; relative APIs default to declared service1 or the sole service, never guess among multiple services. Keep imported environments separate and do not silently switch the user's active environment. Requests carry a note to choose an imported environment. Nonempty unsupported models/cases/automated tests/custom resources/tasks/attributes fail before mutation, rather than being dropped. Incomplete shared markers retain explicit rejection. Modern exports require full-project import to avoid losing environment dependencies; request-only conversion and MCP sync reject until supported.

Fixed acceptance before implementation: relative path + service/variable construction against real loopback fixture; wrapped headers/query/restful and response examples; namespace collision checks and environment/global conflict atomicity; inheritance and unsupported dependency rejection; no source URL contacted on import; real browser import/selection and project persistence. Public-source read-only probes may add interoperability evidence but are not a substitute for exact native Offline2 validation.

Read-only public-source probe: the pinned go-blog export imports 10 HTTP APIs, 3 folders, 2 environments, 1 service and 4 lifecycle marks. No source endpoint was contacted. Correction: the earlier exchangeapp rejection was misdiagnosed. Its numeric
mock_ip_white_list_enable values are -1, meaning disabled, not enabled. The
importer's JavaScript truthiness check incorrectly rejected that state. A later
fix accepts this explicit disabled sentinel; enabled/unknown truthy values
still reject atomically. This correction alone is not a claim that the complete
export imports or that its other dependencies are supported. The source files are not redistributed or executed.

Imported examples retain their schema and body. Original Mock activation and automatic response checking are NOT automatically enabled, and this semantic boundary is displayed in every imported API's notes. This is an explicitly limited interchange adapter, not a lossless native clone.

## Flat model extension

The subsequent increment supports at most 100 complete flat models with model_type=model and root parent_id. Field structure and model-reference normalization are corroborated by the same pinned EchoAPI repository's src/utils/exportutils/apiToSelf.ts; implementation here is independent. Models appear in the existing model library and namespaced OpenAPI components. Recognized direct model IDs and #/definitions/ID or #/components/schemas/ID references are rewritten; model-local pointers are rebased. Remote/missing references, nested model folders and proprietary composite reference/override extensions reject atomically. No schemas or external URLs are fetched. Tests cover sample generation through references, rebasing, conflicts and visible imported model entries. This replaces the initial blanket rejection of models, not the exclusions for cases/tasks/custom composition.

## Schema 位置与字面数据的区别

模型转换只在 JSON Schema 的已知子 Schema 位置重写引用：properties / patternProperties / definitions / $defs / dependentSchemas 的值、组合数组、items / prefixItems、条件与附加属性等。旧版 dependencies 的字符串数组保持原样，Schema 分支才递归转换。

example / examples / default / const / enum 以及未知扩展中的对象属于字面数据，不能把其中的 `$ref`、`ref` 或 APIPOST_REFS 当作模型引用；属性名本身也可以叫 `$ref`。这些数据仍进行有界深拷贝，计入原有 50000 节点与 40 层限制。真实 Schema 位置中的远程引用和不支持的自定义组合仍拒绝，不联网解析。

依据：https://json-schema.org/understanding-json-schema/reference/annotations 和 https://json-schema.org/understanding-json-schema/structuring 。这是修正导入数据保真，不意味着已实现完整 Schema 求解或任意扩展词汇。独立回归先在旧实现出现两个失败，再验证修复；另有完整项目导入到样例生成的端到端断言。原生 Offline2 项目格式仍不包含在此兼容声明内。

同一已知 Schema 位置表也用于可视化编辑器的本地引用保护。字面 example/default/enum/未知扩展中的 `$ref` 不再误阻止字段改名或删除；实际 `$defs`、组合、条件和依赖中的引用仍阻止产生悬空引用。编辑器与导入器共享位置表，原节点/深度限制保留。新增单元回归先失败，浏览器另验证含引用形状扩展数据的字段改名往返及数据不变。


## Explicit empty response examples

A modern response.example entry with raw:"" is an explicit empty example, not
an absent payload. The bridge previously reused the legacy placeholder filter
and silently dropped it. Preserve explicit empty strings for modern imports,
retain whitespace exactly, and keep absent raw fields as definitions only.
Legacy response sections retain their existing definition-only empty-string
interpretation; the adapter opts in internally without changing legacy imports.

The pinned ecosystem BaseResponseExample type in src/types/apis/response.ts
represents raw as a string. This change preserves the provided interchange
payload; it is not new evidence of a native Offline2 round trip. Red regression
captures the lost 204 example; import -> Mock selection -> OpenAPI reimport
preserves empty/whitespace bodies and does not mutate source input. Browser
coverage inspects the imported empty example's name, status and blank editor.


## Disabled Mock IP allowlist sentinel

Static original Offline2 work.asar evidence: 4887.8e0ecb4ad32e.js writes 1 when
the toggle is checked and -1 when unchecked; 5919.ae45ed6901e7.js and
index-0d1d8198fa5a.js initialize the flag to -1. The pinned public exchangeapp
export uses -1 on nine API records. No original application code was executed.
The previous truthiness test mistook that disabled sentinel for active access
control. Accept numeric -1 without enabling Mock or changing network policy;
retain rejection of 1, true, string "-1" and other unknown truthy states. Existing
absent/falsy handling is unchanged. Red/green regressions verify import and
atomic rejection; browser import exercises the same disabled state.

After the fix, a read-only import probe of that exact pinned exchangeapp export
succeeded with 9 HTTP APIs, 0 folders and 2 environments. No imported endpoint
was contacted and no imported script was executed. The source payload is not
redistributed; automated regression uses the fictional fixture. This supports
that specific interchange import only, not original-app execution or native
project-directory parity.


The original query-equals toggle also uses 1/-1 (work.asar
3201.883b408594fa.js). Until flag-only structured query serialization is
implemented, query_add_equal=-1 with an empty value must reject atomically
rather than silently send flag= instead of flag. Keep the previously recognized
0 sentinel, but do not confuse the legitimate nonempty textual values of 0 and
false with an empty parameter. Nonempty values retain their existing import
behaviour. This is a data-loss guard, not a claim that omit-equals is supported.


## Duplicate parameters within inheritance layers

The previous flattening Map silently retained only the last row of each name,
including when that last row was disabled. Preserve all rows and their ordering
within a layer. A child layer replaces the entire parent name group; unrelated
parent rows remain before child rows, matching the workbench's existing shared
parameter contract. Header names compare case-insensitively; Query/Cookie names
remain case-sensitive. Disabled child rows remain stored and still mask that
parent group, but are excluded from wire transmission. This is the documented
interchange flattening rule, not proof of every original inheritance behaviour.

Red regression demonstrates two active header values being lost behind one
disabled duplicate. End-to-end import/interpolation/HTTP verifies both active
headers and duplicate query values survive with unchanged source input; browser
import also verifies the constructed duplicate header values. Combined row
limits still apply through the existing legacy parameter conversion.


Modern RequestBodyContentType in the pinned ecosystem src/types/apis/request.ts
includes plain, whereas the legacy adapter calls the same text/plain form text.
Map the modern spelling to the existing text import path rather than reject a
nonempty plain-text request. Preserve literal bytes and existing explicit
Content-Type precedence. The existing empty-body and JSON rules are unchanged;
this alias does not imply support for every binary or native body representation.
A red regression followed by real HTTP checks text bytes and text/plain, and the
browser modern import exercises the plain body as a POST request.
