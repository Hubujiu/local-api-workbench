export function graphqlExportNoticeHTML(project) {
  const namedVariants = (project?.requests || []).some(
    (request) =>
      !request.deletedAt &&
      request.graphqlEditorVersion === 1 &&
      Array.isArray(request.graphqlNamedQueries?.items) &&
      request.graphqlNamedQueries.items.length > 1,
  );
  return namedVariants
    ? '<p id="graphql-openapi-export-note" class="notice" role="status" hidden>OpenAPI 用于接口交换，不是完整备份。每个 GraphQL 接口只导出当前活动查询，不包含其他命名查询；JSON 示例可能重排或改变无法精确表示的数字。要完整保留所有命名查询及原始正文，请选择「本地项目 JSON」。</p>'
    : "";
}

export function bindGraphQLExportNotice(root) {
  const note = root.querySelector("#graphql-openapi-export-note");
  if (!note) return;
  const format = root.querySelector("#export-format");
  const update = () => {
    note.hidden = format.value !== "openapi";
    if (note.hidden) format.removeAttribute("aria-describedby");
    else format.setAttribute("aria-describedby", note.id);
  };
  format.addEventListener("change", update);
  update();
}
