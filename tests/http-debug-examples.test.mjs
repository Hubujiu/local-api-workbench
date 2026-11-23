import assert from "node:assert/strict";
import test from "node:test";
import { importDocument } from "../src/core.mjs";
import {
  createDebugExampleDrafts,
  debugExampleChoices,
  editableDebugExample,
  prepareDebugExampleMetadata,
  validateDebugExampleBody,
} from "../public/http-debug-examples.js";

test("presets remain virtual and current does not move when a real row of the same status appears", () => {
  const r = { examples: [] };
  const initial = debugExampleChoices(r);
  assert.deepEqual(
    initial.choices.map(({ name }) => name),
    ["成功", "失败"],
  );
  assert.equal(initial.current.key, "success");
  assert.deepEqual(r.examples, []);
  r.examples.push(prepareDebugExampleMetadata(r, undefined, "Created", "200"));
  assert.equal(debugExampleChoices(r, "success").current.key, "success");
  assert.equal(
    debugExampleChoices(r, r.examples[0]).current.row,
    r.examples[0],
  );
  assert.deepEqual(r.examples[0], {
    name: "Created",
    status: 200,
    body: "",
    headers: { "content-type": "text/plain" },
  });
});

test("metadata guards validity without dropping media, body, headers, or delay", () => {
  const row = {
    name: "Careful",
    status: 200,
    body: '\r\n{"id":101}',
    headers: { "Content-Type": "application/json", "X-Demo": "Keep" },
    delayMs: 500,
  };
  const r = { examples: [row] };
  const changed = prepareDebugExampleMetadata(r, row, "Named", "304");
  assert.deepEqual(changed, { ...row, name: "Named", status: 304 });
  assert.equal(changed.headers, row.headers);
  assert.throws(
    () => prepareDebugExampleMetadata(r, row, "Named", "600"),
    /整数/,
  );
  assert.throws(() => prepareDebugExampleMetadata(r, row, " ", "200"), /名称/);
  assert.throws(() => validateDebugExampleBody(r, row, "invalid"), /JSON/);
  const drafts = createDebugExampleDrafts();
  drafts.edit(r, row, "invalid");
  assert.equal(drafts.pending([r]), true);
  assert.equal(row.body, '\r\n{"id":101}');
  drafts.edit(r, row, '{"id":102}');
  assert.equal(drafts.pending([r]), false);
  assert.equal(row.body, '{"id":102}');
});

test("managed, opaque and incompatible media samples stay untouched", () => {
  const row = {
    name: "Imported",
    status: 404,
    body: "<x/>",
    headers: { "content-type": "application/xml" },
    delayMs: 7,
  };
  assert.equal(editableDebugExample({ examples: [row] }, row), false);
  const managed = {
    openapiExampleBindingsVersion: 1,
    examples: [{ ...row, headers: { "content-type": "text/plain" } }],
  };
  assert.equal(editableDebugExample(managed, managed.examples[0]), false);
  assert.throws(
    () => prepareDebugExampleMetadata(managed, undefined, "No", "200"),
    /仅供查看/,
  );
  const opaque = {
    ...row,
    headers: { "content-type": "text/plain" },
    presentation: 1,
  };
  assert.equal(editableDebugExample({ examples: [opaque] }, opaque), false);
});

test("an invalid pending body blocks replacing its exact row without blocking other rows", () => {
  const row = { name: "Live", status: 200, body: "{}" };
  const unrelated = { ...row };
  const request = { examples: [row, unrelated] };
  const drafts = createDebugExampleDrafts();
  drafts.edit(request, row, "{ invalid");
  assert.throws(() => drafts.assertReplaceable(row), /请返回调试/);
  assert.doesNotThrow(() => drafts.assertReplaceable(unrelated));
  assert.equal(drafts.read(row).body, "{ invalid");
  assert.equal(row.body, "{}");
  assert.equal(drafts.pending([request]), true);
  drafts.clear(row);
  assert.doesNotThrow(() => drafts.assertReplaceable(row));
  assert.equal(drafts.pending([request]), false);
});

test("a real legacy ApiPost import keeps provenance and text example read-only", () => {
  const [request] = importDocument({
    apis: [
      {
        target_type: "api",
        target_id: "Legacy",
        name: "Legacy example",
        url: "http://127.0.0.1:39090/fixture",
        request: {},
        response: {
          success: {
            expect: { name: "Text", code: 200, contentType: "text" },
            raw: "legacy",
          },
        },
      },
    ],
  });
  assert.equal(request.sourceOperationId, "apipost:Legacy");
  assert.equal(request.examples[0]?.body, "legacy");
  assert.equal(editableDebugExample(request, request.examples[0]), false);
  assert.equal(debugExampleChoices(request).choices.length, 1);
});
test("only unambiguous canonical supported media enter the inline editor", () => {
  const row = { name: "Example", status: 200, body: "{}" };
  const support = (headers, extra = {}) => {
    const example = { ...row, headers };
    return editableDebugExample({ examples: [example], ...extra }, example);
  };
  assert.equal(support(undefined), true);
  assert.equal(
    support({ "content-type": "application/problem+json; charset=utf-8" }),
    true,
  );
  assert.equal(support({ "content-type": "not-a-mime+json" }), false);
  assert.equal(
    support({
      "content-type": "text/plain",
      "Content-Type": "application/json",
    }),
    false,
  );
  assert.equal(
    support(
      { "content-type": "text/plain" },
      { sourceOperationId: "apipost-sample:fixture" },
    ),
    false,
  );
  assert.equal(
    support({ "content-type": "text/plain" }, { nativeTasks: {} }),
    false,
  );
  assert.equal(
    support({ "content-type": "text/plain" }, { nativeMockRoute: {} }),
    false,
  );
});
