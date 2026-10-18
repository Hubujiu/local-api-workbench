import { attributeOptions } from "./attribute-model.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function attributeFields(fields, values = {}, dataName = "attribute") {
  return (fields || [])
    .map((field, index) => {
      const value = values?.[field.key],
        id = dataName + "-" + index,
        attr =
          ' id="' + id + '" data-' + dataName + '="' + esc(field.key) + '"';
      let control;
      if (field.type === "boolean")
        control =
          '<input type="checkbox"' +
          attr +
          " " +
          (value === true ? "checked" : "") +
          ">";
      else if (["select", "multiselect"].includes(field.type)) {
        const multiple = field.type === "multiselect";
        control =
          "<select" +
          attr +
          (multiple ? ' multiple size="4"' : "") +
          ">" +
          (!multiple ? '<option value="">未选择</option>' : "") +
          attributeOptions(field)
            .map(
              (option) =>
                '<option value="' +
                esc(option.value) +
                '" ' +
                ((
                  multiple
                    ? Array.isArray(value) && value.includes(option.value)
                    : value === option.value
                )
                  ? "selected"
                  : "") +
                ">" +
                esc(option.label) +
                "</option>",
            )
            .join("") +
          "</select>";
      } else if (field.type === "string")
        control =
          '<textarea rows="2"' + attr + ">" + esc(value) + "</textarea>";
      else
        control =
          '<input type="' +
          ({ number: "number", date: "date", url: "url", email: "email" }[
            field.type
          ] || "text") +
          '"' +
          (field.type === "number" ? ' step="any"' : "") +
          attr +
          ' value="' +
          esc(value) +
          '">';
      return (
        '<label for="' + id + '">' + esc(field.label) + "</label>" + control
      );
    })
    .join("");
}
export function attributeChooser(project) {
  const fields = project.settings?.attributes || [];
  return fields.length
    ? "<fieldset><legend>选择要公开的接口/文档属性（默认不包含）</legend>" +
        fields
          .map(
            (field) =>
              '<label><input type="checkbox" data-share-attribute value="' +
              esc(field.key) +
              '">' +
              esc(field.label) +
              "</label>",
          )
          .join("") +
        "</fieldset>"
    : "";
}
function selectedAttributes(project, record, keys = []) {
  return (project.settings?.attributes || [])
    .filter(
      (field) =>
        keys.includes(field.key) &&
        !["__proto__", "prototype", "constructor"].includes(field.key) &&
        Object.hasOwn(record.attributes || {}, field.key),
    )
    .map((field) => {
      const value = record.attributes[field.key];
      const options = attributeOptions(field);
      const display =
        field.type === "multiselect" && Array.isArray(value)
          ? value
              .map(
                (item) =>
                  options.find((option) => option.value === item)?.label ||
                  item,
              )
              .join("、")
          : field.type === "select"
            ? options.find((option) => option.value === value)?.label || value
            : field.type === "boolean"
              ? value
                ? "是"
                : "否"
              : value;
      return [
        field.label,
        display === undefined || display === null || display === ""
          ? "—"
          : display,
      ];
    });
}
export function attributeHTML(project, record, keys = []) {
  const rows = selectedAttributes(project, record, keys);
  return rows.length
    ? '<table class="attribute-document"><tbody>' +
        rows
          .map(
            ([label, value]) =>
              "<tr><th>" + esc(label) + "</th><td>" + esc(value) + "</td></tr>",
          )
          .join("") +
        "</tbody></table>"
    : "";
}
export function attributeMarkdown(project, record, keys = []) {
  const rows = selectedAttributes(project, record, keys),
    cell = (value) =>
      esc(value)
        .replace(/([\\`*_{}\[\]()#+!|])/g, "\\$1")
        .replace(/\r?\n/g, " / ");
  return rows.length
    ? "\n\n| 属性 | 值 |\n| --- | --- |\n" +
        rows
          .map(
            ([label, value]) => "| " + cell(label) + " | " + cell(value) + " |",
          )
          .join("\n") +
        "\n"
    : "";
}
export function attributePanel(project) {
  return (
    '<section class="card"><p>文本、数字、单选、多选、日期、链接、邮箱；兼容原有布尔属性。属性默认不公开，分享时逐项选择。</p><div class="toolbar"><button id="new-attribute" class="primary">新增属性</button><button data-edit-resource="attributes">JSON 高级编辑</button></div><table><thead><tr><th>标识</th><th>名称</th><th>类型</th><th></th></tr></thead><tbody>' +
    (project.settings?.attributes || [])
      .map(
        (field, index) =>
          "<tr><td>" +
          esc(field.key) +
          "</td><td>" +
          esc(field.label) +
          "</td><td>" +
          esc(field.type) +
          '</td><td><button data-edit-attribute-def="' +
          index +
          '">编辑</button><button data-delete-attribute-def="' +
          index +
          '">删除定义</button></td></tr>',
      )
      .join("") +
    "</tbody></table></section>"
  );
}
