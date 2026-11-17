import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDatabaseParameterJSON as parse } from "../public/database-parameter-json.js";
import { mutateSQLite, querySQLite } from "../src/database.mjs";

test("database parameter parser rejects nonfinite and unsafe numbers at every nesting position", () => {
  for (const number of [
    "1e400",
    "-1e400",
    "9007199254740993",
    "-9007199254740993",
  ])
    for (const source of [
      number,
      `[null,${number}]`,
      `{"named":[{"value":${number}}]}`,
    ])
      assert.throws(
        () => parse(source),
        (error) => {
          assert.match(error.message, /数字须有限且整数须安全/);
          assert.equal(error.message.includes(number), false);
          return true;
        },
      );
});

test("database parameter parser preserves valid JSON and documents decimal limits", () => {
  const source =
    '[null,true,false,"1e400","9007199254740993",1.25,9007199254740991,{"x":[-2.5]}]';
  assert.deepEqual(parse(source), JSON.parse(source));
  assert.deepEqual(parse("[1e-400,0.10000000000000001]"), [0, 0.1]);
  assert.throws(() => parse("[Infinity]"), SyntaxError);
});

test("UI serialization cannot silently turn rejected numbers into persisted SQLite NULL", () => {
  const root = mkdtempSync(path.join(tmpdir(), "database-ui-number-"));
  try {
    const filename = path.join(root, "fixture.db");
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE entries(value)");
    db.close();
    let sends = 0;
    const send = (source) => {
      const parameters = parse(source);
      sends++;
      return mutateSQLite(
        filename,
        "INSERT INTO entries(value) VALUES (?)",
        JSON.parse(JSON.stringify({ parameters })).parameters,
      );
    };
    for (const source of ["[1e400]", "[-1e400]", "[9007199254740993]"])
      assert.throws(() => send(source), /数字须有限/);
    assert.equal(sends, 0);
    assert.deepEqual(
      querySQLite(filename, "SELECT value FROM entries").rows,
      [],
    );
    for (const source of ["[null]", '["1e400"]', "[1.25]"])
      assert.equal(send(source).committed, true);
    assert.deepEqual(querySQLite(filename, "SELECT value FROM entries").rows, [
      { value: null },
      { value: "1e400" },
      { value: 1.25 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
