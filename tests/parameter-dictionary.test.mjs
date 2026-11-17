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

test("body helper inserts typed dictionary fields without overwriting or prototype mutation", async () => {
  const { insertDictionaryField } = await import(
    "../public/dictionary-view.js"
  );
  assert.deepEqual(
    JSON.parse(
      insertDictionaryField('{"kept":true}', {
        key: "page",
        type: "integer",
        default: 2,
      }),
    ),
    { kept: true, page: 2 },
  );
  assert.equal(
    JSON.parse(
      insertDictionaryField("", {
        key: "enabled",
        type: "boolean",
        default: false,
      }),
    ).enabled,
    false,
  );
  assert.throws(
    () => insertDictionaryField('{"page":4}', { key: "page" }),
    /未覆盖/,
  );
  assert.throws(() => insertDictionaryField("[]", { key: "x" }), /JSON 对象/);
  assert.throws(() => insertDictionaryField("{", { key: "x" }), /修正/);
  const special = JSON.parse(
    insertDictionaryField("{}", {
      key: "__proto__",
      type: "object",
      example: { polluted: true },
    }),
  );
  assert.equal(Object.hasOwn(special, "__proto__"), true);
  assert.equal({}.polluted, undefined);
});

test("explicit null dictionary defaults and enums are preserved rather than replaced by examples", async () => {
  const { dictionaryValue, insertDictionaryField } = await import(
    "../public/dictionary-view.js"
  );
  assert.equal(
    dictionaryValue({ type: "string", default: null, example: "wrong" }),
    null,
  );
  assert.equal(
    dictionaryValue({ type: "string", enum: [null, "value"] }),
    null,
  );
  assert.deepEqual(
    JSON.parse(
      insertDictionaryField("{}", {
        key: "nullable",
        type: "string",
        default: null,
      }),
    ),
    { nullable: null },
  );
});

test("DDL literals do not become attributes and enum parentheses stay inside strings", () => {
  const entries = parseParameterImport(
    "CREATE TABLE t (label VARCHAR(40) COMMENT 'NOT NULL DEFAULT 7', choice ENUM('a)b','x,y','it''s') DEFAULT 'a)b', amount DOUBLE DEFAULT -1.25e+3);",
    "mysql",
  );
  assert.equal(entries[0].required, false);
  assert.equal(Object.hasOwn(entries[0], "default"), false);
  assert.equal(entries[0].description, "NOT NULL DEFAULT 7");
  assert.deepEqual(entries[1].enum, ["a)b", "x,y", "it's"]);
  assert.equal(entries[1].default, "a)b");
  assert.equal(entries[2].default, -1250);
});

test("DDL comments, unsafe integer defaults and unevaluated expressions are explicit", () => {
  const entries = parseParameterImport(
    "CREATE TABLE t (a INT /* NOT NULL DEFAULT 9 */, stamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP(6), n INT DEFAULT TRUE, text VARCHAR(20) DEFAULT 'a\\nb');",
    "mysql",
  );
  assert.equal(entries[0].required, false);
  assert.equal(Object.hasOwn(entries[0], "default"), false);
  assert.equal(Object.hasOwn(entries[1], "default"), false);
  assert.match(entries[1].note, /CURRENT_TIMESTAMP/);
  assert.equal(entries[2].default, 1);
  assert.equal(entries[3].default, "a\nb");
  assert.throws(
    () =>
      parseParameterImport(
        "CREATE TABLE t (id BIGINT DEFAULT 9007199254740993);",
        "mysql",
      ),
    /精度/,
  );
  assert.throws(
    () =>
      parseParameterImport("CREATE TABLE t (a INT); DROP TABLE t;", "mysql"),
    /单条/,
  );
});

test("DDL handles quoted identifiers and comments without accepting executable or unbounded input", () => {
  const entries = parseParameterImport(
    "/* header */ CREATE TABLE `db`.`t` (`odd``name` VARCHAR(20) DEFAULT 'a' 'b', `PRIMARY` INT NOT NULL, e ENUM('x;--','a\\%b')) ENGINE=InnoDB COMMENT='DROP TABLE t;';",
    "mysql",
  );
  assert.equal(entries[0].key, "odd`name");
  assert.equal(entries[0].default, "ab");
  assert.equal(entries[1].key, "PRIMARY");
  assert.equal(entries[1].required, true);
  assert.deepEqual(entries[2].enum, ["x;--", "a\\%b"]);
  for (const ddl of [
    "CREATE TABLE t(a INT; DROP TABLE x)",
    "CREATE TABLE t(a INT) /*! engine=foo */",
    "CREATE TABLE t(a ENUM('unclosed))",
    "CREATE TABLE t(a INT) /* unfinished",
  ])
    assert.throws(() => parseParameterImport(ddl, "mysql"));
  assert.throws(
    () =>
      parseParameterImport(
        "CREATE TABLE t(a INT DEFAULT " +
          "(".repeat(33) +
          "1" +
          ")".repeat(33) +
          ")",
        "mysql",
      ),
    /32层/,
  );
});

test("DDL adjacent comment literals are preserved and missing DEFAULT values are rejected", () => {
  const [entry] = parseParameterImport(
    "CREATE TABLE t(a VARCHAR(20) COMMENT 'one' 'two')",
    "mysql",
  );
  assert.equal(entry.description, "onetwo");
  assert.throws(
    () =>
      parseParameterImport(
        "CREATE TABLE t(a INT DEFAULT COMMENT 'x')",
        "mysql",
      ),
    /DEFAULT缺少值/,
  );
});
