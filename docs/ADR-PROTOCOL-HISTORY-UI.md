# Saved protocol evidence viewer

The history page lists the current project's saved protocolRuns and opens the complete stored JSON in an escaped, read-only dialog. It never connects, sends, cancels, saves, exports, or reconciles a protocol session. Existing backend retention and receipt rules remain unchanged. A missing record is not evidence of non-execution, local writes/acknowledgements are not remote business success, and stored message bodies are not redacted.

Details resolve stable record identity against the current project; cross-project, missing and ambiguous identity refuse. Reordering cannot select a different record. Records without identity remain visible without a detail action. The list follows stored order rather than assuming transport-time chronology.

Pure rendering tests cover full evidence preservation, mutation absence, unknown receipts, escaping and stale/ambiguous identity. The existing real Socket.IO browser journey now stops/saves the session, opens history, and compares the rendered JSON to the entire persisted record while preserving original network invocation counts. Local Chromium startup is blocked by socket EPERM; exact CI is required for browser acceptance. This does not establish complete product or installer acceptance.
