import test from "node:test";
import assert from "node:assert/strict";
import {
  assertOpenAPIApplyReceipt,
  assertOpenAPIReview,
  openAPIReviewMarkup,
  readOpenAPIReviewInput,
} from "../public/openapi-file-review.js";

const preview = () => ({
  version: 1,
  configRevision: 3,
  expiresAt: Date.now() + 60000,
  items: [{ kind: "api", action: "create" }],
  blockers: [],
  warnings: [],
  noOp: false,
  historyImpact: { createdLineages: 1, addedSnapshots: 0, prunedSnapshots: 0 },
  counts: { created: 1, updated: 0, reused: 0, skipped: 0, trashed: 0 },
  token: "secret-token",
});
test("review freezes the exact UTF-8 file bytes, including CRLF and BOM", async () => {
  const text = '\uFEFF{\r\n  "openapi": "3.0.3"\r\n}\r\n';
  const input = await readOpenAPIReviewInput(new File([text], "selected.json"));
  assert.equal(input.document, text);
  assert(Object.isFrozen(input) && Object.isFrozen(input.selection));
  assert.deepEqual(input.selection, { mode: "all" });
  await assert.rejects(
    readOpenAPIReviewInput(new File([new Uint8Array([0xff])], "invalid.yaml")),
    /encoded data|UTF-8/i,
  );
  await assert.rejects(
    readOpenAPIReviewInput(new File(["123"], "not-supported.txt")),
    /JSON 或 YAML/,
  );
});

test("preview only admits coherent non-destructive plans and exact apply receipts", () => {
  const ready = preview();
  assert(assertOpenAPIReview(ready, 3));
  assert.throws(() => assertOpenAPIReview(ready, 4), /项目版本已变化/);
  assert.equal(assertOpenAPIReview({ ...ready, blockers: [{}] }, 3), false);
  const update = preview();
  update.items[0].action = "update";
  update.counts.created = 0;
  update.counts.updated = 1;
  assert.equal(assertOpenAPIReview(update, 3), false);
  const prune = preview();
  prune.historyImpact.prunedSnapshots = 1;
  assert.equal(assertOpenAPIReview(prune, 3), false);
  assert.throws(
    () =>
      assertOpenAPIReview(
        { ...ready, counts: { ...ready.counts, created: 9 } },
        3,
      ),
    /预览回执无效/,
  );
  assertOpenAPIApplyReceipt(
    { configRevision: 4, revision: 7, noOp: false, counts: ready.counts },
    ready,
  );
  assert.throws(
    () =>
      assertOpenAPIApplyReceipt(
        { configRevision: 5, revision: 7, noOp: false, counts: ready.counts },
        ready,
      ),
    /版本不匹配/,
  );
});

test("review displays only escaped safe labels, counts and honest all-items scope", () => {
  const html = openAPIReviewMarkup({
    projectName: "<owner>",
    fileName: "selected<file>.json",
    preview: preview(),
    input: {
      document: JSON.stringify({
        openapi: "3.0.3",
        paths: {
          "/x": {
            get: {
              summary: "<inert> Label",
              description: "hidden-response-secret",
            },
          },
        },
      }),
    },
    canApply: true,
  });
  assert.match(html, />GET</);
  assert.match(html, /&lt;inert&gt; Label/);
  assert.match(html, /selected&lt;file&gt;\.json/);
  assert.match(html, /&lt;owner&gt;/);
  assert.match(html, /不支持逐项选择/);
  assert.doesNotMatch(
    html,
    /secret-token|hidden-response-secret|<input|tablist/,
  );
});
