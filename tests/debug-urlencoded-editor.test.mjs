import assert from "node:assert/strict";
import test from "node:test";
import {
  debugURLencodedEditor,
  isDebugURLencoded,
} from "../public/debug-urlencoded-editor.js";
import { requestParameterTabs } from "../public/http-request-parameter-tabs.js";

test("only active Debug URLencoded uses the text-only panel; legacy file markers stay on the masked path", () => {
  const text = { bodyType: "urlencoded", form: [{ key: "x", type: "text" }] };
  assert(isDebugURLencoded("apis", "debug", "body", text));
  assert(!isDebugURLencoded("apis", "design", "body", text));
  assert(!isDebugURLencoded("apis", "debug", "query", text));
  assert(
    !isDebugURLencoded("apis", "debug", "body", {
      ...text,
      bodyType: "form-data",
    }),
  );
  for (const marker of [
    { type: "file" },
    { requiresFile: true },
    { filename: "legacy" },
  ])
    assert(
      !isDebugURLencoded("apis", "debug", "body", {
        ...text,
        form: [{ ...text.form[0], ...marker }],
      }),
    );
});

test("URLencoded retains literal values, metadata actions and counts only named rows including disabled", () => {
  const form = [
    { key: "profile", description: "<safe note>", value: "sample" },
    { key: "tag", enabled: false, value: "a+b" },
    { key: "" },
  ];
  const model = structuredClone(form);
  const html = debugURLencodedEditor(form, (v) =>
    String(v ?? "")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;"),
  );
  assert.match(html, /data-pair="form:1:value"[^>]*value="a\+b"/);
  assert.match(html, /data-pair-enabled="form:1"\s+aria-label/);
  assert.match(html, /title="&lt;safe note&gt;">&lt;safe note&gt;<\/span>/);
  assert.match(html, /data-define-pair="form:0"/);
  assert.match(html, /id="debug-urlencoded-new-key"/);
  assert.doesNotMatch(html, /data-field-type|type="file"/);
  assert.deepEqual(form, model);
  assert.match(
    requestParameterTabs({ bodyType: "urlencoded", form }, "body"),
    /Body \(2\)</,
  );
  assert.match(
    requestParameterTabs({ bodyType: "urlencoded", form: [] }, "body"),
    /Body</,
  );
});
