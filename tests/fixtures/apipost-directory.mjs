// Independent synthetic fixture, not a vendor-created directory.
import { modernApipostFixture } from "./apipost-modern.mjs";
export function nativeDirectoryFixture(d = modernApipostFixture()) {
  const files = [];
  const add = (path, value) =>
    files.push({ path, text: JSON.stringify(value) });
  add("project.json", {
    project_id: d.project_id,
    name: d.name,
    intro: d.intro,
  });
  add("global_params.json", d.global.global_param);
  add("global_vars.json", d.global.global_vars);
  for (const [dir, field, rows, wrapped] of [
    ["apis", "target_id", d.apis, true],
    ["envs", "env_id", d.global.envs, false],
    ["samples", "sample_id", d.samples, true],
    ["schemas", "model_id", d.models, true],
  ]) {
    add(dir + "/index.json", {
      project_id: d.project_id,
      items: rows.map((row) => ({ [field]: row[field], name: row.name })),
    });
    for (const row of rows)
      add(
        dir + "/" + row[field] + ".json",
        wrapped
          ? {
              [field]: row[field],
              project_id: d.project_id,
              name: row.name,
              data: row,
            }
          : { ...row, project_id: d.project_id },
      );
  }
  for (const [file, field] of Object.entries({
    custom_funcs: "custom_func",
    db_links: "db_link",
    marks: "marks",
    custom_attrs: "attributes",
    code_list: "codes",
    mock_custom_rules: "mock_custom_rules",
    desc_list: "describe_library",
  }))
    add("settings/" + file + ".json", d.global[field] || []);
  return { format: "apipost-offline-directory-v1", files };
}
