import assert from "node:assert/strict";
import test from "node:test";
import {
  documentCounts,
  documentWorkspaceTabs,
  workspaceDocumentById,
  workspaceDocumentHTML,
} from "../public/workspace-document.js";

test("local document lookup never aliases a different or duplicated owner", () => {
  const item = { id: "same", title: "Real <Doc>", content: "# Hello" };
  const project = { requests: [{ id: item.id }], documents: [item] };
  assert.equal(workspaceDocumentById(project, item.id), item);
  assert.equal(workspaceDocumentById(project, ""), null);
  assert.equal(
    workspaceDocumentById({ documents: [item, { ...item }] }, item.id),
    null,
  );
  assert.equal(workspaceDocumentById({ documents: [] }, item.id), null);
  const tabs = documentWorkspaceTabs(
    project,
    ["unavailable", item.id],
    item.id,
  );
  assert.match(tabs, /data-open-document-tab="same" aria-current="page"/);
  assert.match(tabs, /关闭 Real &lt;Doc&gt;/);
  assert.doesNotMatch(tabs, /unavailable|<Doc>/);
});

test("workspace Markdown has only real draft controls and no raw HTML or remote image loads", () => {
  const content =
    "# Safe Markdown\n\n</textarea><script>globalThis.unexpected = true;</script>\n\n![remote](https://example.invalid/never)";
  const record = { title: '"><img>', content };
  const editor = workspaceDocumentHTML(record, {
    editing: true,
    saving: true,
    status: "设置中",
  });
  assert.match(editor, /value="&quot;&gt;&lt;img&gt;"/);
  assert.match(editor, /<h1>Safe Markdown<\/h1>/);
  assert.match(editor, /data-workspace-markdown="bold"/);
  assert.equal((editor.match(/data-workspace-markdown=/g) || []).length, 12);
  assert.equal(
    (editor.match(/aria-hidden="true" focusable="false"/g) || []).length,
    12,
  );
  assert.doesNotMatch(editor, /data-workspace-markdown="(?:image|share|help)"/);
  assert.match(editor, /id="save"[^>]+disabled/);
  assert.doesNotMatch(editor, /<script>|<img src=|id="send"/);
  const preview = workspaceDocumentHTML(record, {});
  assert.match(preview, /id="workspace-document-toggle">编辑/);
  assert.doesNotMatch(preview, /id="workspace-document-text"/);
  assert.equal(documentCounts("x\r\n中\n"), "字数: 5　行数: 3");
});
