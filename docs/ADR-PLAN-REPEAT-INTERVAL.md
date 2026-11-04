# Bounded repeat interval

A canonical Workbench `repeat` group may specify an integer `intervalMs` from 0 through 10000. This is a Workbench execution contract, not a claim about native application's interval units or timing. Omission preserves existing snapshot shape and behavior. Zero performs no wait.

The executor waits between iterations, not before the first or after the last iteration. A false conditional inside the repeat still counts as an iteration; a false conditional enclosing the repeat skips its waits. Disabled groups and children do not execute. Nested waits follow their own group boundaries. Waits are internal control events: they do not count as requests, emit step results or change occurrence identities.

The entire graph is validated before side effects. The worst-case aggregate wait is at most 60000 ms, calculated with nested iteration multipliers, including disabled and potentially false branches. A pending wait is interruptible by the execution signal. Cancellation keeps completed step evidence and starts no later step; ordinary stop policies and existing mandatory stops take precedence over a later wait.

The interval is saved in the frozen plan and history. Existing graph limits, credentials, execution scopes and staged-load duration bounds still apply. Native import/export does not gain support for this Workbench-only field.
