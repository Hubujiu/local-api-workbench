import { manualImportDigest } from "./manual-import-token.mjs";
import { validateResourceFolder } from "./api-resource-lifecycle.mjs";

const fail = () => {
  throw Object.assign(Error("手动导入参数无效；请检查明确的格式、选择与策略"), {
    code: "MANUAL_IMPORT_INPUT_INVALID",
  });
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, required, optional = []) => {
  if (
    !object(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => ![...required, ...optional].includes(key))
  )
    fail();
};
const text = (value, maximum = 2048) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    !value.isWellFormed() ||
    value.includes("\0")
  )
    fail();
};
const keys = (values) => {
  if (
    !Array.isArray(values) ||
    values.length > 5000 ||
    new Set(values).size !== values.length
  )
    fail();
  for (const value of values) text(value);
};
const folder = (value, empty = false) => {
  if (empty && value === "") return;
  try {
    validateResourceFolder(value);
  } catch {
    fail();
  }
};
const modes = Object.freeze({
  api: ["both", "ignore", "url", "url_and_folder", "clear"],
  samples: ["both", "name"],
  models: ["both", "name"],
  environments: ["both"],
  documents: ["both"],
  globals: ["safe"],
});

// Direct callers receive the same descriptor/proxy/budget checks as transport
// JSON. Never inspect input fields before this ordinary-data validation.
export function normalizeManualImportInput(raw) {
  try {
    manualImportDigest(raw);
  } catch {
    fail();
  }
  const value = structuredClone(raw);
  exact(
    value,
    ["format", "document", "selection"],
    ["policies", "folderMap", "bindings", "options", "clearScope"],
  );
  if (
    !["auto", "apipost", "apipost-directory", "openapi"].includes(value.format)
  )
    fail();
  if (
    !(typeof value.document === "string" && value.document.trim()) &&
    !object(value.document)
  )
    fail();
  if (value.selection?.mode === "all") exact(value.selection, ["mode"]);
  else {
    exact(value.selection, ["mode", "keys"], ["exclude"]);
    if (value.selection.mode !== "explicit") fail();
    keys(value.selection.keys);
    keys(
      Object.hasOwn(value.selection, "exclude") ? value.selection.exclude : [],
    );
    const excluded = new Set(value.selection.exclude || []);
    if (value.selection.keys.some((key) => excluded.has(key))) fail();
  }
  if (!Object.hasOwn(value, "policies")) value.policies = {};
  exact(value.policies, [], Object.keys(modes));
  for (const [key, allowed] of Object.entries(modes)) {
    if (!Object.hasOwn(value.policies, key))
      value.policies[key] = key === "globals" ? "safe" : "both";
    if (!allowed.includes(value.policies[key])) fail();
  }
  for (const key of ["folderMap", "bindings"]) {
    if (!Object.hasOwn(value, key)) value[key] = {};
    if (!object(value[key]) || Object.keys(value[key]).length > 5000) fail();
    for (const [source, target] of Object.entries(value[key])) {
      if (key === "folderMap") {
        folder(source, true);
        folder(target, true);
      } else {
        text(source);
        text(target, 200);
      }
    }
  }
  if (!Object.hasOwn(value, "options")) value.options = {};
  exact(value.options, [], ["modelNameMode", "postmanVariableMode"]);
  if (
    (Object.hasOwn(value.options, "modelNameMode") &&
      !["namespaced", "preserve"].includes(value.options.modelNameMode)) ||
    (Object.hasOwn(value.options, "postmanVariableMode") &&
      !["environment", "collection"].includes(
        value.options.postmanVariableMode,
      ))
  )
    fail();
  if (value.policies.api === "clear") {
    exact(value.clearScope, ["folder"]);
    folder(value.clearScope.folder, true);
    if (value.selection.mode === "explicit" && !value.selection.keys.length)
      fail();
  } else if (Object.hasOwn(value, "clearScope")) fail();
  return value;
}

export function normalizeManualImportApply(raw) {
  try {
    manualImportDigest(raw);
  } catch {
    fail();
  }
  exact(raw, ["token", "input"]);
  if (typeof raw.token !== "string" || raw.token.length > 4096) fail();
  return { token: raw.token, input: normalizeManualImportInput(raw.input) };
}

export function assertManualImportResult(result) {
  // This leaves room for JSON-RPC's double-escaped content and correlation ID
  // inside the existing 8MiB frame cap. The whole preview is shown or rejected.
  manualImportDigest(result, { maxBytes: 2 * 1024 * 1024 });
  return result;
}
