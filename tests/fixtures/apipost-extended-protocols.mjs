// Independently authored fictional source, not an original archive.
export const extendedProto =
  'syntax = "proto3"; package sample; message Input { string text = 1; int64 big = 2; bytes blob = 3; } service Echo { rpc Unary(Input) returns (Input); rpc Watch(Input) returns (stream Input); }';
export function extendedProtocolFixture({
  socketio = "http://127.0.0.1:1",
  grpc = "127.0.0.1:2",
} = {}) {
  const message = { text: "precise", big: "9007199254740993", blob: "/wA=" };
  return {
    project_id: "extended-fixture",
    name: "Extended protocols",
    global: { global_param: { auth: { type: "noauth" } } },
    models: [],
    samples: [],
    automated_testings: [],
    apis: [
      {
        target_id: "io",
        target_type: "socketio",
        project_id: "extended-fixture",
        name: "Socket.IO",
        parent_id: "0",
        method: "",
        url: socketio,
        ack: 1,
        msg_data: "fixture",
        config: {
          certificate_verification: -1,
          reconnect_num: 5,
          reconnect_time: 5000,
          shake_hands_path: "/socket.io",
          shake_hands_timeout: 0,
          socket_version: "v4",
        },
        request: {
          header: { parameter: [] },
          query: { parameter: [] },
          cookie: { parameter: [] },
          event: { parameter: [] },
        },
        message: [
          {
            name: "Message",
            param_id: "message",
            request: { mode: "text", raw: "native-io" },
            response: { mode: "text", raw: "" },
          },
        ],
      },
      {
        target_id: "rpc",
        target_type: "grpc",
        project_id: "extended-fixture",
        name: "gRPC",
        parent_id: "0",
        request: { description: "" },
        protos: [
          {
            proto_id: "proto",
            proto_content: extendedProto,
            proto_name: "reflection.proto",
            proto_path: "",
            proto_is_cloud: -1,
            include_dirs: [],
            include_files: [],
            url: "",
            services: [
              {
                service_id: "service",
                service_name: "sample.Echo",
                methods: [
                  {
                    grpc_method_id: "unary",
                    name: "Unary",
                    url: grpc,
                    request_stream: -1,
                    response_stream: -1,
                    ssl: -1,
                    tls: -1,
                    reconnect_num: 0,
                    request: {
                      metadata: { parameter: [] },
                      message: [
                        {
                          name: "Input",
                          param_id: "input",
                          raw: JSON.stringify(message),
                          raw_parameter: [],
                        },
                      ],
                    },
                  },
                  {
                    grpc_method_id: "watch",
                    name: "Watch",
                    url: "",
                    request_stream: -1,
                    response_stream: 1,
                    ssl: -1,
                    tls: -1,
                    reconnect_num: 0,
                    request: {
                      metadata: { parameter: [] },
                      message: [
                        {
                          name: "Empty",
                          param_id: "empty",
                          raw: "",
                          raw_parameter: [],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
