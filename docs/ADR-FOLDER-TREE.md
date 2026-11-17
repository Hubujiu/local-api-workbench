# Nested folder navigation and atomic subtree operations

Slash-separated folder paths now render as a nested tree with implicit parents. Existing flat names remain visible. Parent counts include descendants. Search opens ancestors and Locate opens every ancestor of the selected request without losing edits.

Rename moves HTTP requests, documents, protocol definitions, explicit folder entries and exact folder parameter/auth/script/service maps together. Delete removes the subtree's folder settings and ungroups its contents, never deletes the contents. Both operations prepare a clone before changing the live project. Destination collisions include implicit parents and configuration-only paths; moving a folder into itself and invalid/overdeep paths fail without mutation. Existing plan and interface-case snapshots are deliberately unchanged.

This change does not enable ancestor credential or script inheritance. Existing exact-path scope behavior is preserved so existing requests do not acquire new headers, credentials or code merely because their sidebar is hierarchical. No native Offline2 format compatibility is implied.

Tests cover recursive representation, prefix isolation, all resource and setting moves, snapshot preservation, deletion, conflicts and invalid paths. Browser coverage exercises nesting, collapsed-parent Locate, parent rename, exact shared setting persistence and real HTTP after a leaf move.
