import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { quickJSURIRegex } from "../scripts/quickjs-uri-regex.mjs";
import { trackedQuickJS } from "../src/tracked-quickjs.mjs";

const names = new Set([
  "isUnreserved",
  "isPathCharacter",
  "isQueryFragmentCharacter",
  "isUserinfoCharacter",
  "isIPvFuture",
  "isZoneCharacter",
  "nonSimpleDomain",
  "URN_REG",
]);
function expressions(source) {
  return source.split("\n").flatMap((line) => {
    const name = line.match(/^\s*(?:const|var|let) (\w+) =/)?.[1];
    if (!names.has(name)) return [];
    const first = line.indexOf("/"),
      last = line.lastIndexOf("/");
    const flags = line.slice(last + 1).match(/^[a-z]*/)[0];
    return [
      { name, line, regex: new RegExp(line.slice(first + 1, last), flags) },
    ];
  });
}

test("pinned URI regex adaptation preserves all BMP characters and contextual URI matches", async () => {
  const source = (
    await Promise.all(
      ["utils.js", "schemes.js"].map((name) =>
        readFile(
          new URL("../node_modules/fast-uri/lib/" + name, import.meta.url),
          "utf8",
        ),
      ),
    )
  ).join("\n");
  const adapted = quickJSURIRegex(source),
    before = expressions(source),
    after = expressions(adapted);
  assert.equal(before.length, 8);
  assert.deepEqual(
    after.map((item) => item.name),
    before.map((item) => item.name),
  );
  for (let i = 0; i < before.length; i++) {
    for (let point = 0; point <= 65535; point++) {
      const char = String.fromCodePoint(point);
      const values =
        before[i].name === "URN_REG"
          ? [`a${char}:body`, `scheme:${char}`]
          : before[i].name === "isIPvFuture"
            ? [`v1.${char}`]
            : [char];
      for (const value of values)
        assert.equal(
          after[i].regex.test(value),
          before[i].regex.test(value),
          `${before[i].name} U+${point.toString(16)}`,
        );
    }
  }
  const samples = [
    "-",
    "_",
    "~",
    "a",
    "9",
    "K",
    "雪",
    "🙂",
    "%",
    "/",
    "?",
    "v1.a-b",
    "urn-test:alpha-beta",
    "a:b",
    "a b",
  ];
  const expected = before.map(({ regex }) =>
    samples.map((value) => regex.test(value)),
  );
  const { engine } = await trackedQuickJS(),
    runtime = engine.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 250;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const code =
      after.map(({ line }) => line).join(";\n") +
      ";JSON.stringify([" +
      after
        .map(
          ({ name }) =>
            `${JSON.stringify(samples)}.map(value=>${name === "URN_REG" ? name + ".test(value)" : name + "(value)"})`,
        )
        .join(",") +
      "])";
    const result = context.evalCode(code);
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw Error(JSON.stringify(error));
    }
    const actual = JSON.parse(context.getString(result.value));
    result.value.dispose();
    assert.deepEqual(actual, expected);
  } finally {
    context.dispose();
    runtime.dispose();
  }
  assert.throws(
    () => quickJSURIRegex("const changed = /x/;"),
    /Pinned fast-uri/,
  );
});
