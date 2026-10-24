import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseLoadCSV } from "../public/load-data.js";
import { runLoad } from "../src/load-runner.mjs";

test("CSV data supports BOM, quoted commas, doubled quotes and multiline strings", () => {
  assert.deepEqual(
    parseLoadCSV('\ufeffid,note\r\n1,"a,b"\r\n2,"a""b\nc"\r\n'),
    [
      { id: "1", note: "a,b" },
      { id: "2", note: 'a"b\nc' },
    ],
  );
  assert.deepEqual(parseLoadCSV(""), []);
  assert.deepEqual(parseLoadCSV("id,note\n1,"), [{ id: "1", note: "" }]);
});
test("CSV rejects invalid shape, ambiguous syntax, dangerous keys and oversized input", () => {
  for (const text of [
    "id,id\n1,2",
    "__proto__\nx",
    "constructor\nx",
    "id\n1,2",
    'id\n"unterminated',
    'id\n"x"oops',
    'id\nx"x',
    "id",
    "id,\n1,2",
  ])
    assert.throws(() => parseLoadCSV(text));
  assert.throws(() => parseLoadCSV("id\n" + "中".repeat(22000)), /64/);
  assert.throws(
    () => parseLoadCSV("id\n" + Array(101).fill("1").join("\n")),
    /100/,
  );
  assert.throws(
    () =>
      parseLoadCSV(
        Array.from({ length: 51 }, (_, i) => "c" + i).join(",") +
          "\n" +
          Array(51).fill("1").join(","),
      ),
    /50/,
  );
});
test("load data cycles by iteration, stays isolated, and invalid data sends no HTTP", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const project = {
    id: "data",
    environments: [{ id: "e", variables: { id: "saved" } }],
    globalVariables: {},
    settings: {},
  };
  const url = "http://127.0.0.1:" + server.address().port;
  const result = await runLoad(
    project,
    {
      url: url + "/{{id}}",
      beforeScript:
        'apt.setVar("n",(apt.getVar("n")||0)+1);pm.test("isolated",()=>pm.expect(apt.getVar("n")).to.equal(1));',
    },
    { count: 5, concurrency: 2, dataCSV: "id\nfirst\nsecond" },
  );
  assert.equal(result.passed, 5, JSON.stringify(result));
  assert.deepEqual(
    result.results.map((r) => r.dataRow),
    [1, 2, 1, 2, 1],
  );
  assert.equal(seen.filter((x) => x === "/first").length, 3);
  assert.equal(seen.filter((x) => x === "/second").length, 2);
  assert.equal(project.environments[0].variables.id, "saved");
  const before = seen.length;
  await assert.rejects(runLoad(project, { url }, { dataCSV: "bad,bad\n1,2" }));
  assert.equal(seen.length, before);
});
