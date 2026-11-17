# Native graph append evidence

Base: exact PR155 commit `846e62416269157e9b8f16b858a9776bbcdfd8ea`.
Initial RED specification commit: `7021e34`; recoverable test source is
`red-spec.mjs`. Running `node --test tests/native-inheritance-append.test.mjs`
on that checkpoint produced one expected positive-case failure with
`MANUAL_IMPORT_TARGET_UNSUPPORTED` and one passing rejection matrix.
The initial missing-dependency attempt was an environment failure, not RED.
After using the already-installed dependency tree, the behavioral RED was
observed before implementation. No dependency manifest or lockfile changed.

Final local commands:

- `node --test tests/native-inheritance-append.test.mjs`: 8/8 pass.
- `node --test --test-concurrency=2 tests/manual-import-*.test.mjs tests/native-inheritance*.test.mjs tests/native-folder-lifecycle-*.test.mjs`: 190/190 pass.
- `npm run check`: pass.
- `npm run format:check`: whole-repository Prettier check pass.
- `git diff --check`: pass.

Focused tests use fictional values and actual Store persistence, two independent
Store instances, owner HTTP and a loopback peer. Cancellation is injected after
journal-temp write but before publication; uncertain outcome is injected just
after journal rename, then a fresh Store recovers exactly once. Both mutations
are reset in `finally`. Generic save cannot forward the private append context.

The full repository suite and exact remote CI have not been claimed here.
No merge, deployment or proprietary original-runtime comparison was performed.
