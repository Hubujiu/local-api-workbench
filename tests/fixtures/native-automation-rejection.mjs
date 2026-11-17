import { modernApipostFixture } from "./apipost-modern.mjs";

// Independently authored synthetic rejection fixture, NOT a vendor export or
// executable compatibility contract. Only structural facts from the saved
// research are represented; every identity, address and value is fictional.
export function nativeAutomationRejectionFixture(endpoint) {
  const source = modernApipostFixture();
  source.name = "Synthetic unsupported automation";
  source.global.envs[0].server_list[0].uri = endpoint;
  const api = source.apis[1];
  source.apis = [
    source.apis[0],
    ...Array.from({ length: 7 }, (_, i) => ({
      ...structuredClone(api),
      target_id: `synthetic-api-${i + 1}`,
      name: `Synthetic API ${i + 1}`,
      url: `${endpoint}/must-not-run/${i + 1}`,
    })),
  ];
  source.automated_testings = [
    {
      testing_id: "synthetic-testing",
      project_id: source.project_id,
      name: "Unsupported, never execute",
      scenario: "manual",
      // Synthetic nonempty value, NOT a claim about the vendor frequency grammar.
      frequency: "synthetic-unknown-frequency",
      settings: {
        env_id: "1",
        iterates_data_id: "synthetic-data",
        execute_count: 1,
        interval_time: 0,
        ignore_error: 1,
        enable_sandbox: -1,
      },
      references_target_ids: source.apis.slice(1).map((a) => a.target_id),
      event_list: source.apis.slice(1).map((a, i) => ({
        event_id: `synthetic-event-${i + 1}`,
        test_id: "synthetic-testing",
        project_id: source.project_id,
        parent_event_id: "0",
        sort: i + 1,
        enabled: 1,
        type: "api",
        auto_sync: true,
        data: {
          target_id: a.target_id,
          origin_target_id: a.target_id,
          parent_id: a.parent_id,
          apiData: null,
        },
      })),
    },
  ];
  return source;
}
