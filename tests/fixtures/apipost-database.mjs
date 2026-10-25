// Independently authored data, not an original export.
import { modernApipostFixture } from "./apipost-modern.mjs";
export function nativeDatabaseFixture(url = "http://127.0.0.1:1/") {
  const doc = modernApipostFixture();
  doc.global.envs = [];
  doc.global.servers = [];
  const config = {
    db_config: {
      auth_source: "",
      database: "synthetic-db",
      host: "private-host.invalid",
      password: "discard-this-fictional-password",
      port: 5432,
      user: "synthetic-user",
    },
    ssh: {
      auth_type: 1,
      enable: -1,
      host: "",
      passphrase: "",
      password: "",
      port: 22,
      private_key: "",
      username: "",
    },
  };
  doc.global.db_link = [
    {
      project_id: doc.project_id,
      db_id: "database",
      name: "Fixture database",
      intro: "fictional",
      type: "pg",
      config: {
        default: config,
        1: { ...structuredClone(config), use_default: 1 },
      },
    },
  ];
  const script = (id, data) => ({
    type: "customScript",
    enabled: 1,
    id,
    name: id,
    data,
  });
  const database = {
    type: "database",
    enabled: 1,
    id: "query",
    name: "Read",
    data: {
      connectionId: "database",
      query: "SELECT 'from-database' AS value",
      isConsoleOutput: 1,
      variables: [
        {
          name: "native_value",
          type: "environment",
          pattern: "$[0].value",
          param_id: "value",
        },
      ],
    },
  };
  const api = doc.apis[1];
  api.url = url;
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.pre_tasks = [
    script(
      "before",
      'const shared="prefix-";apt.environment.set("native_value","before");',
    ),
    database,
    script(
      "after-db",
      'apt.setRequestHeader("x-db-value",shared+apt.environment.get("native_value"));',
    ),
  ];
  api.request.post_tasks = [
    script(
      "post",
      'pm.test("response",()=>pm.expect(pm.response.json().value).to.equal("prefix-from-database"));',
    ),
  ];
  return doc;
}
