# Explicit saved protocol record export

This increment adds a local JSON download of exactly one saved protocol record after an explicit preview and confirmation. It does not export an active session, provide a backup/import format, reconcile persistence, or connect/replay traffic. Response/message bodies remain unredacted; the warning is part of confirmation. Local evidence is not proof of remote business success.

Stable current-project and unique record identity are checked at preview and at confirmation. The complete serialized record must still match the preview. Changed, removed, ambiguous, or foreign records reject rather than silently exporting new data. Successful confirmation returns an independent JSON copy, not a reference into project state. A fixed filename avoids treating record identity as a path.

No backend, permission, storage or budget changes. Runtime credentials excluded by existing persistence contracts remain excluded; this export does not sanitize already-saved evidence.

Validation: 65 focused controller/model/actual app adapter tests pass. Real Socket.IO browser fixture includes explicit stop/save/reload, preview cancel without download, re-open and confirm exactly one download, byte-parsed record equality and unchanged network counts. Local Chromium fails before page entry with socket EPERM; real browser and full CI remain pending.
