import test from "node:test";
import assert from "node:assert/strict";
import {
  createGraphQLResponseFence,
  defaultNamedQuery,
  placeGraphQLDelete,
} from "../public/graphql-named-workspace.js";
import { createGraphQLWorkspaceDrafts } from "../public/graphql-workspace.js";
import { newGraphQLEditorRequest } from "../public/graphql-editor.js";

test("response generation fence rejects a receipt after named selection ABA, not any other owner", () => {
  const fence = createGraphQLResponseFence();
  const a = "p1:g1",
    b = "p2:g1";
  const olderA = fence.capture(a),
    oldB = fence.capture(b);
  fence.clear(a);
  const newA = fence.capture(a);
  assert.equal(fence.current(a, olderA), false);
  assert.equal(fence.current(a, newA), true);
  assert.equal(fence.current(b, oldB), true);
  fence.clear(a);
  assert.equal(fence.current(a, newA), false);
  assert.equal(fence.current(a, olderA), false);
  assert.equal(fence.current(b, oldB), true);
});

test("draft editor rejects even byte-identical current bodies owned by another named query", () => {
  const drafts = createGraphQLWorkspaceDrafts();
  const r = {
    ...newGraphQLEditorRequest(),
    graphqlNamedQueries: { activeId: "one" },
  };
  const before = r.body;
  drafts.edit(r, "query", "first query");
  r.graphqlNamedQueries.activeId = "two";
  assert.throws(() => drafts.apply(r), /正文已变化/);
  assert.throws(() => drafts.edit(r, "query", "second query"), /正文已变化/);
  assert.equal(r.body, before);
  assert.equal(drafts.pending(r), true);
});

test("default display labels only consider existing display names", () => {
  assert.equal(
    defaultNamedQuery([{ name: "自定义查询" }, { name: "自定义查询 3" }]),
    "自定义查询 4",
  );
});

test("delete placement follows the reference on desktop and clamps at narrow edges", () => {
  assert.deepEqual(
    placeGraphQLDelete({ right: 550, top: 277 }, 128, 96, 1363, 1023),
    { x: 496, y: 243 },
  );
  assert.deepEqual(
    placeGraphQLDelete({ right: 423, top: 825 }, 128, 96, 430, 830),
    { x: 294, y: 726 },
  );
  assert.deepEqual(
    placeGraphQLDelete({ right: 30, top: 22 }, 128, 96, 430, 830),
    { x: 8, y: 8 },
  );
});
