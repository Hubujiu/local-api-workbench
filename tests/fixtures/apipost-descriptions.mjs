// Independently authored from observed field shapes, not an original-app export.
export function catalogueDocument(url) {
  return {
    project_id: "description-source",
    name: "Synthetic catalogue source",
    intro: "",
    global: {
      envs: [],
      servers: [],
      global_vars: {},
      global_param: {},
      codes: [],
      marks: [],
      attributes: [],
      mock_custom_rules: [],
      db_link: [],
      custom_func: [],
      describe_library: [
        {
          id: "old-description",
          project_id: "description-source",
          key: "account_id",
          description: '账户 <tag> "quoted" \\ path\nsecond line',
        },
        { key: "Account_ID", description: "" },
        { key: "empty" },
        { key: "\ud800", description: "first surrogate" },
        { key: "\ud801", description: "second surrogate" },
      ],
    },
    apis: [
      {
        target_id: "untouched-api",
        target_type: "api",
        parent_id: "0",
        name: "Never execute during conversion",
        method: "GET",
        url,
        protocol: "http/1.1",
        request: {
          auth: { type: "noauth" },
          header: { parameter: [] },
          query: { parameter: [] },
          cookie: { parameter: [] },
          body: { mode: "none" },
          pre_tasks: [],
          post_tasks: [],
        },
      },
    ],
    samples: [],
    models: [],
    automated_testings: [],
  };
}

export function emittedCatalogue(document, format) {
  if (format === "apipost")
    return {
      projectId: document.project_id,
      rows: document.global.describe_library,
    };
  const files = new Map(document.files.map((file) => [file.path, file.text]));
  return {
    projectId: JSON.parse(files.get("project.json")).project_id,
    rows: JSON.parse(files.get("settings/desc_list.json")),
  };
}
