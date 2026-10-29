export const formMedia = [
  "multipart/form-data",
  "application/x-www-form-urlencoded",
];
export const invalidEncodings = [
  null,
  false,
  0,
  "",
  [],
  [{}],
  { meta: null },
  { meta: false },
  { meta: 0 },
  { meta: "" },
  { meta: [] },
  { missing: {} },
  { exampleOnly: {} },
  { "x-unknown": {} },
  { meta: { contentType: "application/json" } },
  { meta: { headers: {} } },
  { meta: { style: "form" } },
  { meta: { explode: false } },
  { meta: { allowReserved: false } },
  { meta: { "x-vendor": true } },
  { meta: { $ref: "#/components/schemas/Text" } },
  JSON.parse('{"__proto__":{}}'),
  { constructor: {} },
  { prototype: {} },
];
export function encodingDocument(origin, mime, encoding, present = true) {
  return {
    openapi: "3.0.3",
    servers: [{ url: origin }],
    components: { schemas: { Text: { type: "string" } } },
    paths: {
      "/upload": {
        post: {
          operationId: "encoding-control",
          requestBody: {
            content: {
              [mime]: {
                schema: {
                  type: "object",
                  properties: {
                    meta: { $ref: "#/components/schemas/Text" },
                    "x-field": { type: "string" },
                  },
                },
                example: {
                  meta: "雪 & +",
                  "x-field": "literal",
                  exampleOnly: "kept",
                },
                ...(present ? { encoding } : {}),
              },
            },
          },
          responses: { 200: { description: "OK" } },
        },
      },
    },
  };
}
export function mixedEncodingDocument(origin, mime, encoding) {
  const good = encodingDocument(origin, mime, {}, false);
  const bad = encodingDocument(origin, mime, encoding);
  good.paths["/invalid"] = bad.paths["/upload"];
  good.paths["/invalid"].post.operationId = "invalid-after-valid";
  return good;
}
