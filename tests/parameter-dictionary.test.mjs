import test from "node:test";
import assert from "node:assert/strict";
import {
  parseParameterImport,
  previewParameterImport,
} from "../src/parameter-dictionary.mjs";
test("parameter dictionary imports KV, JSON and bounded MySQL column definitions without executing SQL", () => {
  assert.equal(
    parseParameterImport("name: 姓名\nage: 年龄", "kv")[1].key,
    "age",
  );
  assert.equal(
    parseParameterImport('{"name":"姓名"}', "json")[0].description,
    "姓名",
  );
  const ddl =
    "CREATE TABLE users (id BIGINT NOT NULL COMMENT '用户ID', name VARCHAR(50) DEFAULT 'guest' COMMENT '姓名', enabled TINYINT(1) DEFAULT 1, role ENUM('user','admin') DEFAULT 'user', PRIMARY KEY(id));";
  const entries = parseParameterImport(ddl, "mysql");
  assert.equal(entries.length, 4);
  assert.equal(entries[0].type, "integer");
  assert.equal(entries[1].default, "guest");
  assert.equal(entries[2].default, true);
  assert.deepEqual(entries[3].enum, ["user", "admin"]);
  assert.throws(
    () => parseParameterImport("DROP TABLE users", "mysql"),
    /CREATE TABLE/,
  );
});
test("dictionary preview chooses complete source duplicates and flags existing key/type conflicts", () => {
  const preview = previewParameterImport(
    [
      { key: "id", type: "integer" },
      { key: "id", type: "integer", description: "ID", example: 1 },
      { key: "name" },
    ],
    [{ key: "id", type: "integer" }],
  );
  assert.equal(preview.length, 2);
  assert.equal(preview[0].entry.description, "ID");
  assert.equal(preview[0].duplicate, true);
  assert.equal(preview[1].duplicate, false);
});
