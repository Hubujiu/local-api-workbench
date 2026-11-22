import assert from "node:assert/strict";
import test from "node:test";
import {
  bindDatabaseManager,
  databaseManagerHTML,
  databaseManagerRows,
} from "../public/database-manager.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function harness() {
  const attributes = new Map();
  const table = { setAttribute: (name, value) => attributes.set(name, value) };
  const classes = new Set();
  const state = {
    textContent: "",
    classList: { add: (x) => classes.add(x), remove: (x) => classes.delete(x) },
  };
  const empty = { hidden: true };
  const body = {
    innerHTML: "",
    replaceChildren() {
      this.innerHTML = "";
    },
  };
  let click,
    owns = true;
  const nodes = {
    ".database-manager-table": table,
    "[data-db-manager-rows]": body,
    "[data-db-manager-status]": state,
    ".database-manager-empty": empty,
    "#db-manager-refresh": {
      addEventListener: (_, cb) => {
        click = cb;
      },
    },
  };
  const root = {
    isConnected: true,
    querySelector: (selector) => nodes[selector],
  };
  const requests = [];
  bindDatabaseManager(root, {
    list: () => {
      const response = deferred();
      requests.push(response);
      return response.promise;
    },
    owns: () => owns,
  });
  return {
    requests,
    root,
    loseOwner() {
      owns = false;
    },
    table,
    attributes,
    state,
    empty,
    body,
    refresh: () => click(),
  };
}
const synthetic = {
  name: "<owned-label>",
  type: "sqlite",
  password: "synthetic-never-rendered",
};
test("database management renders real columns, metadata only, no credential fields or writes", () => {
  assert.match(databaseManagerHTML(), /<th scope="col">数据库类型<\/th>/);
  assert.match(databaseManagerHTML(), /data-page="database">配置连接/);
  const rows = databaseManagerRows([synthetic]);
  assert.match(rows, /&lt;owned-label&gt;.*SQLite.*本项目.*应用运行期间/);
  assert.doesNotMatch(rows, /password|synthetic-never-rendered/);
  assert.throws(
    () => databaseManagerRows([{ ...synthetic, expiresAt: Infinity }]),
    /列表无效/,
  );
  assert.throws(
    () => databaseManagerRows([{ ...synthetic, type: "not-backed" }]),
    /列表无效/,
  );
});
test("list resolves genuine empty, handles errors safely, and ignores old reads of same owner", async () => {
  const h = harness();
  assert.equal(h.attributes.get("aria-busy"), "true");
  assert.equal(h.empty.hidden, true);
  h.refresh();
  h.requests[1].resolve([]);
  await h.requests[1].promise;
  assert.equal(h.attributes.get("aria-busy"), "false");
  assert.equal(h.empty.hidden, false);
  h.requests[0].resolve([synthetic]);
  await h.requests[0].promise;
  assert.equal(h.body.innerHTML, "");
  assert.equal(h.empty.hidden, false);
  h.refresh();
  h.requests[2].reject(Error("host returned private data"));
  await h.requests[2].promise.catch(() => {});
  assert.equal(h.empty.hidden, true);
  assert.equal(h.attributes.get("aria-busy"), "false");
  assert.equal(h.state.textContent, "无法读取会话授权，请重试。");
});
for (const reason of ["detach", "owner"]) {
  test(reason + " prevents late protected list adoption", async () => {
    const h = harness();
    if (reason === "detach") h.root.isConnected = false;
    else h.loseOwner();
    h.requests[0].resolve([synthetic]);
    await h.requests[0].promise;
    assert.equal(h.body.innerHTML, "");
    assert.equal(h.empty.hidden, true);
  });
}
