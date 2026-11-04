# Live HTTP references in canonical plans

A canonical HTTP plan step may opt in to a project-local `liveRequestId` alongside its saved request task template. Steps without it retain their existing frozen semantics. The field is a nonempty bounded ID, not a URL or cross-project lookup. This is a workbench contract, not a claim about the source application's synchronization timing.

After invocation input and authorization are ready, execution reads a consistent project snapshot. All referenced requests, including those in disabled or conditional branches, are validated and frozen before the first task or network action. Missing, deleted, ambiguous or unsupported references fail the run; the saved template is never a fallback. During a run, including an entire staged load, later edits do not change the frozen request. A subsequent invocation takes a new snapshot. Environment and runtime variables continue to follow existing scope rules.

The current API supplies request configuration and inherited service/auth/parameter settings. The plan step retains its own scripts, assertions, extraction and native task definitions; API-page scripts are not imported into the plan. Postman collection scope and dynamic processing functions are not supported for a live reference and fail explicitly. Existing authorization, credential preflight and execution limits remain in force.

Execution history records the frozen snapshot and its usual hash; `liveBindings` records step and request IDs separately. No reference is resolved when reading history or restoring a backup. Complete project restore preserves request IDs within the new project; selective import treats live references as typed API dependencies and must remap them with the target API. Native flow and directory adapters reject this canonical-only feature rather than silently exporting a frozen approximation.

This first version is backend only. It does not implement native automated-testing import, live references to non-HTTP resources, or direct row-data template interpolation.

As with existing frozen HTTP plans, ordinary request authentication and headers can appear in full execution evidence and snapshots. These records are not a general-purpose secret redaction boundary; access to them must follow the existing project and evidence permissions. Temporary protocol credentials and database grants continue to use their separate existing rules.
