import { literalQueryEffectiveURL } from "../public/literal-query-rows.js";
export { literalQueryEffectiveURL };
import { isDeepStrictEqual } from "node:util";
import {
  canEditDebugURLQuery,
  inspectDebugURLQuery,
} from "../public/debug-url-query.js";
import { projectHistoryProjection } from "./request-definition-history.mjs";

const fail = () => {
  throw Error("URL 查询编辑状态无效或与当前接口不匹配");
};
const matches = (object, keys) =>
  object &&
  typeof object === "object" &&
  !Array.isArray(object) &&
  Object.keys(object).length === keys.length &&
  keys.every((key) => Object.hasOwn(object, key));
const id = (value) =>
  typeof value === "string" && /^[\w.-]{1,200}$/.test(value);
const maxRows = 1000;
const maxText = 65536;
const maxEntries = 100;
const maxBytes = 1024 * 1024;

function inspectEditor(value, projectId) {
  if (value === undefined) return undefined;
  let data;
  try {
    data = projectHistoryProjection(value, {
      maxBytes,
      maxNodes: 100000,
      maxDepth: 7,
    });
  } catch {
    fail();
  }
  if (
    !matches(data, ["version", "projectId", "entries"]) ||
    data.version !== 1 ||
    !id(data.projectId) ||
    data.projectId !== projectId ||
    !Array.isArray(data.entries) ||
    data.entries.length > maxEntries
  )
    fail();
  const ids = new Set();
  for (const entry of data.entries) {
    if (
      !matches(entry, ["requestId", "effectiveURL", "rows"]) ||
      !id(entry.requestId) ||
      ids.has(entry.requestId) ||
      typeof entry.effectiveURL !== "string" ||
      entry.effectiveURL.length > maxText ||
      !Array.isArray(entry.rows) ||
      !entry.rows.length ||
      entry.rows.length > maxRows
    )
      fail();
    ids.add(entry.requestId);
    for (const row of entry.rows)
      if (
        !matches(row, ["token", "enabled"]) ||
        typeof row.enabled !== "boolean" ||
        typeof row.token !== "string" ||
        !row.token ||
        row.token.length > maxText ||
        /[&#]/.test(row.token)
      )
        fail();
    if (entry.rows.every((row) => row.enabled)) fail();
    const parsed = inspectDebugURLQuery(
      literalQueryEffectiveURL(entry.effectiveURL, entry.rows, true),
    );
    if (
      !parsed?.rows ||
      parsed.rows.length !== entry.rows.length ||
      literalQueryEffectiveURL(entry.effectiveURL, entry.rows) !==
        entry.effectiveURL
    )
      fail();
  }
  return data;
}

function requestIndex(project) {
  const all = new Map();
  for (const request of project.requests || []) {
    if (all.has(request.id)) all.set(request.id, null);
    else all.set(request.id, request);
  }
  return all;
}

function bound(project, requests, entry) {
  const request = requests.get(entry.requestId);
  return (
    Array.isArray(request?.query) &&
    request.url === entry.effectiveURL &&
    canEditDebugURLQuery(project, request)
  );
}

export function readLiteralQueryEditorShape(project) {
  if (Object.hasOwn(project, "literalQueryEditorFormat")) fail();
  const property = Object.getOwnPropertyDescriptor(
    project,
    "literalQueryEditor",
  );
  if (!property) return undefined;
  if (
    !Object.hasOwn(property, "value") ||
    !property.enumerable ||
    property.value === undefined
  )
    fail();
  return inspectEditor(property.value, project.id);
}

export function validateLiteralQueryEditor(project) {
  const data = readLiteralQueryEditorShape(project);
  if (!data) return undefined;
  const requests = requestIndex(project);
  if (data.entries.some((entry) => !bound(project, requests, entry))) fail();
  return data;
}

// Checked-in definitions and externally edited request files never acquire private rows.
export function filterStoredLiteralQueryEditor(project, data, visible) {
  const editor = inspectEditor(data, project.id);
  const requests = requestIndex(project);
  const entries = editor.entries.filter(
    (entry) => visible.has(entry.requestId) && bound(project, requests, entry),
  );
  return entries.length ? { ...editor, entries } : undefined;
}

// Omission is legacy-compatible preservation, not permission to erase UI state.
export function reconcileLiteralQueryEditor(
  previous,
  candidate,
  { activity } = {},
) {
  const incoming = readLiteralQueryEditorShape(candidate);
  const prior = previous?.literalQueryEditor;
  if (activity && incoming && !isDeepStrictEqual(incoming, prior)) fail();
  const old = new Map(
    (prior?.entries || []).map((entry) => [entry.requestId, entry]),
  );
  const requests = requestIndex(candidate);
  const entries = [];
  for (const entry of (incoming ?? prior)?.entries || []) {
    if (bound(candidate, requests, entry)) entries.push(entry);
    else if (!isDeepStrictEqual(entry, old.get(entry.requestId))) fail();
  }
  if (entries.length)
    candidate.literalQueryEditor = {
      version: 1,
      projectId: candidate.id,
      entries,
    };
  else delete candidate.literalQueryEditor;
}
