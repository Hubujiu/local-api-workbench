// Independently authored fixture used in both local and original UI acceptance.
import { normalizeRequest } from "../../src/core.mjs";
export function nativeExportMatrix(port) {
  return {
    id: "owned-native-export-matrix",
    name: "Workbench Export Matrix",
    settings: {},
    servers: [{ id: "loopback", name: "Loopback Fixture" }],
    environments: [
      {
        id: "matrix",
        name: "Matrix Fixed",
        serverUrls: { loopback: `http://127.0.0.1:${port}` },
        variables: { value: "before-initial" },
        variableDefinitions: {
          value: {
            initialValue: "before-initial",
            description: "script changes this",
          },
        },
      },
    ],
    requests: [
      normalizeRequest({
        id: "script-form",
        name: "Export Script Form",
        folder: "Matrix",
        method: "POST",
        url: "/echo?fixture=export-script",
        serviceId: "loopback",
        bodyType: "urlencoded",
        form: [
          { key: "value", value: "{{value}}" },
          { key: "repeat", value: "one" },
          { key: "repeat", value: "two" },
          { key: "off", value: "disabled", enabled: false },
        ],
        auth: { type: "bearer", token: "fictional-export-bearer" },
        scriptDialect: "apipost8",
        beforeScript:
          'apt.environment.set("value", "from-export-script"); console.log("export-before");',
        afterScript:
          'apt.environment.set("after", apt.response.json().fixture); console.log("export-after");',
      }),
      normalizeRequest({
        id: "path-key",
        name: "Export Path Key",
        folder: "Matrix",
        method: "POST",
        url: `http://127.0.0.1:${port}/echo/{id}?literal=one`,
        path: [{ key: "id", value: "alpha" }],
        query: [{ key: "fixture", value: "export-path" }],
        bodyType: "json",
        body: '{"kind":"path-key"}',
        auth: {
          type: "apiKey",
          in: "query",
          key: "api-key",
          value: "fictional-key",
        },
      }),
      normalizeRequest({
        id: "multipart",
        name: "Export Multipart",
        folder: "Matrix",
        method: "POST",
        url: `http://127.0.0.1:${port}/echo?fixture=export-multipart`,
        bodyType: "form-data",
        form: [
          { key: "value", value: "literal text" },
          { key: "repeat", value: "one" },
          { key: "repeat", value: "two" },
        ],
        auth: { type: "none" },
      }),
    ],
  };
}
