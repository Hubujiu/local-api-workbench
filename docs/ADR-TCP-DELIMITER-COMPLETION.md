# Bounded TCP delimiter response completion

Status: backend implementation and full workflow specifications; ordinary CI
acceptance is pending. The first staged checkpoint froze this contract and added
only the pure matcher; later checkpoints below connect the runtime and evidence.

## Source and dependency boundary

The [official Apipost TCP client page](https://wiki.apipost.cn/docs/tcp/client/)
links its client-settings screenshot showing binary response termination by a
hexadecimal tail marker, with `0a` as the example. This proves the user capability,
not the private `end_func` storage representation or precise original framing
implementation. [TCP is a byte stream](https://www.rfc-editor.org/rfc/rfc9293.html#section-2.2),
so a data callback is not an application-message boundary.

Continue PR12 on its existing base: local
`5b28eb30882f1f1421416dfa2f87e1608412e1d2`, remote
`19731690bafa368fbb5237799f5baab4e6792bdc`, identical tree
`6bad9952bdd2f2ef648723de7f196579e300e431`. No root ancestry, new dependency,
frontend, engine or licensing requirement is introduced. The old default/end and
first-data semantics, definition shapes and hashes remain unchanged.

## Canonical contract

- Only explicit `completion: "delimiter"` opts in. `delimiterHex` is required,
  1–64 complete hexadecimal bytes, no whitespace/prefix/coercion, normalized to
  lowercase. A delimiter field outside this mode or on another protocol rejects.
  It is literal data, never an expression, template, function or file reference.
- Incremental byte matching ends on the first complete marker, including across
  arbitrary chunk boundaries and overlapping prefixes. Response `body/base64/size`
  represent the first frame **including** the marker. Any extra bytes already read
  in that same chunk are retained separately as `framing.trailingBase64` and
  `framing.trailingSize`; `framing.matched` identifies whether a marker completed.
  These are observed extra bytes, not a claim about unread peer data. No second
  response is parsed, no connection is reused, and no message is replayed.
- The unchanged 1 MiB receive cap counts the frame plus all already-read trailing
  bytes before accepting the chunk. Saved/request deadlines stay 100–30000 ms.
  EOF or deadline without a full marker returns truthful `partial: true`, including
  an empty response; `timedOut` distinguishes the deadline. This cannot pass the
  default completed expectation in a plan. Cancellation/transport errors retain
  their existing error contract, not a new promise of crash-durable partial bytes.
- Saved definitions and frozen plans retain the rule and hash it. Invocation
  cannot override a saved delimiter or completion mode. New-mode result validation
  must check first-marker position, exact frame/trailing sizes and combined cap,
  partial/timedOut/matched consistency, and the original definition. Legacy
  definitions/results receive no invented fields or rehashing.
- Full project backup/restore retains the rule and evidence. Unsupported native
  export must reject rather than erase it; native `end_func` mapping remains
  closed. This old feature base does not contain later native exporters, so their
  actual entrypoint regression is a root-composition gate, not an imported
  dependency. Interactive multi-send sessions reject the new finite-response
  mode before opening; their existing capture semantics remain unchanged.

## Acceptance and limits

Pure tests cover normalization, every marker split, repeated-prefix matching,
binary/Unicode bytes, trailing-byte retention, incomplete/empty states, defensive
copies and unchanged capacity. They import no application/VM/database/transport.

Ordinary CI must cover real fragmented/coalesced TCP through owner save/run,
frozen plans after live edits, official HTTP/stdio SDK and CLI, precise evidence,
project isolation, backup and real restart. Missing markers, EOF, deadline,
cancellation before the next step, invalid input/no connections, saved-rule
override rejection and storage failure/no replay are required. Prior end/first-data
flows remain regression gates. No local application/VM/XML/database or network
workflow execution, test skipping, budget change or manual CI rerun is authorized.
The historical root script-final-body timeout remains unresolved and unrelated.

## Runtime wiring checkpoint (WIP, workflows pending)

The shared options, one-shot TCP transport and persisted-result validation are now
connected. Saved-rule overrides and direct/saved interactive-session attempts are
rejected before opening. Only the new mode changes empty deadline/EOF behavior to
an explicit incomplete result; old branches retain their existing errors/shapes.
The matcher has one fixed private 1 MiB buffer, not an unbounded list of empty or
single-byte chunks. All observed tail bytes count toward that same receive budget.
Eight inspected pure matcher/options/evidence tests pass; application workflows
remain unexecuted locally and must be added/validated by normal CI. The independent
review caught a missing initial interactive guard while wiring; it was added before
this checkpoint rather than claiming the intended patch had already applied.

## Complete ordinary workflow specifications (CI pending)

Two official HTTP/stdio SDK chains now specify owner persistence, invalid saves
and saved-rule overrides with unchanged bytes, direct/saved interactive rejection,
a real split-marker exchange, and frozen TCP extraction into a real HTTP consumer.
They then edit the live endpoint/rule, execute the old frozen definition, restore
and truly restart, read exact historical evidence with scoped SDK grants, and run
the restored saved plan through the actual CLI. A self-consistent rehashed but
semantically false framing record must still fail restore atomically. An injected
record-append rejection retains the actual completed TCP result and unsaved receipt
without a second send. It tests this feature's existing receipt contract, not root's
typed journal uncertainty. A third whole workflow covers EOF/deadline with partial
or empty bytes, default-plan failure for an incomplete frame, explicit in-flight
cancellation before a subsequent HTTP step, legacy completion controls and inert
backup/restart of the resulting evidence.

The real peer's write boundary is deliberately not equated with a TCP data event:
observed trailing bytes must match the sent tail prefix, while all arbitrary chunk
partitions and exact same-chunk tail retention are locked by the pure matcher.
These workflow specifications have only passed syntax/format checks locally. No
application or network fixture was run; ordinary CI is still the acceptance gate.
Root-only native exporters and typed journal-recovery composition remain separate
checks because they are absent from the original PR12 dependency base.
