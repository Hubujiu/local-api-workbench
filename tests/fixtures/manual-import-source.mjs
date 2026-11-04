// Independently authored canonical converter output. No application substitute.
export function manualImportCanonicalFixture() {
  return {
    requests: [
      {
        id: "generated-api",
        sourceOperationId: "native-api",
        name: "Read",
        method: "GET",
        url: "/read",
        folder: "Root/Child",
        serviceId: "server",
        statusId: "ready",
        schema: { $ref: "#/components/schemas/A" },
        examples: [
          {
            schema: { $ref: "#/components/schemas/B" },
            body: '{"$ref":"unchanged"}',
          },
        ],
        attributes: { attribute: "value" },
        postmanCollectionId: "generated-collection",
      },
    ],
    folders: ["Root", "Root/Child"],
    documents: [
      {
        id: "document",
        title: "Guide",
        folder: "Root",
        content: "literal generated-api",
        apipostSource: { targetId: "document", parentId: "native-folder" },
      },
    ],
    dictionary: [
      {
        id: "A",
        name: "A",
        folderId: "model-child",
        schema: {
          $ref: "#/components/schemas/B",
          example: { $ref: "https://literal.invalid" },
        },
      },
      {
        id: "B",
        name: "B",
        schema: {
          type: "object",
          properties: { self: { $ref: "#/components/schemas/A" } },
        },
      },
    ],
    modelFolders: [
      { id: "model-root", name: "Models", parentId: "" },
      { id: "model-child", name: "Children", parentId: "model-root" },
    ],
    openapiComponents: {
      schemas: {
        A: {
          $ref: "#/components/schemas/B",
          example: { $ref: "https://literal.invalid" },
        },
        B: {
          type: "object",
          properties: { self: { $ref: "#/components/schemas/A" } },
        },
      },
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    cases: [
      {
        id: "sample",
        name: "Example",
        sourceRequestId: "generated-api",
        folderId: "case-child",
        request: {
          id: "generated-snapshot",
          name: "Frozen",
          method: "GET",
          url: "/frozen",
          schema: { $ref: "#/components/schemas/B" },
        },
        functions: [{ name: "fn_sample", body: "return text;" }],
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    ],
    caseFolders: [
      {
        id: "case-root",
        name: "Examples",
        sourceRequestId: "generated-api",
        parentId: "",
      },
      {
        id: "case-child",
        name: "Nested",
        sourceRequestId: "generated-api",
        parentId: "case-root",
      },
    ],
    environments: [
      {
        id: "generated-env",
        name: "Dev",
        variables: { token: "current" },
        variableDefinitions: {
          token: { initialValue: "initial", description: "Token" },
        },
        serverUrls: { server: "https://service.invalid" },
      },
    ],
    servers: [{ id: "server", name: "Service" }],
    globalVariables: { shared: "value" },
    globalVariableDefinitions: { shared: { initialValue: "initial" } },
    settings: {
      functions: [{ name: "fn_global", body: "return text;" }],
      statuses: [{ id: "ready", name: "Ready" }],
      attributes: [{ key: "attribute", label: "A" }],
      apipostDatabases: [
        {
          id: "database",
          sourceId: "native-db",
          sourceProjectId: "native-project",
          name: "DB",
          driver: "mysql",
          needsRebind: true,
        },
      ],
      apipostDirectoryArtifacts: [
        {
          sourceProjectId: "native-project",
          files: [{ path: "settings/mock_inner_rules.json", text: "[]" }],
        },
      ],
    },
    protocols: [
      {
        id: "protocol",
        name: "Socket",
        type: "sse",
        url: "https://service.invalid/events",
        folder: "Root",
      },
    ],
    plans: [
      {
        id: "plan",
        name: "Frozen plan",
        environmentId: "generated-env",
        createdAt: "2021-01-01T00:00:00.000Z",
        updatedAt: "2021-01-02T00:00:00.000Z",
        functions: [],
        steps: [
          {
            id: "step",
            request: {
              id: "generated-plan-request",
              name: "Frozen read",
              method: "GET",
              url: "/before",
              schema: { $ref: "#/components/schemas/A" },
            },
          },
        ],
        importedNativeFlowSource: {
          version: 1,
          source: "manual",
          sourceProjectId: "native-project",
          sourceFlowId: "native-flow",
          steps: [{ sourceStepId: "native-step", importedStepId: "step" }],
        },
      },
    ],
    postmanCollections: {
      version: 1,
      items: [
        {
          id: "generated-collection",
          name: "Collection",
          variables: {},
          definitions: {},
        },
      ],
    },
  };
}

// Existing supported modern samples/global fields, with independently authored
// model and function definitions. This is input to the real converter tests.
import { nativeSampleExportFixture } from "./apipost-sample-export.mjs";
import { nativeDirectoryFixture } from "./apipost-directory.mjs";
export function manualImportModernSourceFixture() {
  const source = nativeSampleExportFixture();
  source.models = [
    {
      model_id: "model-folder",
      model_type: "folder",
      name: "Models",
      parent_id: "0",
    },
    {
      model_id: "A",
      model_type: "model",
      name: "A",
      parent_id: "model-folder",
      schema: { type: "object", properties: { value: { $ref: "B" } } },
    },
    {
      model_id: "B",
      model_type: "model",
      name: "B",
      parent_id: "model-folder",
      schema: { type: "string" },
    },
  ];
  source.global.custom_func = [
    {
      func_id: "keep",
      func_name: "fn_keep",
      func_body: "return text;",
      func_desc: "Preserved function",
      project_id: source.project_id,
    },
  ];
  source.global.envs[0].env_var_list.id.description = "Identifier";
  source.global.global_vars.shared.description = "Shared value";
  source.apis[0].request.body.raw_schema = { $ref: "A" };
  source.samples.find(
    (sample) => sample.type === "sample",
  ).request.body.raw_schema = { $ref: "B" };
  return source;
}
export function manualImportDirectorySourceFixture() {
  const source = manualImportModernSourceFixture();
  const directory = nativeDirectoryFixture(source);
  const flow = {
    flow_id: "flow",
    project_id: source.project_id,
    name: "Frozen source flow",
    description: "Preserve source steps",
    source: "manual",
    environment_id: "1",
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
    steps: [
      {
        step_id: "step",
        target_id: "one",
        api_snapshot: structuredClone(source.apis[0]),
      },
    ],
  };
  const { steps, ...metadata } = flow;
  directory.files.push(
    {
      path: "executions/flows/index.json",
      text: JSON.stringify({
        version: 2,
        records: [{ ...metadata, step_count: steps.length }],
      }),
    },
    { path: "executions/flows/flow.json", text: JSON.stringify(flow) },
    { path: "settings/mock_inner_rules.json", text: "[]" },
  );
  return directory;
}
