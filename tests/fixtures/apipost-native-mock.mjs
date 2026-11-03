// Independently authored fixture, not a vendor export.
import { modernApipostFixture } from "./apipost-modern.mjs";
import { nativeDirectoryFixture } from "./apipost-directory.mjs";
export function nativeMockFixture() {
  const doc = modernApipostFixture(),
    api = doc.apis[1];
  api.response.example = [
    ["1", 200, "fallback"],
    ["2", 404, "matched"],
  ].map(([example_id, status, kind]) => ({
    example_id,
    expect: {
      code: String(status),
      content_type: "json",
      is_default: example_id === "1" ? 1 : -1,
      mock: "",
      name: kind,
      verify_type: "schema",
      schema: {
        type: "object",
        properties: { kind: { type: "string", const: kind } },
      },
    },
    headers: [
      {
        key: "x-native-rule",
        value: kind,
        is_checked: 1,
        field_type: "string",
        not_null: 1,
        param_id: "header",
        description: "",
        schema: { type: "string" },
      },
    ],
    raw: "not-the-schema-result",
    raw_parameter: [],
  }));
  const config = {
    project_id: doc.project_id,
    target_id: api.target_id,
    mock_server_enable: 1,
    mock_ip_white_list_enable: -1,
    mock_ip_white_list: "",
    mock_show_target_id: 0,
    ai_expect: {
      list: [
        {
          id: "rule",
          desc: "query condition",
          enable: 1,
          expect_id: "2",
          conditions: [
            {
              conditionId: "mode",
              location: "query",
              name: "mode",
              compareType: "eq",
              value: "fail",
            },
            {
              conditionId: "placeholder",
              location: "",
              name: "",
              compareType: "",
              value: "",
            },
          ],
        },
      ],
      none_math_expect_id: "1",
      none_math_example: null,
    },
  };
  const directory = nativeDirectoryFixture(doc);
  directory.files.push({
    path: "settings/mock_api.json",
    text: JSON.stringify(config),
  });
  return { doc, config, directory };
}
