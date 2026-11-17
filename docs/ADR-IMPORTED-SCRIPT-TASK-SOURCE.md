# Inert provenance for imported request-local script tasks

The modern Apipost adapter accepts request-local `customScript` lists with
explicit numeric states `1` (enabled), `0` and `-1` (disabled). Static inspection
of the original adapter shows that only positive enabled values enter its task
program. Other numeric values and unknown task types remain rejected rather
than guessed. Inherited folder/global task lists and mixed database/wait/task
programs are still outside this conversion.

Only enabled source blocks enter the existing ordered, shared-scope
`beforeScript` or `afterScript` conversion. Disabled blocks can contain incomplete
syntax without being parsed or executed. Import itself never runs any code.
Existing runtime sandbox and shared-stage limits are unchanged.

The request's versioned `importedScriptTasks` field retains the original IDs,
names, numeric states, order and exact source strings for both phases, including
disabled blocks. It is provenance, not a second executable configuration. The
current editable pre/post script fields remain the sole program source. Editing
those fields does not silently rewrite original provenance. This field survives
normalization and native project backup/import; it does not claim export back to
the original vendor's native task format.

A read-only disclosure in the design view makes this distinction visible and
shows the original source without enabling it. Source and names are HTML-escaped;
there are no execution or toggle controls in that view. The same closed-shape
validator runs at import, request normalization and rendering. It rejects
accessors, non-plain/sparse arrays, hidden or unknown properties, invalid states,
more than 16 tasks per phase, more than 64 KiB source per phase and more than
256 KiB serialized provenance. Active and disabled source share the limits.

Validation covers source immutability, native backup normalization, explicit
execution of enabled code only through real HTTP, unparseable disabled code,
readonly escaped presentation and persisted provenance in the real browser
import flow. Existing atomic rejection tests still cover inherited, mixed,
oversized and unknown task semantics. These are interoperability checks, not
full original-project migration or complete SDK compatibility.
