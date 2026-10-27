import { nativeProtocolFixture } from "./apipost-native-protocols.mjs";
import { modernApipostFixture } from "./apipost-modern.mjs";
export function nativeProtocolExportFixture(
  tcp = "127.0.0.1:1",
  sse = "http://127.0.0.1:2/events?x=one",
) {
  const source = modernApipostFixture();
  source.global.envs[0].env_var_list.payload = {
    value: "initial",
    current_value: "wire-value",
  };
  source.models = [
    {
      model_id: "model",
      model_type: "model",
      name: "Payload",
      schema: { type: "string" },
    },
  ];
  source.apis = source.apis.filter((n) => n.target_type === "api").slice(0, 1);
  source.apis[0].parent_id = "a";
  source.apis[0].request.pre_tasks = [];
  source.apis[0].request.post_tasks = [];
  source.apis.push(
    {
      target_id: "a",
      target_type: "folder",
      name: "A",
      parent_id: "0",
      request: {},
    },
    {
      target_id: "b",
      target_type: "folder",
      name: "B",
      parent_id: "a",
      request: {},
    },
    {
      target_id: "doc",
      target_type: "doc",
      name: "Protocol guide",
      parent_id: "a",
      description: "inert protocol notes",
    },
  );
  const nodes = nativeProtocolFixture({ tcp, sse }).apis.filter(
    (n) => n.target_type !== "websocket2",
  );
  for (const n of nodes) n.project_id = source.project_id;
  nodes[0].parent_id = "b";
  nodes[1].request.body.raw = "{{payload}}";
  nodes[1].description = "keep TCP description";
  nodes[1].response = { raw: "inert example" };
  nodes[2].request.header.parameter = [
    { key: "Accept-Language", value: "zh-CN", is_checked: 1 },
  ];
  nodes[2].parent_id = "a";
  nodes[2].request.body.raw = "{{payload}}";
  const second = structuredClone(nodes[2]);
  second.target_id = "events-two";
  second.name = "Events two";
  second.parent_id = "b";
  source.apis.push(...nodes, second);
  return source;
}
