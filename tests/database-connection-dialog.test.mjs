import test from "node:test";
import assert from "node:assert/strict";
import { openMySQLConnectionDraft } from "../public/database-connection-dialog.js";
function fixture() {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        value: "",
        checked: false,
        isConnected: true,
        previousElementSibling: {},
        dispatchEvent() {
          this.changes = (this.changes || 0) + 1;
        },
      });
    return nodes.get(id);
  };
  node("#db-type").value = "mysql";
  node("#db-password").value = "inert-original-secret";
  const root = {
    querySelector: (id) =>
      id === "#mysql-connection-dialog" ? null : node(id),
  };
  let dialog;
  globalThis.document = {
    body: { append() {} },
    createElement() {
      const inner = new Map();
      dialog = {
        setAttribute() {},
        addEventListener(_, fn) {
          this.onclose = fn;
        },
        showModal() {},
        close() {
          this.onclose();
        },
        remove() {
          this.removed = true;
        },
        querySelector(id) {
          if (!inner.has(id))
            inner.set(id, {
              value: "",
              checked: false,
              previousElementSibling: {},
            });
          return inner.get(id);
        },
        querySelectorAll() {
          return [...inner.values()];
        },
      };
      return dialog;
    },
  };
  openMySQLConnectionDraft(root);
  return { node, dialog, nodes, root };
}
test("MySQL draft preserves masking, cancels without changing live fields and scrubs detached controls", () => {
  const { node, dialog } = fixture();
  assert.match(dialog.innerHTML, /id="mysql-draft-password" type="password"/);
  assert(!dialog.innerHTML.includes("inert-original-secret"));
  dialog.querySelector("#mysql-draft-password").value = "edited-inert-secret";
  dialog.close();
  assert.equal(node("#db-password").value, "inert-original-secret");
  assert.equal(dialog.querySelector("#mysql-draft-password").value, "");
  assert(dialog.removed);
});
test("apply only fills existing connection controls and retains TLS and CA", () => {
  const { node, dialog } = fixture();
  dialog.querySelector("#mysql-draft-host").value = "inert.invalid";
  dialog.querySelector("#mysql-draft-tls").checked = true;
  dialog.querySelector("#mysql-draft-ca").value = "INERT CA";
  dialog.querySelector("#mysql-draft-apply").onclick();
  assert.equal(node("#db-host").value, "inert.invalid");
  assert(node("#db-tls").checked);
  assert.equal(node("#db-ca").value, "INERT CA");
  assert.equal(node("#db-type").changes, 1);
});
test("a replaced page cannot receive another project's connection draft", () => {
  const { nodes, dialog, node } = fixture();
  nodes.set("#db-type", { value: "postgres", isConnected: true });
  dialog.querySelector("#mysql-draft-host").value = "inert.invalid";
  dialog.querySelector("#mysql-draft-apply").onclick();
  assert.equal(node("#db-type").value, "postgres");
  assert.equal(node("#db-host").value, "");
  assert(dialog.removed);
});
