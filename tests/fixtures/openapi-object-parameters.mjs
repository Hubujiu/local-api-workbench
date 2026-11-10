export const objectSchema = {
  type: "object",
  properties: { role: { type: "string" }, active: { type: "boolean" } },
};
export const objectValue = { role: "admin", active: true };

export function objectParameter(location, extra = {}) {
  return {
    in: location,
    name: location === "header" ? "X-Filter" : "prefs",
    schema: structuredClone(objectSchema),
    style: location === "header" ? "simple" : "form",
    explode: location === "header",
    example: structuredClone(objectValue),
    ...extra,
  };
}

export function objectVariants(location) {
  const base = objectParameter(location);
  const { example: _example, ...withoutExample } = base;
  return [
    base,
    withoutExample,
    { ...withoutExample, schema: { ...objectSchema, default: objectValue } },
    { ...withoutExample, schema: { ...objectSchema, example: objectValue } },
    { ...withoutExample, examples: { only: { value: objectValue } } },
    { ...withoutExample, schema: { const: objectValue } },
    { ...withoutExample, schema: { enum: [objectValue] } },
    { ...withoutExample, schema: { type: "array", contains: objectSchema } },
    {
      ...withoutExample,
      schema: {
        if: { type: "object" },
        then: { properties: objectSchema.properties },
        else: { type: "integer" },
      },
    },
    { ...base, schema: { properties: objectSchema.properties } },
    { ...base, schema: { type: ["string", "object"] } },
    ...["allOf", "anyOf", "oneOf"].map((key) => ({
      ...withoutExample,
      schema: { [key]: [objectSchema] },
    })),
    {
      ...base,
      schema: { type: "array", items: objectSchema },
      example: [objectValue],
    },
    { ...base, schema: { type: "array", items: {} }, example: [[objectValue]] },
    { ...base, schema: {} },
    { ...base, schema: { oneOf: [{ type: "string" }] } },
    {
      in: location,
      name: base.name,
      content: {
        "application/json": { schema: objectSchema, example: objectValue },
      },
    },
  ];
}

export function objectParameterDocument(
  version,
  parameter,
  origin = "http://127.0.0.1:1",
) {
  return {
    openapi: version,
    info: { title: "Object parameter admission", version: "1" },
    servers: [{ url: origin }],
    paths: {
      "/check": {
        get: {
          operationId: "check",
          parameters: [parameter],
          responses: { 200: { description: "Echo" } },
        },
      },
    },
  };
}

export function mixedObjectDocument(version, parameter, origin) {
  const source = objectParameterDocument(
    version,
    {
      in: "header",
      name: "X-Keep",
      schema: { type: "string" },
      example: "preserved",
    },
    origin,
  );
  source.paths["/check"].get.summary = "Must not replace the saved request";
  source.paths["/bad"] = objectParameterDocument(
    version,
    parameter,
    origin,
  ).paths["/check"];
  source.paths["/bad"].get.operationId = "bad";
  return source;
}

export function scalarHeaderCookieDocument(version, origin) {
  const source = objectParameterDocument(version, {}, origin);
  source.paths["/check"].get.parameters = [
    {
      in: "header",
      name: "X-Zero",
      schema: { type: "integer" },
      examples: { only: { value: 0 } },
    },
    {
      in: "header",
      name: "X-Literal",
      schema: { type: "string" },
      example: '{"role":"admin"}',
    },
    { in: "cookie", name: "flag", schema: { type: "boolean" }, example: false },
    { in: "cookie", name: "text", schema: { type: "string", default: "kept" } },
    {
      in: "query",
      name: "q",
      schema: { type: "array", items: { type: "string" } },
      example: ["a,b", "c&d"],
    },
  ];
  return source;
}
