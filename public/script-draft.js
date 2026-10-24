export function createScriptDraft(project, request, stage) {
  if (!["before", "after"].includes(stage)) throw Error("无效脚本阶段");
  return Object.freeze({
    project,
    request,
    stage,
    text: request[stage + "Script"] || "",
  });
}
export function applyScriptDraft(draft, project, request, stage, text) {
  if (typeof text !== "string") throw Error("脚本必须为文本");
  if (
    draft.project !== project ||
    draft.request !== request ||
    draft.stage !== stage ||
    (request[stage + "Script"] || "") !== draft.text
  )
    throw Error("接口或脚本已变更，请关闭并重新打开编辑器");
  if (text === draft.text) return false;
  request[stage + "Script"] = text;
  return true;
}
