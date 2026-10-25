// Independently authored protocol fixture. No original exported data.
export function nativeProtocolFixture({
  ws = "ws://127.0.0.1:1/echo?x=one",
  tcp = "127.0.0.1:2",
  sse = "http://127.0.0.1:3/events?x=one",
} = {}) {
  const base = {
    project_id: "protocol-fixture",
    name: "Protocol fixture",
    global: { global_param: { auth: { type: "noauth" } } },
    models: [],
    samples: [],
    automated_testings: [],
    apis: [],
  };
  const node = (id, type, name, parent = "0") => ({
    target_id: id,
    target_type: type,
    name,
    parent_id: parent,
    project_id: base.project_id,
    sort: 0,
    status: 1,
    version: 0,
  });
  const query = { parameter: [{ key: "x", value: "one", is_checked: 1 }] };
  base.apis = [
    {
      ...node("ws", "websocket2", "WebSocket"),
      url: ws,
      request: { query, header: { parameter: [] }, cookie: { parameter: [] } },
      config: {
        certificate_verification: -1,
        information_size: 5,
        reconnect_num: 5,
        reconnect_time: 5000,
        shake_hands_timeout: 0,
      },
      message: [
        {
          param_id: "message",
          name: "Echo",
          request: { mode: "text", raw: "wire-payload" },
          response: { mode: "text", raw: "" },
        },
      ],
    },
    {
      ...node("tcp", "socket", "TCP"),
      method: "TCP",
      url: tcp,
      request: { timeout: 10, end_func: { name: "none", option: "" } },
    },
    {
      ...node("tcp-message", "socket_method", "TCP message", "tcp"),
      method: "TCP",
      request: {
        body: { mode: "xml", raw: "wire-payload", parameter: [] },
        configs: { charset: "utf8", func: { request: [], response: [] } },
        post_tasks: [],
      },
    },
    {
      ...node("events", "sse", "Events"),
      method: "POST",
      url: sse,
      protocol: "",
      request: {
        auth: {
          type: "inherit",
          basic: { username: "inactive-secret", password: "not-retained" },
        },
        query,
        body: { mode: "text", raw: "fixture=synthetic" },
        pre_tasks: [],
        post_tasks: [],
        header: { parameter: [] },
        cookie: { parameter: [] },
        restful: { parameter: [] },
      },
    },
  ];
  return base;
}
