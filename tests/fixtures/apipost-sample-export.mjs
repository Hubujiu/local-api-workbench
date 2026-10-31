import { modernApipostFixture } from "./apipost-modern.mjs";
// Independently authored native-shaped data, not a vendor-generated export.
export function nativeSampleExportFixture(url = "http://127.0.0.1:1") {
  const source = modernApipostFixture();
  source.global.marks = [];
  const request = (body = "") => ({
    auth: { type: "noauth" },
    header: { parameter: [] },
    query: { parameter: [] },
    cookie: { parameter: [] },
    restful: { parameter: [] },
    body: { mode: body ? "json" : "none", raw: body, parameter: [] },
    pre_tasks: [],
    post_tasks: [],
  });
  source.apis = ["one", "two"].map((target_id, sort) => ({
    target_id,
    parent_id: "0",
    project_id: source.project_id,
    target_type: "api",
    name: "Same API name",
    method: "POST",
    url: url + "/api-" + target_id,
    sort,
    request: request(),
    response: { example: [] },
  }));
  source.samples = [
    {
      sample_id: "group",
      parent_id: "0",
      target_id: "one",
      project_id: source.project_id,
      name: "Group",
      type: "sample_group",
      method: "",
      url: "",
      sort: 8,
    },
    {
      sample_id: "empty",
      parent_id: "group",
      target_id: "one",
      project_id: source.project_id,
      name: "Empty",
      type: "sample_group",
      method: "",
      url: "",
      sort: -2,
    },
    ...[
      ["root", "0", "one", 4],
      ["grouped", "group", "one", 2],
      ["other", "0", "two", 3],
    ].map(([sample_id, parent_id, target_id, sort]) => ({
      sample_id,
      parent_id,
      target_id,
      sort,
      project_id: source.project_id,
      type: "sample",
      name: sample_id,
      method: "POST",
      url: url + "/case-" + sample_id,
      description: "frozen " + sample_id,
      protocol: "http/1.1",
      request: request('{"case":"' + sample_id + '","id":"{{id}}"}'),
      response: { example: [] },
    })),
  ];
  return source;
}
