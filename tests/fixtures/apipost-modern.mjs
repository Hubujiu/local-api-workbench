// Independently authored fictional fixture, not a vendor export.
export const modernApipostFixture = () => ({
  project_id: "fixture",
  name: "Fictional modern export",
  intro: "test",
  global: {
    envs: [
      {
        env_id: "1",
        name: "Imported",
        server_list: [{ server_id: "1", uri: "http://127.0.0.1:1" }],
        env_var_list: { id: { value: "42", current_value: "43" } },
      },
    ],
    servers: [{ server_id: "1", name: "Service" }],
    global_vars: { shared: { value: "global", current_value: "current" } },
    global_param: {
      auth: { type: "noauth" },
      header: { parameter: [] },
      query: { parameter: [] },
      body: { parameter: [] },
      cookie: { parameter: [] },
      pre_tasks: [],
      post_tasks: [],
    },
    marks: [{ mark_id: "1", name: "Ready", color: "#26CEA4" }],
    codes: [],
    attributes: [],
    mock_custom_rules: [],
    db_link: [],
    describe_library: [],
    custom_func: [],
  },
  models: [],
  samples: [],
  automated_testings: [],
  apis: [
    {
      target_id: "folder",
      target_type: "folder",
      name: "Group",
      parent_id: "0",
      request: { auth: { type: "inherit" } },
    },
    {
      target_id: "api",
      target_type: "api",
      name: "Request",
      parent_id: "folder",
      method: "GET",
      url: "/items/{{id}}",
      protocol: "http/1.1",
      mark_id: "1",
      description: "preserved",
      request: {
        auth: { type: "inherit" },
        header: {
          parameter: [{ key: "X-Test", value: "{{shared}}", is_checked: 1 }],
        },
        query: {
          parameter: [{ key: "q", value: "one", is_checked: 1 }],
          query_add_equal: 1,
        },
        restful: { parameter: [] },
        cookie: { parameter: [] },
        body: { mode: "none" },
        pre_tasks: [],
        post_tasks: [],
      },
      response: {
        example: [
          {
            raw: '{"ok":true}',
            headers: [],
            expect: {
              code: "200",
              content_type: "json",
              name: "Success",
              schema: { type: "object" },
            },
          },
        ],
      },
    },
  ],
});
