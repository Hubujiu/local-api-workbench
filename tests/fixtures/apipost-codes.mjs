// Independently authored from observed field shapes, not an original-app export.
export function catalogueDocument(url) {
  return {
    project_id: "code-source",
    name: "Synthetic catalogue source",
    intro: "",
    global: {
      envs: [],
      servers: [],
      global_vars: {},
      global_param: {},
      describe_library: [],
      marks: [],
      attributes: [],
      mock_custom_rules: [],
      db_link: [],
      custom_func: [],
      codes: [
        {
          code_id: "old-code",
          project_id: "code-source",
          code_number: "0007",
          code_msg: '业务 <tag> "quoted" \\ path\nsecond line',
        },
        { code_number: 409, code_msg: "numeric conflict" },
        { code_number: "ERR", code_msg: "Uppercase" },
        { code_number: "err", code_msg: "Lowercase" },
        { code_number: 0, code_msg: "Zero" },
        { code_number: -1, code_msg: "Negative business code" },
        { code_number: "\ud800", code_msg: "first surrogate" },
        { code_number: "\ud801", code_msg: "second surrogate" },
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
      rows: document.global.codes,
    };
  const files = new Map(document.files.map((file) => [file.path, file.text]));
  return {
    projectId: JSON.parse(files.get("project.json")).project_id,
    rows: JSON.parse(files.get("settings/code_list.json")),
  };
}
