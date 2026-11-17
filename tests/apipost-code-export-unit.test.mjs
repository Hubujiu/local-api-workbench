import test from "node:test";
import assert from "node:assert/strict";
import {
  exportApipostCodes,
  verifyApipostCodeDefinitions,
} from "../src/apipost-code-export.mjs";
import { mergeApipostCodes } from "../src/apipost-codes.mjs";
import { validateErrorCodes } from "../src/error-codes.mjs";

test("native code rows preserve wire types, spelling and order without minting identity or enabling hints", () => {
  const input = [
    {
      code: "0007",
      label: "leading zero",
      apipostSource: { projectId: "old", codeId: "source" },
    },
    { code: 409, label: "业务冲突", httpHint: false },
    { code: "ERR", label: "A" },
    { code: "err", label: "B" },
    { code: 0, label: "zero" },
    { code: Number.MAX_SAFE_INTEGER, label: "largest" },
    { code: Number.MIN_SAFE_INTEGER, label: "smallest" },
    { code: "\ud800", label: "\ud801" },
    { code: "\ud801", label: '界\n"\\' },
  ];
  const before = structuredClone(input);
  const wire = JSON.parse(JSON.stringify(exportApipostCodes(input)));
  assert.deepEqual(
    wire,
    input.map(({ code, label }) => ({ code_number: code, code_msg: label })),
  );
  assert.ok(
    wire.every(
      (row) => Object.keys(row).sort().join(",") === "code_msg,code_number",
    ),
  );
  const readback = mergeApipostCodes(wire);
  verifyApipostCodeDefinitions(input, readback);
  assert.ok(
    readback.every(
      (row) => row.httpHint !== true && !Object.hasOwn(row, "apipostSource"),
    ),
  );
  assert.deepEqual(input, before);
});

test("code export refuses nonrepresentable hints and negative zero before JSON can erase the distinction", () => {
  const zero = [{ code: -0, label: "negative zero" }];
  assert.equal(validateErrorCodes(zero), zero);
  assert.equal(Object.is(JSON.parse(JSON.stringify(zero))[0].code, -0), false);
  assert.throws(() => exportApipostCodes(zero), /负零/);
  assert.equal(Object.is(zero[0].code, -0), true);
  assert.throws(
    () =>
      exportApipostCodes([{ code: 409, label: "Conflict", httpHint: true }]),
    /HTTP提示/,
  );
  for (const httpHint of [undefined, false])
    assert.deepEqual(
      exportApipostCodes([{ code: 409, label: "Conflict", httpHint }]),
      [{ code_number: 409, code_msg: "Conflict" }],
    );
  for (const httpHint of [0, "false", null])
    assert.throws(() =>
      exportApipostCodes([{ code: 409, label: "Conflict", httpHint }]),
    );
});

test("code export retains existing canonical identity and text validation", () => {
  for (const rows of [
    [
      { code: 200, label: "first" },
      { code: "200", label: "second" },
    ],
    [
      { code: "x", label: "same" },
      { code: "x", label: "same" },
    ],
    [{ code: Number.MAX_SAFE_INTEGER + 1, label: "unsafe" }],
    [{ code: 1.1, label: "fraction" }],
    [{ code: Infinity, label: "infinite" }],
    [{ code: NaN, label: "not a number" }],
    [{ code: 1n, label: "bigint" }],
    [{ code: "", label: "empty" }],
    [{ code: "white space", label: "space" }],
    [{ code: "x:y", label: "colon" }],
    [{ code: "x：y", label: "wide colon" }],
    [{ code: "x\u007f", label: "control" }],
    [{ code: "x", label: "" }],
    [{ code: "x", label: " \n " }],
    [{ code: "x" }],
  ])
    assert.throws(() => exportApipostCodes(rows));
});

