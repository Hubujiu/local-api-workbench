import assert from "node:assert/strict";
import test from "node:test";
import {
  httpScriptSnippets,
  httpScriptSnippetWorkspaceHTML,
  scriptSnippetInsertion,
} from "../public/http-script-snippets.js";
import { runScript } from "../src/scripts.mjs";

test("insert after the selection-end line without splitting its token or deleting earlier text", () => {
  const first = 'const greeting = "retained";';
  const sample = first + "\n// bottom";
  const midToken = first.indexOf("retained") + 3;
  const insertion = scriptSnippetInsertion(sample, midToken, "snippet();");
  assert.deepEqual(insertion, {
    start: first.length,
    end: first.length,
    replacement: "\nsnippet();",
  });
  assert.equal(
    sample.slice(0, insertion.start) +
      insertion.replacement +
      sample.slice(insertion.end),
    first + "\nsnippet();\n// bottom",
  );
  assert.deepEqual(scriptSnippetInsertion("", 0, "snippet();"), {
    start: 0,
    end: 0,
    replacement: "snippet();",
  });
  assert.deepEqual(
    scriptSnippetInsertion(first, midToken, "snippet();"),
    insertion,
  );
  assert.equal(
    scriptSnippetInsertion(first + "\r\n// keep", midToken, "snippet();")
      .replacement,
    "\r\nsnippet();",
  );
});

test("catalog is stage scoped, read-only outside request-local state, and uses supported runtime APIs", async () => {
  const before = httpScriptSnippets("before");
  const after = httpScriptSnippets("after");
  assert.equal(before.length, 3);
  assert.deepEqual(after.slice(0, 3), before);
  assert.deepEqual(httpScriptSnippets("design"), []);
  const text = (entries) => entries.map((recipe) => recipe.code).join("\n");
  assert.doesNotMatch(
    text(after),
    /sendRequest|fetch\(|console\.|environment\.(?:set|unset|clear)/,
  );
  const result = await runScript(
    'pm.variables.set("fallbackObserved", pm.variables.get("exampleKey"));\n' +
      text(before) +
      '\npm.variables.set("shadowObserved", pm.variables.get("exampleKey"));',
    { variables: {}, scopes: { environment: { exampleKey: "synthetic" } } },
  );
  assert.equal(result.localVariables.exampleKey, "exampleValue");
  assert.equal(result.localVariables.fallbackObserved, "synthetic");
  assert.equal(result.localVariables.shadowObserved, "exampleValue");
  assert.deepEqual(result.scopes.environment, { exampleKey: "synthetic" });
  for (const status of [200, 201]) {
    const post = await runScript(text(after), {
      variables: {},
      response: { status, body: "{}" },
    });
    assert.deepEqual(
      post.tests.map((record) => [record.name, record.passed]),
      [["状态码为 200", status === 200]],
    );
  }
  assert.match(
    httpScriptSnippetWorkspaceHTML("<textarea></textarea>", "after", true),
    /aria-expanded="false".*id="http-script-snippet-options" hidden/s,
  );
});
