import { renameSharedScriptScopes } from "../public/shared-scripts.js";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  applySharedScripts,
  validateSharedScriptSettings,
} from "../src/shared-scripts.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import { normalizeRequest, snapshotPlan, runPlan } from "../src/core.mjs";
import { versionPlan } from "../src/plan-version.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { snapshotInterfaceForPlan } from "../public/plan-snapshots.js";

test("shared script sources are frozen for debug/cases but never implicitly added to plans", () => {
  const p = {
    settings: {
      globalScripts: { beforeScript: 'console.log("global")' },
      folderScripts: { Orders: { beforeScript: 'console.log("folder")' } },
    },
  };
  const request = normalizeRequest({
    url: "https://example.test",
    folder: "Orders",
    beforeScript: 'console.log("own")',
  });
  const frozen = freezeServiceBinding(p, request);
  assert.deepEqual(
    frozen.sharedBeforeScripts.map((x) => x.name),
    ["project", "folder"],
  );
  assert.equal(frozen.beforeScript, request.beforeScript);
  assert.deepEqual(
    applySharedScripts(p, { ...frozen, inheritSharedScripts: false })
      .sharedBeforeScripts,
    [],
  );
  p.settings.globalScripts.beforeScript = 'throw Error("changed")';
  assert.equal(
    applySharedScripts(p, frozen).sharedBeforeScripts[0].code,
    'console.log("global")',
  );
  assert.deepEqual(
    applySharedScripts(p, { ...request, inheritSharedScripts: false })
      .sharedBeforeScripts,
    [],
  );
  assert.equal(
    applySharedScripts(p, { ...request, folder: "Orders/Child" })
      .sharedBeforeScripts.length,
    1,
  );
  const plan = versionPlan(null, { steps: [{ request }] }, "manual", p);
  assert.deepEqual(plan.steps[0].request.sharedBeforeScripts, []);
  assert.equal(plan.steps[0].request.beforeScript, request.beforeScript);
  const copied = snapshotInterfaceForPlan(frozen);
  assert.equal(copied.beforeScript, "");
  assert.deepEqual(copied.sharedBeforeScripts, []);
});
test("shared callbacks finish in explicit project-folder-interface order and post source is not interpolated", async (t) => {
  let main;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/seed") setTimeout(() => res.end('{"token":"ready"}'), 30);
    else {
      main = req.headers;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const p = {
    settings: {
      globalScripts: {
        beforeScript: `pm.sendRequest('${url}/seed',(err,res)=>{if(err)throw err;apt.setVar('token',res.json().token);apt.setVar('trace','G');});`,
        afterScript:
          'apt.setVar("trace",apt.getVar("trace")+"g");apt.setVar("literal","{{notDefined}}");',
      },
      folderScripts: {
        Orders: {
          beforeScript:
            'apt.setVar("trace",apt.getVar("trace")+"F");apt.setRequestHeader("x-ready",apt.getVar("token"));',
          afterScript: 'apt.setVar("trace",apt.getVar("trace")+"f");',
        },
      },
    },
  };
  const request = freezeServiceBinding(
    p,
    normalizeRequest({
      url: url + "/main",
      folder: "Orders",
      beforeScript: 'apt.setVar("trace",apt.getVar("trace")+"R");',
      afterScript: 'apt.setVar("trace",apt.getVar("trace")+"r");',
    }),
  );
  const result = await runPlan(
    snapshotPlan({ steps: [{ request }] }),
    {},
    executeRequest,
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(main["x-ready"], "ready");
  assert.equal(result.variables.trace, "GFRgfr");
  assert.equal(result.variables.literal, "{{notDefined}}");
  assert.equal(result.results[0].subrequests[0].scope, "project");
});
test("shared script settings reject unknown operations and oversized combined phase before HTTP", () => {
  for (const settings of [
    { globalScripts: null },
    { globalScripts: { beforeScript: [] } },
    { globalScripts: { shell: "bad" } },
    { folderScripts: [] },
    { folderScripts: JSON.parse('{"__proto__":{}}') },
  ])
    assert.throws(() => validateSharedScriptSettings(settings));
  const original = {
    folderScripts: {
      Orders: { beforeScript: "first" },
      Other: { afterScript: "other" },
    },
  };
  const renamed = renameSharedScriptScopes(original, "Orders", "Renamed");
  assert.equal(renamed.Renamed.beforeScript, "first");
  assert(original.folderScripts.Orders);
  assert.throws(
    () => renameSharedScriptScopes(original, "Orders", "Other"),
    /已存在/,
  );
  assert.equal(
    renameSharedScriptScopes(original, "Orders", null).Orders,
    undefined,
  );
  const p = {
    settings: {
      globalScripts: { beforeScript: "x".repeat(60000) },
      folderScripts: { Orders: { beforeScript: "x".repeat(60000) } },
    },
  };
  assert.throws(
    () =>
      freezeServiceBinding(
        p,
        normalizeRequest({ url: "https://example.test", folder: "Orders" }),
      ),
    /100000/,
  );
});
