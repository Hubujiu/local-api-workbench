# Workbench-only Digest credential overrides

The standalone [execution-plan documentation](https://offline.apipost.net/help/executions/)
describes independent authentication for repeated instances of an API. It does not
publish a Digest override schema. We therefore do not label the following input
as Apipost's native format.

For a saved request whose existing authentication type is `digest`, the
`apipost_create_execution_flow`, `apipost_update_execution_flow`, and
`apipost_execute_api` compatibility entrypoints accept this explicit Workbench
extension in `input`:

```json
{
  "auth": {
    "type": "workbench_digest",
    "workbench_digest": {
      "username": "{{fixture_user}}",
      "password": "{{fixture_password}}"
    }
  }
}
```

Only already-defined username/password fields can be overridden. Values must
match the canonical field types; omitted fields retain the saved base value.
An explicit `type: "workbench_digest"` is required. `type: "digest"` is not a
new upstream alias. Basic/Bearer/API-key behavior is unchanged. Different auth
types, nonce, realm, algorithm, challenge policy, and unknown keys are rejected.
The canonical `applyMCPInput` validation and existing Digest execution own all
subsequent behavior, including challenge validation and bounded retry. This
change neither permits new target hosts nor changes write/execute/project grants.

Plan overrides are saved in the plan snapshot and returned by plan/evidence
reads, just as existing overrides are. They are not an ephemeral credential
vault. Prefer variable references for secrets; use only synthetic credentials in
fixtures. Updating the original API does not rewrite a saved step's credentials.
A failed step continues to the next step under the existing linear plan policy.

`tests/workbench-digest-step-overrides.test.mjs` uses only a local HTTP challenge
server and synthetic credentials. It checks two repeated steps with independent
credentials through create, partial update, source edit, new Store initialization,
execution and persisted evidence. The peer independently verifies the received
Digest response. It also checks strict extension input, unchanged challenge
policy, source isolation, project denial and execution denial. Existing SDK
workflow and Digest regression suites remain applicable; this is not an upstream
interoperability or external-client acceptance claim.
