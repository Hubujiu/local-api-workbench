import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newGraphQLEditorRequest } from "../public/graphql-editor.js";
import { createGraphQLWorkspaceDrafts } from "../public/graphql-workspace.js";
import { createDesignResponseSettingsDrafts } from "../public/design-response-settings-draft.js";
import {
  createGrpcUnaryState,
  selectGrpcUnary,
} from "../public/grpc-unary-workbench.js";
import {
  createSocketIOState,
  selectSocketIO,
} from "../public/socketio-workbench.js";
const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const block = source.slice(
  source.indexOf('window.addEventListener("beforeunload"'),
  source.indexOf("async function init()"),
);
function unload({
  dirty = false,
  grpcProject = "p",
  socketProject = "p",
  grpc = null,
  socket = null,
  project = { id: "p" },
  graphqlDrafts = createGraphQLWorkspaceDrafts(),
  responseDrafts = createDesignResponseSettingsDrafts(),
} = {}) {
  let listener;
  new Function(
    "window",
    "dirty",
    "project",
    "grpcWorkbenchProject",
    "grpcWorkbenchState",
    "socketioWorkbenchProject",
    "socketioWorkbenchState",
    "graphqlDrafts",
    "designResponseSettingsDrafts",
    block,
  )(
    {
      addEventListener(name, fn) {
        assert.equal(name, "beforeunload");
        listener = fn;
      },
    },
    dirty,
    project,
    grpcProject,
    grpc,
    socketProject,
    socket,
    graphqlDrafts,
    responseDrafts,
  );
  const e = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  listener(e);
  return e;
}
test("ordinary dirty editor still protects close", () =>
  assert.equal(unload({ dirty: true }).prevented, true));
test("clean/no project never prompts", () => {
  assert.equal(unload().prevented, false);
  assert.equal(unload({ project: null }).prevented, false);
});
for (const [name, create, key] of [
  ["grpc", createGrpcUnaryState, "grpc"],
  ["socketio", createSocketIOState, "socket"],
]) {
  test(`${name} real unsaved definition protects refresh/close without mutation`, () => {
    const state = create();
    state.definition.name = "unsaved fixture";
    assert.equal(state.draftDirty, true);
    const before = JSON.stringify(state);
    const event = unload({ [key]: state });
    assert.equal(event.prevented, true);
    assert.equal(event.returnValue, "");
    assert.equal(JSON.stringify(state), before);
    assert.equal(
      unload({
        [key]: state,
        [key === "grpc" ? "grpcProject" : "socketProject"]: "other",
      }).prevented,
      false,
    );
  });
}

test("clean protocol definitions and runtime-only values do not create a definition prompt", () => {
  const grpc = createGrpcUnaryState(),
    socket = createSocketIOState();
  grpc.metadata = '[{"key":"temporary","value":"secret"}]';
  socket.auth = '{"token":"temporary"}';
  assert.equal(unload({ grpc, socket }).prevented, false);
});
test("Socket.IO raw event draft also protects unload", () => {
  const socket = createSocketIOState();
  socket.eventsText = "[invalid";
  assert.equal(unload({ socket }).prevented, true);
});

test("saved definition selection removes protection only after drafts are discarded", () => {
  const grpc = createGrpcUnaryState(),
    socket = createSocketIOState();
  grpc.definition.name = "dirty grpc";
  socket.definition.name = "dirty socket";
  const savedGrpc = { ...createGrpcUnaryState().definition, id: "g" };
  const savedSocket = { ...createSocketIOState().definition, id: "s" };
  assert.equal(unload({ grpc, socket }).prevented, true);
  selectGrpcUnary(grpc, savedGrpc);
  assert.equal(unload({ grpc, socket }).prevented, true);
  selectSocketIO(socket, savedSocket);
  assert.equal(unload({ grpc, socket }).prevented, false);
});

test("unapplied GraphQL editor drafts protect only their owning request and clear after discard", () => {
  const request = { ...newGraphQLEditorRequest(), id: "gql" };
  const project = { id: "p", requests: [request] };
  const graphqlDrafts = createGraphQLWorkspaceDrafts();
  const before = JSON.stringify(project);
  assert.equal(unload({ project, graphqlDrafts }).prevented, false);
  graphqlDrafts.edit(request, "query", "query Fixture { viewer { id } }");
  const event = unload({ project, graphqlDrafts });
  assert.equal(event.prevented, true);
  assert.equal(event.returnValue, "");
  assert.equal(JSON.stringify(project), before);
  assert.equal(
    unload({ project: structuredClone(project), graphqlDrafts }).prevented,
    false,
  );
  assert.equal(
    unload({
      project: { id: "other", requests: [{ ...request }] },
      graphqlDrafts,
    }).prevented,
    false,
  );
  assert.equal(unload({ project: null, graphqlDrafts }).prevented, false);
  assert.equal(graphqlDrafts.discard(request), true);
  assert.equal(unload({ project, graphqlDrafts }).prevented, false);
  assert.equal(JSON.stringify(project), before);
});

test("inline response settings protect only the owning response draft and clear on Cancel", () => {
  const request = { id: "same", responses: [{ status: "404" }] };
  const project = { id: "p", requests: [request] };
  const responseDrafts = createDesignResponseSettingsDrafts();
  responseDrafts.stage(request, { status: "404", value: "422" });
  assert.equal(unload({ project, responseDrafts }).prevented, true);
  assert.equal(
    unload({ project: structuredClone(project), responseDrafts }).prevented,
    false,
  );
  assert.equal(request.responses[0].status, "404");
  responseDrafts.clear(request);
  assert.equal(unload({ project, responseDrafts }).prevented, false);
});
