# Bounded multiple field templates

Base: PR173 exact head `8017694ac244b5253e34ed35f2c1aa8bae16ae07`.

- `focused.txt`: 12 tests, real HTTP Header/urlencoded/multipart/plain/JSON, stage order, repeated items, inserted markers, JS dollar substitutions, custom/Query rejection, getter isolation, expiry, budgets, editor preservation, frozen plan, backup and Store restart.
- `clock-and-context.txt`: 54 tests, native templates plus dynamic metadata/schema context and real civil-clock rollback / monotonic five-second limits. This run preceded the additional editor test; the focused run includes it.
- `regression.txt`: final full Apipost test family, dynamic editor, script final-body and GraphQL isolation tests.

Early regression runs found two obsolete negative assertions that rejected the now-supported pair of builtin expressions. Those were changed to reject a builtin/custom-function mixture instead, retaining atomic rollback checks; new positive workflow tests cover the newly supported case. No production error was hidden by changing expected wire output. The directory negative's final isolated rerun passed 7/7 before the full final rerun.

Official source was inspected statically only; the ADR records version, archive and bundle hashes. No original application code was executed or copied into the product/tests. Tests are independently authored and are not original GUI parity evidence.

Commands:

```
node --test --test-concurrency=2 tests/apipost-multiple-fields.test.mjs tests/apipost-multiple-field-workflow.test.mjs
node --test --test-concurrency=2 tests/apipost*template*.test.mjs tests/apipost-multiple-fields.test.mjs tests/dynamic-values.test.mjs tests/dynamic-definition-metadata.test.mjs tests/parameter-schema-source.test.mjs tests/execution-clock*.test.mjs
node --test --test-concurrency=2 tests/apipost*.test.mjs tests/dynamic-editor.test.mjs tests/script-final-body*.test.mjs tests/graphql-variable-template.test.mjs tests/postman-graphql-variable-workflow.test.mjs
npm run check
npm run format:check
git diff --check
```
