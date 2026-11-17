export function descriptionRecord(value, allowed) {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("参数说明须为普通对象");
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value))
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !fields[key].enumerable ||
      !Object.hasOwn(fields[key], "value")
    )
      throw Error("参数说明包含未知字段或访问器");
}
export function descriptionList(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length > 2000 ||
    Object.getPrototypeOf(rows) !== Array.prototype ||
    Reflect.ownKeys(rows).length !== rows.length + 1
  )
    throw Error("参数说明数组格式或数量无效");
  const fields = Object.getOwnPropertyDescriptors(rows);
  for (let i = 0; i < rows.length; i++)
    if (!fields[i]?.enumerable || !Object.hasOwn(fields[i], "value"))
      throw Error("参数说明数组不能含空洞或访问器");
  return rows;
}
export function validateParameterDescriptions(rows = []) {
  descriptionList(rows);
  const keys = new Set();
  let bytes = 0;
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i];
    descriptionRecord(entry, ["key", "description", "apipostSource"]);
    if (
      typeof entry.key !== "string" ||
      !entry.key.trim() ||
      entry.key !== entry.key.trim() ||
      entry.key.length > 200 ||
      keys.has(entry.key)
    )
      throw Error("参数说明名称无效或重复");
    if (
      typeof entry.description !== "string" ||
      entry.description.length > 8000
    )
      throw Error("参数说明最多8000字符");
    if (entry.apipostSource !== undefined) {
      descriptionRecord(entry.apipostSource, ["projectId", "id"]);
      for (const value of Object.values(entry.apipostSource))
        if (typeof value !== "string" || !value.trim() || value.length > 200)
          throw Error("参数说明来源无效");
      if (typeof entry.apipostSource.projectId !== "string")
        throw Error("参数说明来源缺少项目标识");
    }
    keys.add(entry.key);
    bytes += new TextEncoder().encode(JSON.stringify(entry)).length;
    if (bytes > 1024 * 1024) throw Error("参数说明库合计最多1MiB");
  }
  return rows;
}
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function parameterDescriptionsPanel(project) {
  const rows = validateParameterDescriptions(
    project.settings?.parameterDescriptions || [],
  );
  return (
    '<section class="card parameter-descriptions"><p>只复用参数说明，不覆盖参数名、类型、值或必填状态。在参数“定义”窗口中明确选择后才应用；修改库不会回写已采用的说明。</p><div class="toolbar"><button id="new-parameter-description" class="primary">新增说明</button><button data-edit-resource="parameterDescriptions">JSON 高级编辑</button></div><table><thead><tr><th>参数名</th><th>说明</th><th>操作</th></tr></thead><tbody>' +
    rows
      .map(
        (entry, index) =>
          "<tr><td>" +
          esc(entry.key) +
          "</td><td>" +
          esc(entry.description) +
          '</td><td><button data-edit-parameter-description="' +
          index +
          '">编辑</button><button data-delete-parameter-description="' +
          index +
          '">删除</button></td></tr>',
      )
      .join("") +
    "</tbody></table></section>"
  );
}
export function parameterDescriptionChoices(rows, key) {
  return (
    '<label>从参数说明库采用（只填入说明）</label><div class="row"><select id="description-choice" aria-label="参数说明库条目"><option value="">请选择</option>' +
    validateParameterDescriptions(rows)
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => Number(b.entry.key === key) - Number(a.entry.key === key))
      .map(
        ({ entry, index }) =>
          '<option value="' +
          index +
          '">' +
          esc(entry.key) +
          " · " +
          esc(entry.description.slice(0, 120)) +
          "</option>",
      )
      .join("") +
    '</select><button id="apply-parameter-description" type="button">采用所选说明</button></div>'
  );
}
