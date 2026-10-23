import test from "node:test";
import assert from "node:assert/strict";
import sdk from "../src/vendor/url-sdk-host.js";
import {
  initializeQueryRuntime,
  renderQueryRuntime,
} from "../src/script-url-runtime.mjs";
import { installURLFacade } from "../src/script-url-facade.mjs";
const setup = (request = { url: "https://example.test/?x=1&x=2" }) => {
  const pm = { request: {} },
    apt = {};
  const read = installURLFacade({
    pm,
    apt,
    initial: initializeQueryRuntime(request),
  });
  return { pm, apt, read };
};
test("facade routes all query helpers through the same live SDK URL", () => {
  const { pm, apt, read } = setup();
  const member = pm.request.url.query.one("x");
  pm.setRequestQuery("x", null);
  assert.equal(member.value, "null");
  assert.equal(pm.request.url.query.count(), 2);
  assert.equal(apt.request, pm.request);
  pm.request.addQueryParams("flag&encoded=%2f+");
  assert.equal(pm.request.url.query.one("flag").value, null);
  assert.equal(pm.request.url.query.get("encoded"), "%2f+");
  pm.request.removeQueryParams("x");
  assert.equal(
    renderQueryRuntime(read()),
    "https://example.test/?flag&encoded=%2f+",
  );
});
test("replacement detaches old references and rejected assignments leave the live URL untouched", () => {
  const { pm, read } = setup({
    url: "https://example.test/?raw=1",
    query: [{ key: "table", value: "a+b" }],
  });
  const old = pm.request.url;
  pm.request.url = "https://replacement.test/?new=1";
  old.query.add({ key: "stale", value: "never" });
  assert.equal(renderQueryRuntime(read()), "https://replacement.test/?new=1");
  for (const bad of [
    null,
    42,
    {},
    new sdk.Url({ host: ["example"], query: [{ key: "x", value: () => 1 }] }),
  ]) {
    assert.throws(() => {
      pm.request.url = bad;
    });
    assert.equal(renderQueryRuntime(read()), "https://replacement.test/?new=1");
  }
  pm.request.url = old;
  assert.equal(pm.request.url, old);
  assert.equal(
    renderQueryRuntime(read()),
    "https://example.test/?raw=1&table=a%2Bb&stale=never",
  );
});
test("SDK URL update replaces members without inheriting stale table encoding or dynamic metadata", () => {
  const { pm, read } = setup({
    url: "https://example.test",
    query: [
      {
        key: "x",
        value: "a+b",
        dynamic: { source: "fixed", value: "obsolete" },
      },
    ],
  });
  const old = pm.request.url.query.one("x");
  pm.request.url.update("https://example.test/?x=raw+");
  old.value = "obsolete";
  assert.deepEqual(read().origins, [{ encoding: "raw" }]);
  assert.equal(renderQueryRuntime(read()), "https://example.test/?x=raw+");
});
