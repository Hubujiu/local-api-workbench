import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sdk from "../src/vendor/url-sdk-host.js";
import { trackedQuickJS } from "../src/tracked-quickjs.mjs";
import { runScript } from "../src/scripts.mjs";
const { Url } = sdk;

test("reviewed URL adapter preserves literal syntax and SDK flag/value distinctions", () => {
  for (const raw of [
    "https://example.test",
    "https://example.test/",
    "https://example.test/?",
    "https://example.test/#",
    "https://example.test:/a",
    "http://[::1]:8080/a?x=中文",
    "https://u:p@example.test/a/../b#hash",
    "https://{{host}}/a/{{value?x#y}}?q={{arg&a=b}}",
    "https://example.test/?a=1&&",
  ])
    assert.equal(new Url(raw).toString(), raw);
  const url = new Url("https://example.test/?x=one&x=two&flag&empty=");
  assert.equal(url.query.one("flag").value, null);
  assert.equal(url.query.get("flag"), "");
  assert.equal(url.query.one("empty").value, "");
  assert.deepEqual(url.query.toObject(), {
    x: ["one", "two"],
    flag: "",
    empty: "",
  });
  const last = url.query.one("x");
  last.disabled = true;
  assert.equal(
    url.query.upsert({ key: "x", value: "updated", disabled: false }),
    false,
  );
  assert.equal(url.query.one("x"), last);
  assert.equal(
    last.disabled,
    true,
    "QueryParam.update does not silently adopt Header.update semantics",
  );
  assert.equal(url.toString(), "https://example.test/?x=one&flag&empty=");
});

test("URL path variables preserve suffixes and only substitute truthy string values", () => {
  const url = new Url("http://example.test/:id.json/:other");
  url.variables.upsert({ key: "id", value: "42" });
  url.variables.upsert({ key: "other", value: 0 });
  assert.equal(url.getPath(), "/42.json/:other");
  assert.equal(url.getPath(true), "/:id.json/:other");
  assert.throws(() => url.getRaw(), /Url#getRaw.*discontinued.*Url#toString/);
});

test("URL indexes and object conversion keep prototype-sensitive names as ordinary data", () => {
  const url = new Url("https://example.test/");
  for (const key of ["constructor", "__proto__", "toString"])
    url.query.upsert({ key, value: "safe:" + key });
  const object = url.query.toObject();
  assert.equal(Object.getPrototypeOf(object), Object.prototype);
  for (const key of ["constructor", "__proto__", "toString"]) {
    assert.equal(Object.hasOwn(object, key), true);
    assert.equal(object[key], "safe:" + key);
    url.query.remove(key);
    assert.equal(url.query.get(key), undefined);
  }
  assert.equal(url.query.count(), 0);
});

test("URL adapter assets match a closed reviewed dependency manifest", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../src/vendor/url-sdk-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.versions.lodash, "4.18.1");
  assert.equal(manifest.versions["postman-url-encoder"], "3.0.8");
  for (const output of manifest.outputs) {
    const bytes = await readFile(
      new URL("../src/vendor/" + output.filename, import.meta.url),
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      output.sha256,
    );
    assert.equal(bytes.length, output.bytes);
    assert(
      !output.inputs.some((name) =>
        /faker|node_modules\/(?:uuid|iconv-lite)\//.test(name),
      ),
    );
  }
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert(!pkg.dependencies["postman-collection"]);
  assert(!pkg.devDependencies["postman-collection"]);
});

test("reviewed URL adapter executes in the existing QuickJS limits without host bindings", async () => {
  const tracked = await trackedQuickJS(),
    runtime = tracked.engine.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const source = await readFile(
    new URL("../src/vendor/url-sdk.js", import.meta.url),
    "utf8",
  );
  const context = runtime.newContext(),
    started = Date.now();
  runtime.setInterruptHandler(() => Date.now() - started > 250);
  try {
    const result = context.evalCode(
      source +
        `;(()=>{
      const u=new LocalURLSDK.Url('https://example.test/:id.json?x=one&x=two&flag');
      u.variables.upsert({key:'id',value:'42'});u.query.one('x').disabled=true;
      u.query.upsert({key:'constructor',value:'data'});
      return JSON.stringify({url:u.toString(),flag:u.query.get('flag'),field:u.query.one('flag').value,
        special:u.query.get('constructor'),host:[typeof process,typeof require,typeof fetch]});
    })()`,
    );
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw Error(JSON.stringify(error));
    }
    const output = JSON.parse(context.getString(result.value));
    result.value.dispose();
    assert.deepEqual(output, {
      url: "https://example.test/42.json?x=one&flag&constructor=data",
      flag: "",
      field: null,
      special: "data",
      host: ["undefined", "undefined", "undefined"],
    });
  } finally {
    context.dispose();
    runtime.dispose();
  }
});

test("legacy script entry remains a string and does not expose the new adapter", async () => {
  const result = await runScript(
    'apt.setVar("urlType",typeof pm.request.url);apt.setVar("adapter",typeof LocalURLSDK);',
    { request: { url: "https://example.test" } },
  );
  assert.equal(result.variables.urlType, "string");
  assert.equal(result.variables.adapter, "undefined");
});