test("full code rows and provenance are checked before projecting fields", () => {
  const malformed = [
    { code: "x", label: "value", extra: true },
    { code: "x", label: "value", apipostSource: {} },
    {
      code: "x",
      label: "value",
      apipostSource: { projectId: "old", extra: true },
    },
    { code: "x", label: "value", apipostSource: { projectId: 1 } },
    { code: "x", label: "value", apipostSource: { projectId: " " } },
    {
      code: "x",
      label: "value",
      apipostSource: { projectId: "p".repeat(201) },
    },
    {
      code: "x",
      label: "value",
      apipostSource: { projectId: "old", codeId: " " },
    },
    {
      code: "x",
      label: "value",
      apipostSource: { projectId: "old", codeId: "i".repeat(201) },
    },
    { code: "x", label: "value", apipostSource: [] },
    Object.assign(Object.create({ inherited: true }), {
      code: "x",
      label: "value",
    }),
    Object.assign({ code: "x", label: "value" }, { [Symbol("unknown")]: true }),
  ];
  for (const row of malformed) assert.throws(() => exportApipostCodes([row]));
  const row = { code: "x", label: "value" };
  Object.defineProperty(row, "hidden", { value: true });
  assert.throws(() => exportApipostCodes([row]));
  const source = Object.assign(Object.create(null), {
    projectId: "old",
    codeId: "__proto__",
  });
  const plain = Object.assign(Object.create(null), {
    code: "x",
    label: "value",
    apipostSource: source,
  });
  assert.deepEqual(exportApipostCodes([plain]), [
    { code_number: "x", code_msg: "value" },
  ]);
});

test("code arrays and nested definitions reject accessors and proxies with no execution", () => {
  for (const position of [
    "array",
    "code",
    "label",
    "httpHint",
    "apipostSource",
    "origin",
  ]) {
    let calls = 0;
    const rows = [
      { code: "x", label: "value", apipostSource: { projectId: "old" } },
    ];
    const target =
      position === "array"
        ? rows
        : position === "origin"
          ? rows[0].apipostSource
          : rows[0];
    const key =
      position === "array"
        ? "0"
        : position === "origin"
          ? "projectId"
          : position;
    Object.defineProperty(target, key, {
      enumerable: true,
      get() {
        calls++;
        return "value";
      },
    });
    assert.throws(() => exportApipostCodes(rows));
    assert.equal(calls, 0, position);
  }
  for (const position of ["array", "row", "origin"]) {
    let traps = 0;
    const trap = () => {
      traps++;
      throw Error("must not run proxy trap");
    };
    const rows = [
      { code: "x", label: "value", apipostSource: { projectId: "old" } },
    ];
    const value =
      position === "array"
        ? rows
        : position === "row"
          ? rows[0]
          : rows[0].apipostSource;
    const proxy = new Proxy(value, {
      get: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
    if (position === "row") rows[0] = proxy;
    if (position === "origin") rows[0].apipostSource = proxy;
    assert.throws(() =>
      exportApipostCodes(position === "array" ? proxy : rows),
    );
    assert.equal(traps, 0, position);
  }
  for (const rows of [
    null,
    {},
    false,
    "",
    Array(1),
    Object.assign([], { extra: true }),
    Object.setPrototypeOf([], null),
  ])
    assert.throws(() => exportApipostCodes(rows));
  assert.deepEqual(exportApipostCodes(), []);
  assert.deepEqual(exportApipostCodes([]), []);
});

test("code export preserves existing count and text limits without a new one-MiB aggregate cap", () => {
  const rows = Array.from({ length: 2000 }, (_, index) => ({
    code: `c${index}`,
    label: "v".repeat(600),
  }));
  const output = exportApipostCodes(rows);
  assert.equal(output.length, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024);
  assert.throws(() =>
    exportApipostCodes([...rows, { code: "extra", label: "extra" }]),
  );
  assert.equal(
    exportApipostCodes([{ code: "c".repeat(128), label: "v".repeat(2000) }])
      .length,
    1,
  );
  assert.throws(() =>
    exportApipostCodes([{ code: "c".repeat(129), label: "v" }]),
  );
  assert.throws(() =>
    exportApipostCodes([{ code: "c", label: "v".repeat(2001) }]),
  );
});

test("semantic verification rejects changed types, order, omissions and unsupported metadata", () => {
  const rows = [
    { code: 409, label: "Conflict" },
    { code: "0007", label: "Spelling" },
  ];
  for (const changed of [
    [{ code: "409", label: "Conflict" }, rows[1]],
    [...rows].reverse(),
    rows.slice(1),
    [rows[0], { ...rows[1], label: "changed" }],
    [rows[0], { ...rows[1], unknown: true }],
    [rows[0], { ...rows[1], httpHint: true }],
  ])
    assert.throws(() => verifyApipostCodeDefinitions(rows, changed));
});
