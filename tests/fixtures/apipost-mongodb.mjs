// Independent fixture based on the observed native UI declaration, not a
// successful original MongoDB runtime export (that path remains unverified).
import { nativeDatabaseFixture } from "./apipost-database.mjs";
export function nativeMongoFixture(
  url,
  { filter = { name: "one" }, pattern = "$.name", collection = "items" } = {},
) {
  const source = nativeDatabaseFixture(url, "mongodb");
  for (const config of Object.values(source.global.db_link[0].config)) {
    config.db_config.port = 27017;
    config.db_config.database = "fixture";
    config.db_config.auth_source = "source-auth-not-inherited";
  }
  const api = source.apis.find((node) => node.target_type === "api"),
    task = api.request.pre_tasks.find((task) => task.type === "database");
  task.data.method = "findone";
  task.data.collectionName = collection;
  task.data.query = JSON.stringify(filter);
  task.data.variables[0].pattern = pattern;
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
