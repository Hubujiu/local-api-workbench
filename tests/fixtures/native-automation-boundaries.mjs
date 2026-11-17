// Original synthetic mutations, not vendor exports or an execution oracle.
// Rejection is the only expected behavior until the linked semantic evidence
// gates close. In particular array order/sort/parent values define NO schedule.
export function nativeAutomationBoundaryCases() {
  return [
    ["observed root structure", () => {}],
    [
      "sort conflict (semantics deliberately unknown)",
      (source) => {
        source.automated_testings[0].event_list[1].sort = 1;
      },
    ],
    [
      "array order disagrees with sort",
      (source) => {
        source.automated_testings[0].event_list.reverse();
      },
    ],
    [
      "missing sort (no inferred default)",
      (source) => {
        delete source.automated_testings[0].event_list[0].sort;
      },
    ],
    [
      "missing parent (no automatic root promotion)",
      (source) => {
        source.automated_testings[0].event_list[0].parent_event_id =
          "synthetic-absent-parent";
      },
    ],
    [
      "cyclic parents (no guessed graph repair)",
      (source) => {
        const events = source.automated_testings[0].event_list;
        events[0].parent_event_id = events[1].event_id;
        events[1].parent_event_id = events[0].event_id;
      },
    ],
    [
      "unresolved live API (no arbitrary dependency selection)",
      (source) => {
        source.automated_testings[0].event_list[0].data.target_id =
          "synthetic-absent-api";
      },
    ],
    [
      "live reference plus differing snapshot (no inferred priority)",
      (source) => {
        source.automated_testings[0].event_list[0].data.apiData = {
          target_id: "synthetic-other-snapshot",
          url: "http://127.0.0.1:1/never-run-snapshot",
          method: "POST",
        };
      },
    ],
    [
      "unknown schedule (never inferred)",
      (source) => {
        source.automated_testings[0].scenario = "synthetic-unknown-schedule";
      },
    ],
    [
      "changed saved settings (not runner option evidence)",
      (source) => {
        const settings = source.automated_testings[0].settings;
        settings.execute_count = 2;
        settings.ignore_error = 0;
        settings.enable_sandbox = 1;
      },
    ],
    [
      "disabled nonempty events (never silently discarded)",
      (source) => {
        for (const event of source.automated_testings[0].event_list)
          event.enabled = 0;
      },
    ],
  ];
}
