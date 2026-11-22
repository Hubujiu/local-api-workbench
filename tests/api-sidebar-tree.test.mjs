import assert from "node:assert/strict";
import test from "node:test";
import {
  renderWorkspaceTree,
  workspaceTreeItems,
} from "../public/api-sidebar-tree.js";
const project = {
  id: "a",
  folders: ["Imported/Child", "Empty"],
  requests: [
    { id: "root", name: "Root", method: "GET" },
    { id: "first", name: "First", method: "POST", folder: "Imported/Child" },
    { id: "deleted", name: "Deleted", method: "GET", deletedAt: "old" },
    { id: "last", name: "Last", method: "DELETE" },
  ],
  documents: [{ id: "doc", title: "Root <Doc>" }],
  settings: {
    grpcDefinitions: [
      { id: "grpc", name: "gRPC sample", target: "127.0.0.1:9999" },
    ],
    socketioDefinitions: [
      { id: "socket", name: "Socket sample", url: "http://127.0.0.1:9999" },
    ],
  },
  protocols: [
    {
      id: "wire",
      name: "Events",
      type: "sse",
      folder: "Imported/Child",
      url: "http://127.0.0.1:9999/events",
    },
    {
      id: "ws",
      name: "WebSocket sample",
      type: "websocket",
      folder: "Imported",
    },
  ],
};
const render = (opts = {}) =>
  renderWorkspaceTree({
    project,
    search: "",
    searchType: "all",
    page: "apis",
    current: "root",
    selectedProtocolId: "",
    collapsedFolders: new Set(["a:Imported"]),
    ...opts,
  });

test("APIS shows root docs, actual folders and direct roots in that order", () => {
  const html = render();
  assert.doesNotMatch(html, /未分组|data-request="deleted"/);
  assert.match(html, /data-document-index="0"[^>]+Root &lt;Doc&gt;/);
  assert.match(html, /data-tree-folder="Imported" ><summary/);
  assert.match(html, /data-tree-folder="Imported\/Child" open>/);
  assert.match(html, /Imported<\/span> <span class="tree-folder-count">\(3\)/);
  assert.match(html, /data-tree-depth="2" data-protocol-id="wire"/);
  assert.equal(
    [
      ...html.matchAll(
        /(data-(?:document-index|tree-folder|request))="([^"]+)"/g,
      ),
    ]
      .map(([, attr, value]) => attr + ":" + value)
      .join(","),
    "data-document-index:0,data-tree-folder:Imported,data-tree-folder:Imported/Child,data-request:first,data-tree-folder:Empty,data-request:root,data-request:last",
  );
  assert.match(
    html,
    /class="tree-item active" aria-current="true"[^>]*data-request="root"/,
  );
  assert.match(
    html,
    /data-request="last"[^>]+><span class="method DELETE">DEL/,
  );
  assert.match(
    render({ page: "docs" }),
    /data-tree-folder=""[^>]*><summary[^>]*>.*未分组/,
  );
});

test("existing type, folder and case-insensitive URL filters still map to exact owners", () => {
  assert.deepEqual(
    workspaceTreeItems(project, "/EVENTS", "all").map((r) => r.attribute),
    [["data-protocol-id", "wire"]],
  );
  assert.deepEqual(
    workspaceTreeItems(project, "IMPORTED", "http").map((r) => r.attribute),
    [["data-request", "first"]],
  );
  for (const [type, attr, id] of [
    ["grpc", "data-grpc-definition", "grpc"],
    ["socketio", "data-socketio-definition", "socket"],
    ["websocket", "data-protocol-id", "ws"],
    ["document", "data-document-index", 0],
  ]) {
    assert.deepEqual(
      workspaceTreeItems(project, "", type).map((row) => row.attribute),
      [[attr, id]],
    );
  }
  assert.match(
    render({ search: "events", searchType: "sse" }),
    /data-tree-folder="Imported" open>/,
  );
  assert.doesNotMatch(render({ search: "events" }), /data-request="root"/);
});
