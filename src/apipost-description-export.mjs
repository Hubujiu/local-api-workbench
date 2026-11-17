import { isDeepStrictEqual } from "node:util";
import { validateParameterDescriptions } from "../public/parameter-descriptions.js";
import { mergeApipostDescriptions } from "./apipost-descriptions.mjs";

const definitions = (rows) =>
  validateParameterDescriptions(rows).map(({ key, description }) => ({
    key,
    description,
  }));

export function verifyApipostDescriptionDefinitions(
  expected = [],
  actual = [],
) {
  if (!isDeepStrictEqual(definitions(expected), definitions(actual)))
    throw Error("原生参数说明库导出回读不一致");
}

export function exportApipostDescriptions(rows = [], { projectId, id }) {
  // Validate the complete stored definitions before discarding historical origin.
  validateParameterDescriptions(rows);
  if (
    typeof projectId !== "string" ||
    !projectId.trim() ||
    projectId.length > 200
  )
    throw Error("原生参数说明库目标项目标识无效");
  const output = rows.map(({ key, description }) => ({
    // JSON escapes preserve distinct lone surrogates before UTF-8 hashing.
    id: id("description", JSON.stringify([projectId, key])),
    project_id: projectId,
    key,
    description,
  }));
  const restored = mergeApipostDescriptions(output, [], projectId);
  verifyApipostDescriptionDefinitions(rows, restored);
  return output;
}
