import { normalizeRequest } from "../../src/core.mjs";
import { newGraphQLEditorRequest } from "../../public/graphql-editor.js";
import { prepareGraphQLNamedQueryChange } from "../../public/graphql-named-queries.js";

export const inactiveBody =
  ' \n{ "query" : "query InactiveFixture { viewer }", "variables":{ "literal":"\\u0042", "minus":-0 } }\t';
export const activeBody =
  ' \r\n{ "query" : "query ActiveFixture { viewer }", "variables": \r\n { "exact":9007199254740993, "minus":-0, "literal":"\\u0041" }, "operationName":"ActiveFixture" }\n';

export function namedGraphQLExportFixture({
  id = "graphql-export",
  deletedAt,
} = {}) {
  const initial = { ...newGraphQLEditorRequest(), body: inactiveBody };
  return normalizeRequest({
    ...initial,
    ...prepareGraphQLNamedQueryChange(initial, {
      type: "add",
      id: "active",
      name: "Active synthetic query",
    }),
    id,
    name: "Synthetic GraphQL export",
    url: "http://127.0.0.1:1/graphql",
    body: activeBody,
    ...(deletedAt ? { deletedAt } : {}),
  });
}
