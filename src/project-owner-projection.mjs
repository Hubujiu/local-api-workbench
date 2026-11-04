// Only project envelopes produced by the Store are projected. User JSON inside
// request bodies, responses, schemas or documents is never recursively changed.
function projectView(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (
    !Array.isArray(value.requests) ||
    !Object.hasOwn(value, "requestDefinitionHistory")
  )
    return value;
  const { requestDefinitionHistory: _history, ...editable } = value;
  return editable;
}
export function projectOwnerResponse(value) {
  const direct = projectView(value);
  if (direct !== value) return direct;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "project")
  ) {
    const project = projectView(value.project);
    if (project !== value.project) return { ...value, project };
  }
  return value;
}
