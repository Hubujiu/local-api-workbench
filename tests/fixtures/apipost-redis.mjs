// Independently authored from the observed Offline2 Redis JSON task contract.
import { nativeDatabaseFixture } from "./apipost-database.mjs";
export function nativeRedisFixture(
  url,
  { method = "get", query = '{"key":"localapi:fixture"}' } = {},
) {
  const source = nativeDatabaseFixture(url, "redis");
  for (const config of Object.values(source.global.db_link[0].config)) {
    config.db_config.port = 6379;
    config.db_config.database = "0";
  }
  const api = source.apis.find((node) => node.target_type === "api");
  const tasks = api.request.pre_tasks;
  const operation = tasks.find((task) => task.type === "database");
  operation.data.method = method;
  operation.data.query = query;
  operation.data.variables[0].pattern = "$";
  api.request.post_tasks = [
    {
      id: "post",
      name: "Response",
      type: "customScript",
      enabled: 1,
      data: 'pm.test("response",()=>pm.expect(pm.response.json().value).to.equal("prefix-"+apt.environment.get("native_value")));',
    },
  ];
  return source;
}
