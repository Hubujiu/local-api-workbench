# Loaded protocol history filtering

The history page filters only the current project's already loaded protocol evidence. Protocol type, recorded status (or explicitly labeled session state), and a case-insensitive literal substring of the complete JSON record combine with AND. The input is limited to 200 characters in the UI. No regex, backend query, connection, replay, save, or export is initiated by filtering.

A visible count and empty state distinguish hidden records from absent evidence. Leaving or reloading the page resets filters. No evidence or uncertain result is removed. Current-project checks reject a detached foreign view. Details and export still resolve the unique stable record identity against the current project, not the filtered position; export retains its separate confirmation and unchanged-record check.

Content is not redacted. Searching raw records is local only. Session state and local receipts do not imply remote business success. Missing or filtered-out records do not prove non-execution.
