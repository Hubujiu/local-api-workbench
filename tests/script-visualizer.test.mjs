import test from "node:test";
import assert from "node:assert/strict";
import { runScript, runScriptSequence } from "../src/scripts.mjs";
const input = {
  variables: {},
  response: { body: '{"rows":[{"name":"A < B"},{"name":"C"}]}' },
};
test("response visualizer renders Handlebars in QuickJS and carries the last shared-stage result", async () => {
  const result = await runScript(
    `apt.visualizer.set('<table>{{#each rows}}<tr><td>{{@index}}</td><td>{{name}}</td></tr>{{/each}}</table>', pm.response.json());`,
    input,
  );
  assert.equal(
    result.visualization,
    "<table><tr><td>0</td><td>A &lt; B</td></tr><tr><td>1</td><td>C</td></tr></table>",
  );
  const sequence = await runScriptSequence(
    [
      {
        name: "parent",
        code: 'pm.visualizer.set("<p>{{name}}</p>", {name:"parent"});',
      },
      { name: "child", code: 'apt.test("ok",()=>{});' },
    ],
    input,
  );
  assert.equal(sequence.visualization, "<p>parent</p>");
  const cleared = await runScriptSequence(
    [
      { name: "parent", code: 'pm.visualizer.set("<p>parent</p>", {});' },
      { name: "child", code: "apt.visualizer.clear();" },
    ],
    input,
  );
  assert.equal(cleared.visualization, null);
});
test("visualizer rejects ASTs, pre-request use and oversized input without exposing host execution", async () => {
  await assert.rejects(
    runScript('apt.visualizer.set({type:"Program", body:[]}, {});', input),
    /字符串|AST/,
  );
  await assert.rejects(
    runScript('apt.visualizer.set("x", {});', { variables: {} }),
    /后置/,
  );
  await assert.rejects(
    runScript('apt.visualizer.set("中".repeat(22000), {});', input),
    /大小/,
  );
  await assert.rejects(
    runScript('apt.visualizer.set("{{v}}", {v:"中".repeat(90000)});', input),
    /大小/,
  );
  await assert.rejects(
    runScript('apt.visualizer.set("{{constructor.constructor}}", {});', input),
  );
});

test("capitalized Visualizing alias reuses the isolated visualizer in both dialects", async () => {
  for (const scriptDialect of ["legacy", "apipost8"]) {
    const result = await runScript(
      `
      if(pm.Visualizing!==pm.visualizer.set || apt.Visualizing!==pm.Visualizing)throw Error('alias mismatch');
      pm.Visualizing('<p>{{v}}</p>', {v:'first'});
      apt.Visualizing('<p>{{v}}</p>', {v:'<script>literal</script>'});
    `,
      { ...input, request: { scriptDialect } },
    );
    assert.equal(
      result.visualization,
      "<p>&lt;script&gt;literal&lt;/script&gt;</p>",
    );
    await assert.rejects(
      runScript("pm.Visualizing('x',{})", {
        variables: {},
        request: { scriptDialect },
      }),
      /后置/,
    );
    await assert.rejects(
      runScript("apt.Visualizing('中'.repeat(22000),{})", {
        ...input,
        request: { scriptDialect },
      }),
      /大小/,
    );
  }
});
