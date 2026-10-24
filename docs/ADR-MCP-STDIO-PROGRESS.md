# Cross-process stdio progress

HTTP and stdio MCP execution now feed the same read-only UI activity view. A stdio process writes small atomic runtime records under the shared application data root; only identifiers, PID, times and step counts/status are stored, never raw arguments, request bodies or credentials. The UI continues polling without rerendering or discarding an unsaved editor.

The stdio client must set LOCAL_API_DATA to the application's data root shown in MCP configuration and separately pass the project/write/execute grants. Disabling HTTP MCP does not revoke an independently started stdio process's explicit permissions. No external AI client is started by this feature or its tests.

A two-second heartbeat marks a vanished/stale process interrupted after ten seconds rather than leaving it running forever. Recent completed entries are bounded/pruned; activity state is runtime evidence, not a configuration revision or an assertion that an AI model authored the request.

Fixed validation:
- Journal progress/failed-step/stale-heartbeat behavior and exclusion of unrelated secret/body fields.
- Spawn the actual stdio server against a controlled two-step local HTTP fixture; observe step1/2 through the UI API while step2 is gated.
- Browser observes the real stdio running badge, captures a screenshot, verifies terminal status and preservation of an unsaved request name.
