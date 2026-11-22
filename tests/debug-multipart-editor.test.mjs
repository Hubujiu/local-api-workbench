import assert from "node:assert/strict";
import test from "node:test";
import {
  debugMultipartEditor,
  isDebugMultipart,
  multipartSelection,
  newMultipartTextRow,
} from "../public/debug-multipart-editor.js";
import { requestParameterTabs } from "../public/http-request-parameter-tabs.js";

test("Debug multipart composer adds only a named enabled text draft", () => {
  assert.equal(isDebugMultipart("apis", "debug", "body", "form-data"), true);
  for (const args of [
    ["apis", "design", "body", "form-data"],
    ["apis", "debug", "body", "urlencoded"],
    ["apis", "debug", "query", "form-data"],
    ["docs", "debug", "body", "form-data"],
  ])
    assert.equal(isDebugMultipart(...args), false);
  assert.equal(newMultipartTextRow(" \t"), null);
  assert.deepEqual(newMultipartTextRow(" profile "), {
    key: " profile ",
    value: "",
    enabled: true,
    type: "text",
  });
  assert.match(
    requestParameterTabs(
      {
        bodyType: "form-data",
        form: [{ key: "" }, { key: "a" }, { key: "b", enabled: false }],
      },
      "body",
    ),
    />Body \(2\)<\/button>/,
  );
  assert.match(
    requestParameterTabs({ bodyType: "form-data", form: [] }, "body"),
    />Body<\/button>/,
  );
  assert.match(
    requestParameterTabs({ bodyType: "json", form: [] }, "body"),
    />Body \(1\)<\/button>/,
  );
});

test("table uses real controls and faithfully displays existing part media read-only", () => {
  const rows = [
    {
      key: "file",
      type: "file",
      filename: "<file>",
      contentType: "text/plain",
    },
  ];
  const html = debugMultipartEditor(rows, (value) =>
    String(value ?? "")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;"),
  );
  assert.match(html, /type="file" data-field-file="0"/);
  assert.match(html, />&lt;file&gt;<\/span>/);
  assert.match(
    html,
    /class="debug-multipart-media" title="text\/plain">text\/plain<\/td>/,
  );
  assert.match(html, /data-remove-pair="form:0"/);
  assert.match(html, /id="debug-multipart-new-key"/);
  assert.deepEqual(multipartSelection([]), {
    disabled: true,
    checked: false,
    indeterminate: false,
  });
  assert.deepEqual(multipartSelection(rows), {
    disabled: false,
    checked: true,
    indeterminate: false,
  });
  assert.deepEqual(
    multipartSelection([...rows, { key: "second", enabled: false }]),
    {
      disabled: false,
      checked: false,
      indeterminate: true,
    },
  );
});
