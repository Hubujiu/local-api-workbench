import {
  attributeDocument,
  attributeSemantics,
} from "./apipost-export-attributes.mjs";
import { catalogueDocument as codeDocument } from "./apipost-codes.mjs";
import { catalogueDocument as descriptionDocument } from "./apipost-descriptions.mjs";

export function combinedDocument(url) {
  const document = attributeDocument(url);
  const relocate = (row) => ({
    ...row,
    ...(row.project_id === undefined
      ? {}
      : { project_id: document.project_id }),
  });
  document.global.codes = codeDocument(url).global.codes.map(relocate);
  document.global.describe_library =
    descriptionDocument(url).global.describe_library.map(relocate);
  document.global.codes.push({
    code_number: "field-0",
    code_msg: "An independent business code",
  });
  document.global.describe_library.push({
    key: "field-0",
    description: "An independent parameter description",
  });
  return document;
}
export function catalogueSemantics(project) {
  return {
    attributes: attributeSemantics(project),
    codes: project.settings.statusCodes.map(({ code, label }) => ({
      code,
      label,
    })),
    descriptions: project.settings.parameterDescriptions.map(
      ({ key, description }) => ({ key, description }),
    ),
  };
}
