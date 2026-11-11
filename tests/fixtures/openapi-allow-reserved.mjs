export const invalidReservedValues = ["true", null, 0, "false", [], {}];
export const versions = ["3.0.3", "3.1.0", "2.0"];

export function reservedDocument(
  version,
  allowReserved,
  origin = "http://127.0.0.1:1",
) {
  const parameter = {
    in: "query",
    name: "filter",
    ...(version === "2.0"
      ? { type: "string" }
      : { schema: { type: "string" } }),
    example: "a/b:c",
    ...(allowReserved === undefined ? {} : { allowReserved }),
  };
  return {
    ...(version === "2.0"
      ? { swagger: version, host: new URL(origin).host, schemes: ["http"] }
      : { openapi: version, servers: [{ url: origin }] }),
    info: { title: "Query reserved characters", version: "1" },
    paths: {
      "/search": {
        get: {
          operationId: "search",
          parameters: [parameter],
          responses: { 200: { description: "Echo" } },
        },
      },
    },
  };
}

export function mixedReservedDocument(version, value, origin) {
  const source = reservedDocument(version, false, origin);
  source.paths["/search"].get.summary = "Must not overwrite saved request";
  source.paths["/bad"] = reservedDocument(version, value, origin).paths[
    "/search"
  ];
  source.paths["/bad"].get.operationId = "bad";
  return source;
}
