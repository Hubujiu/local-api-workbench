import test from "node:test";
import assert from "node:assert/strict";
import { mongoPortInput, mysqlPortInput } from "../public/mysql-port-input.js";

test("MongoDB raw UI port spelling rejects before Number erases it", () => {
  for (const raw of [
    "2.7017e4",
    "0x6989",
    "+27017",
    "27017.0",
    "27017.5",
    "-1",
    "-0",
    "abc",
    "Infinity",
    "NaN",
    "65536",
    "１２",
    "27 017",
    "1\u0000",
    "9".repeat(400),
  ])
    assert.throws(
      () => mongoPortInput(raw),
      (error) =>
        error.message ===
        "MongoDB端口须为十进制整数0至65535；留空或0使用默认端口",
    );
});

test("MongoDB and MySQL wrappers share decimal/default conversion without changing MySQL text", () => {
  for (const [raw, expected] of [
    ["", 0],
    [" \t\n", 0],
    ["0", 0],
    ["000", 0],
    [" 0 ", 0],
    ["1", 1],
    ["27017", 27017],
    ["027017", 27017],
    [" 27017 ", 27017],
    ["65535", 65535],
  ]) {
    assert.equal(mongoPortInput(raw), expected);
    assert.equal(mysqlPortInput(raw), expected);
  }
  assert.throws(
    () => mysqlPortInput("abc"),
    (error) =>
      error.message === "MySQL端口须为十进制整数0至65535；留空或0使用默认端口",
  );
});
