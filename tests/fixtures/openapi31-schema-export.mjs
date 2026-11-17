export const payload = {
  state: "active",
  score: 3,
  floor: 5,
  fixed: { flags: [false, null] },
};
export function schemaDocument(origin) {
  const schema = {
    type: "object",
    required: ["state", "score", "floor", "fixed"],
    properties: {
      state: { type: "string", const: "active", enum: ["active", "other"] },
      score: {
        type: "number",
        minimum: 0,
        exclusiveMinimum: 2,
        maximum: 10,
        exclusiveMaximum: 8,
      },
      floor: { type: "number", minimum: 5, exclusiveMinimum: 2 },
      fixed: { const: { flags: [false, null] } },
    },
    additionalProperties: false,
  };
  return {
    openapi: "3.1.0",
    info: { title: "Portable schema", version: "1" },
    servers: [{ url: origin }],
    components: { schemas: { Payload: schema, State: { const: "active" } } },
    paths: {
      "/item": {
        post: {
          operationId: "portable-schema",
          parameters: [
            {
              in: "query",
              name: "limit",
              schema: { type: "integer", exclusiveMinimum: 2 },
              example: 3,
            },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Payload" },
                example: payload,
              },
            },
          },
          responses: {
            200: {
              description: "Echo",
              content: { "application/json": { schema, example: payload } },
            },
          },
        },
      },
    },
  };
}
