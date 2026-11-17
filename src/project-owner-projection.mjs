// Only project envelopes produced by the Store are projected. User JSON inside
// request bodies, responses, schemas or documents is never recursively changed.
function projectView(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (
    !Array.isArray(value.requests) ||
    !fields.some((field) => Object.hasOwn(value, field))
  )
    return value;
  const editable = { ...value };
  for (const field of fields) delete editable[field];
  return editable;
}
function projectResponse(value, fields) {
  const direct = projectView(value, fields);
  if (direct !== value) return direct;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "project")
  ) {
    const project = projectView(value.project, fields);
    if (project !== value.project) return { ...value, project };
  }
  return value;
}

export function projectOwnerResponse(value) {
  return projectResponse(value, ["requestDefinitionHistory", "loadRuns"]);
}

// Existing MCP project-returning operations do not grant access to load receipts.
export function projectWithoutLoadRuns(value) {
  return projectResponse(value, ["loadRuns"]);
}
