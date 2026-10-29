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

// Schema transfer declarations are distinct from the Media Type encoding map.
export const unsupportedMultipartSchemas = [
  ...[
    "base64",
    "base64url",
    "quoted-printable",
    "identity",
    "",
    null,
    false,
    0,
    [],
    {},
  ].map((contentEncoding) => ({
    openapi: "3.1.0",
    definition: { type: "string", contentEncoding },
  })),
  { openapi: "3.0.3", definition: { type: "string", format: "byte" } },
  { openapi: "3.0.4", definition: { type: "string", format: "byte" } },
  {
    openapi: "3.0.3",
    definition: { type: "string", contentEncoding: "base64" },
  },
];
export function transferDocument(
  origin,
  openapi,
  definition,
  mime = "multipart/form-data",
  mixed = false,
) {
  const doc = encodingDocument(origin, mime, undefined, false);
  doc.openapi = openapi;
  if (mixed) {
    doc.paths["/valid-first"] = structuredClone(doc.paths["/upload"]);
    doc.paths["/valid-first"].post.operationId = "valid-first";
    doc.paths["/valid-first"].post.requestBody.content[
      mime
    ].schema.properties.meta = { type: "string" };
    doc.paths = {
      "/valid-first": doc.paths["/valid-first"],
      "/upload": doc.paths["/upload"],
    };
  }
  doc.components.schemas.Text = definition;
  doc.paths["/upload"].post.requestBody.content[mime].example.meta = "AP8=";
  return doc;
}
