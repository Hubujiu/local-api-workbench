import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import {
  productBuild,
  checkedProductVersion,
} from "../public/product-version.js";

test("desktop build label cannot mislabel local fallback or display non-version fields", () => {
  assert.deepEqual(productBuild("0.1.1", "2.4.9"), {
    version: "2.4.9",
    label: "桌面应用版本",
  });
  assert.deepEqual(
    productBuild("0.1.1", { version: "2.4.9", path: "never display" }),
    { version: "0.1.1", label: "本地服务版本" },
  );
  assert.deepEqual(productBuild("/private/path"), {
    version: "",
    label: "本地服务版本",
  });
  assert.equal(checkedProductVersion("1.02.3"), "");
});

test("actual preload uses a fixed no-argument channel and actual main handler validates sender", async () => {
  const read = (name) =>
    readFile(new URL("../desktop/" + name, import.meta.url), "utf8");
  let exposed;
  const invoked = [];
  vm.runInNewContext(await read("preload.cjs"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(key, value) {
            assert.equal(key, "desktop");
            exposed = value;
          },
        },
        ipcRenderer: {
          invoke: (...values) => {
            invoked.push(values);
            return "2.4.9";
          },
        },
      };
    },
  });
  assert.equal(exposed.appVersion("unused"), "2.4.9");
  assert.deepEqual(invoked, [["read-app-version"]]);
  const main = await read("main.mjs");
  const start = main.indexOf('ipcMain.handle("read-app-version"');
  const end = main.indexOf('ipcMain.handle("choose-directory"', start);
  assert(start >= 0 && end > start);
  let callback;
  const trusted = {};
  const reads = [];
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: {
      handle(name, handle) {
        assert.equal(name, "read-app-version");
        callback = handle;
      },
    },
    validateSender(event) {
      if (event !== trusted) throw Error("untrusted");
    },
    app: {
      getVersion() {
        reads.push("version");
        return "2.4.9";
      },
    },
  });
  assert.throws(() => callback({}), /untrusted/);
  assert.deepEqual(reads, []);
  assert.equal(callback(trusted), "2.4.9");
  assert.deepEqual(reads, ["version"]);
});

test("standalone session reports the actual module package version without another endpoint", async () => {
  const folder = await mkdtemp(join(tmpdir(), "product-version-"));
  const app = await createApp({ root: folder, port: 0 });
  try {
    const packageVersion = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
    const open = await fetch(app.url + "/api/session", {
      headers: { "x-local-token": app.token },
    });
    assert.equal(open.status, 200);
    const receipt = await open.json();
    assert.deepEqual(Object.keys(receipt).sort(), [
      "instanceId",
      "token",
      "version",
    ]);
    assert.equal(receipt.version, packageVersion);
    assert.equal((await fetch(app.url + "/api/session")).status, 403);
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});
