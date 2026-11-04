// Synthetic native fields; not a capture from the original application.
export function attributeDocument(
  url = "http://127.0.0.1:1/must-not-send",
  source = "attribute-source",
) {
  const types = [1, 2, 3, 4, 5, 6, 7, 1, 2];
  const attributes = types.map((type, index) => ({
    attribute_id: "field-" + index,
    project_id: source,
    field_name: index < 2 ? "Same label" : "Field " + index,
    field_type: type,
    enable: index >= 7 ? -1 : 1,
    tooltip: 'Help <tag> "quoted" 界',
    sort: index,
    extra: [3, 4].includes(type)
      ? [
          { key: "b", value: "Beta" },
          { key: "a", value: "Alpha" },
        ]
      : [],
    open_api_field: "",
  }));
  const values = [
    "<text> 界",
    0,
    "a",
    ["b", "a"],
    "2026-11-03",
    "https://example.test/path",
    "owner@example.test",
    "hidden",
  ];
  const api = (id, info) => ({
    target_id: id,
    target_type: "api",
    parent_id: "0",
    name: id,
    method: "GET",
    url,
    protocol: "http/1.1",
    attribute_info: info,
    request: {
      auth: { type: "noauth" },
      header: { parameter: [] },
      query: { parameter: [] },
      cookie: { parameter: [] },
      body: { mode: "none" },
      pre_tasks: [],
      post_tasks: [],
    },
  });
  return {
    project_id: source,
    name: "Synthetic attributes",
    intro: "",
    global: {
      envs: [],
      servers: [],
      global_vars: {},
      global_param: {},
      describe_library: [],
      marks: [],
      attributes,
      mock_custom_rules: [],
      db_link: [],
      custom_func: [],
      codes: [],
    },
    apis: [
      api(
        "first",
        Object.fromEntries(values.map((value, i) => ["field-" + i, value])),
      ),
      api("second", { "field-0": "", "field-1": null, "field-3": [] }),
    ],
    samples: [],
    models: [],
    automated_testings: [],
  };
}
export const blankAttributeProject = (id) => ({
  version: 1,
  id,
  name: id,
  requests: [],
  environments: [{ id: "default", name: "Default", variables: {} }],
  plans: [],
  cases: [],
  protocols: [],
  runs: [],
  protocolRuns: [],
  history: [],
  dictionary: [],
  parameterDictionary: [],
  documents: [],
  settings: {},
});
export function attributeSemantics(project) {
  const fields = project.settings.attributes;
  return {
    fields: fields.map(({ key, apipostSource, ...field }) => field),
    values: project.requests
      .filter((r) => !r.deletedAt)
      .map((r) =>
        fields.map((f) =>
          Object.hasOwn(r.attributes, f.key)
            ? { value: r.attributes[f.key] }
            : {},
        ),
      ),
  };
}
export function emittedAttributes(output, format) {
  if (format === "apipost")
    return {
      projectId: output.project_id,
      fields: output.global.attributes,
      apis: output.apis.filter((a) => a.target_type === "api"),
    };
  const files = new Map(output.files.map((f) => [f.path, JSON.parse(f.text)]));
  return {
    projectId: files.get("project.json").project_id,
    fields: files.get("settings/custom_attrs.json"),
    apis: [...files]
      .filter(
        ([path]) => path.startsWith("apis/") && path !== "apis/index.json",
      )
      .map(([, entry]) => entry.data)
      .filter((a) => a.target_type === "api"),
  };
}
