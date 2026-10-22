import test from "node:test";
import assert from "node:assert/strict";
import { inferSchemaFromMySQL } from "../public/schema-inference.js";
import { sampleFromSchema } from "../src/core.mjs";

test("DDL model inference reuses static column types and preserves notes without guessing API requiredness", () => {
  const schema = inferSchemaFromMySQL(
    "CREATE TABLE t (id INT NOT NULL DEFAULT 7 COMMENT 'identifier', name VARCHAR(20) DEFAULT 'demo', enabled TINYINT(1) DEFAULT 1, created DATETIME DEFAULT CURRENT_TIMESTAMP)",
  );
  assert.equal(schema.required, undefined);
  assert.equal(schema.properties.id.default, 7);
  assert.match(schema.properties.id.description, /identifier/);
  assert.match(schema.properties.id.description, /NOT NULL/);
  assert.match(schema.properties.created.description, /默认表达式未求值/);
  assert.equal(schema.properties.created.default, undefined);
  const value = sampleFromSchema(schema);
  assert.equal(value.id, 7);
  assert.equal(value.name, "demo");
  assert.equal(value.enabled, true);
});
test("DDL model enums retain punctuation and incompatible defaults never become invalid examples", () => {
  const schema = inferSchemaFromMySQL(
    "CREATE TABLE t (status ENUM('a)b','c,d') DEFAULT 'c,d', optional VARCHAR(10) DEFAULT NULL)",
  );
  assert.deepEqual(schema.properties.status.enum, ["a)b", "c,d"]);
  assert.equal(schema.properties.optional.default, undefined);
  assert.match(schema.properties.optional.description, /NULL/);
  assert.throws(
    () =>
      inferSchemaFromMySQL(
        "CREATE TABLE t (status ENUM('a','b') DEFAULT 'wrong')",
      ),
    /枚举/,
  );
});
test("DDL model preview rejects ambiguity and unsupported inputs before creating a schema", () => {
  for (const source of [
    "SELECT 1",
    "CREATE TABLE t (id INT); DROP TABLE t",
    "CREATE TABLE t (a INT, A INT)",
    "CREATE TABLE t (`__proto__` INT)",
    "CREATE TABLE t (value BIGINT DEFAULT 9007199254740993)",
    "CREATE TABLE t (PRIMARY KEY(id))",
    "CREATE TABLE t (x INT)" + " ".repeat(65536),
  ])
    assert.throws(() => inferSchemaFromMySQL(source));
});
