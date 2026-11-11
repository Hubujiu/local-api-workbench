import test from "node:test";
import assert from "node:assert/strict";
import { mysqlPortInput } from "../public/mysql-port-input.js";

test("MySQL UI validates raw decimal spelling before number coercion", () => {
  for (const raw of [
    "3.306e3",
    "0xcea",
    "+3306",
    "3306.0",
    "3306.1",
    "-1",
    "abc",
    "Infinity",
    "NaN",
    "65536",
    "１２",
    "3 306",
    "1\u0000",
  ])
    assert.throws(
      () => mysqlPortInput(raw),
      (error) => {
        assert.equal(
          error.message,
          "MySQL端口须为十进制整数0至65535；留空或0使用默认端口",
        );
        return true;
      },
    );
});

test("MySQL UI preserves blank, zero, whitespace and decimal compatibility", () => {
  for (const [raw, port] of [
    ["", 0],
    [" \t\n", 0],
    ["0", 0],
    ["000", 0],
    [" 0 ", 0],
    ["1", 1],
    ["3306", 3306],
    ["03306", 3306],
    [" 3306 ", 3306],
    ["65535", 65535],
  ])
    assert.equal(mysqlPortInput(raw), port);
});
