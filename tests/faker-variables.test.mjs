import test from "node:test";
import assert from "node:assert/strict";
import { interpolate } from "../src/core.mjs";
import { runScript } from "../src/scripts.mjs";
test("locale-backed names addresses commerce and dates resolve as bounded test data", () => {
  for (const name of [
    "$randomFirstName",
    "$randomLastName",
    "$randomFullName",
    "$randomJobTitle",
    "$randomCity",
    "$randomStreetAddress",
    "$randomCountry",
    "$randomEmail",
    "$randomCompanyName",
    "$randomDatabaseColumn",
    "$randomProductName",
    "$randomParagraph",
  ]) {
    const value = interpolate("{{" + name + "}}");
    assert.equal(typeof value, "string");
    assert(value.length > 0 && Buffer.byteLength(value) < 65536);
  }
  assert.match(interpolate("{{$randomCountryCode}}"), /^[A-Z]{2}$/);
  assert.match(interpolate("{{$randomCurrencyCode}}"), /^[A-Z]{3}$/);
  assert.match(interpolate("{{$randomBankAccount}}"), /^\d{8}$/);
  const now = Date.now();
  assert(Date.parse(interpolate("{{$randomDateFuture}}")) > now);
  assert(Date.parse(interpolate("{{$randomDatePast}}")) < now);
  assert.equal(
    interpolate("{{$randomFirstName}}", { $randomFirstName: "override" }),
    "override",
  );
});
test("sandbox can request locale-backed values but cannot load Faker or arbitrary modules", async () => {
  const result = await runScript(
    "apt.setVar('name',apt.variables.replaceIn('{{$randomFullName}}'));apt.setVar('email',pm.variables.replaceIn('{{$randomEmail}}'));apt.setVar('hidden',typeof __fakerVariable);",
    { variables: {} },
  );
  assert(result.variables.name);
  assert.match(result.variables.email, /@/);
  assert.equal(result.variables.hidden, "undefined");
  await assert.rejects(
    runScript("require('@faker-js/faker')", { variables: {} }),
    /不允许/,
  );
  await assert.rejects(
    runScript("pm.variables.replaceIn('{{$randomNotInCatalogue}}')", {
      variables: {},
    }),
    /未定义/,
  );
});

test("every advertised locale-backed alias returns bounded data without module path traversal", async () => {
  const { fakerVariableNames, fakerVariable } = await import(
    "../src/faker-variables.mjs"
  );
  assert(fakerVariableNames.length >= 60);
  for (const name of fakerVariableNames) {
    const value = fakerVariable(name);
    assert(["string", "number", "boolean"].includes(typeof value), name);
    assert(Buffer.byteLength(String(value)) <= 65536, name);
  }
  for (const name of [
    "__proto__",
    "constructor",
    "$random.constructor",
    "../../fs",
  ])
    assert.equal(fakerVariable(name), undefined);
});

test("browser builtin catalogue exactly matches runtime supported names", async () => {
  const runtime = await import("../src/builtin-variables.mjs");
  const browser = await import("../public/builtin-variable-catalog.js");
  assert.deepEqual(browser.builtinVariableNames, runtime.builtinVariableNames);
  assert.equal(
    new Set(browser.builtinVariableNames).size,
    browser.builtinVariableNames.length,
  );
});
